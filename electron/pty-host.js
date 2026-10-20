// Owns every PTY. Output is coalesced per tick into one IPC message per window and
// throttled with ack-based flow control so a runaway process can't flood the renderer.
import pty from 'node-pty';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const FLUSH_MS = 4;
const HIGH_WATER = 256 * 1024;
const LOW_WATER = 32 * 1024;
const PROC_POLL_MS = 1500;
const PROMPT_MARK = '\x1b]633;A';

function splitCommand(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS') delete env[k];
  return env;
}

export class PtyHost {
  constructor({ integrationDir }) {
    this.integrationDir = integrationDir;
    this.sessions = new Map();
    this.queue = new Map(); // webContents -> Map(id -> string[])
    this.flushTimer = null;
    this.pollTimer = setInterval(() => this.pollProcesses(), PROC_POLL_MS);
  }

  spawn(owner, { id, cwd, cols, rows, profile = {}, spaceName = '', initialCommand = '' }) {
    if (this.sessions.has(id)) return { ok: true, existing: true };
    const [file = process.env.SHELL || '/bin/zsh', ...args] = splitCommand(profile.command || `${process.env.SHELL || '/bin/zsh'} -l`);
    const shell = path.basename(file);
    const env = cleanEnv();
    for (const [k, v] of Object.entries(profile.env || {})) {
      if (k) env[k] = String(v).replace(/\$space\b/g, spaceName);
    }
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Termac',
      LANG: env.LANG || 'en_US.UTF-8',
      SHELL_SPACE: spaceName,
    });
    if (profile.startup?.trim()) env.TERMAC_STARTUP = profile.startup;

    let integrated = true;
    if (shell === 'zsh') {
      env.TERMAC_USER_ZDOTDIR = env.ZDOTDIR || os.homedir();
      env.ZDOTDIR = path.join(this.integrationDir, 'zsh');
    } else if (shell === 'bash') {
      if (args.includes('-l') || args.includes('--login')) env.TERMAC_LOGIN = '1';
      const rest = args.filter((a) => a !== '-l' && a !== '--login');
      args.length = 0;
      args.push('--rcfile', path.join(this.integrationDir, 'bash.sh'), ...rest);
    } else if (shell === 'fish') {
      args.push('--init-command', `source '${path.join(this.integrationDir, 'termac.fish')}'`);
    } else {
      integrated = false;
    }

    let p;
    try {
      p = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: Math.max(2, cols | 0 || 80),
        rows: Math.max(1, rows | 0 || 24),
        cwd: cwd || os.homedir(),
        env,
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }

    const s = { id, p, owner, shell, unacked: 0, paused: false, held: false, proc: shell, pendingCommand: initialCommand || '' };
    this.sessions.set(id, s);

    p.onData((data) => {
      if (s.pendingCommand && (!integrated || data.includes(PROMPT_MARK))) {
        const c = s.pendingCommand;
        s.pendingCommand = '';
        setTimeout(() => this.write(id, c + '\r'), integrated ? 0 : 300);
      }
      this.enqueue(s, data);
    });
    p.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id);
      if (!s.owner.isDestroyed()) {
        this.flush();
        s.owner.send('pty:exit', { id, exitCode, signal });
      }
    });
    return { ok: true, pid: p.pid, shell, integrated };
  }

  enqueue(s, data) {
    if (s.owner.isDestroyed()) return;
    let byOwner = this.queue.get(s.owner);
    if (!byOwner) this.queue.set(s.owner, (byOwner = new Map()));
    const chunks = byOwner.get(s.id);
    if (chunks) chunks.push(data);
    else byOwner.set(s.id, [data]);
    s.unacked += data.length;
    if (!s.paused && s.unacked > HIGH_WATER) {
      s.paused = true;
      s.p.pause();
    }
    if (!s.held && !this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const [owner, byOwner] of this.queue) {
      const batch = [];
      for (const [id, chunks] of byOwner) {
        if (this.sessions.get(id)?.held) continue;
        batch.push([id, chunks.join('')]);
        byOwner.delete(id);
      }
      if (!byOwner.size) this.queue.delete(owner);
      if (batch.length && !owner.isDestroyed()) owner.send('pty:data', batch);
    }
  }

  ack(id, bytes) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.unacked = Math.max(0, s.unacked - bytes);
    if (s.paused && s.unacked < LOW_WATER) {
      s.paused = false;
      s.p.resume();
    }
  }

  write(id, data) {
    this.sessions.get(id)?.p.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || !(cols > 1) || !(rows > 0)) return;
    try {
      s.p.resize(cols | 0, rows | 0);
    } catch {
      /* pty already closed */
    }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.p.kill();
    } catch {
      /* already gone */
    }
  }

  // Hand a live session to another window (Quick Terminal → main window). Output is
  // held until the new owner has written the transferred scrollback and calls release().
  transfer(id, owner) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.flush();
    s.held = true;
    s.owner = owner;
    s.unacked = 0;
    for (const byOwner of this.queue.values()) {
      const chunks = byOwner.get(id);
      if (chunks) {
        byOwner.delete(id);
        this.enqueueHeld(s, chunks.join(''));
      }
    }
    return true;
  }

  enqueueHeld(s, data) {
    let byOwner = this.queue.get(s.owner);
    if (!byOwner) this.queue.set(s.owner, (byOwner = new Map()));
    byOwner.set(s.id, [...(byOwner.get(s.id) || []), data]);
  }

  release(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.held = false;
    if (s.paused) {
      s.paused = false;
      s.p.resume();
    }
    this.flush();
  }

  pollProcesses() {
    for (const s of this.sessions.values()) {
      let proc;
      try {
        proc = s.p.process;
      } catch {
        continue;
      }
      if (proc && proc !== s.proc) {
        s.proc = proc;
        if (!s.owner.isDestroyed()) s.owner.send('pty:proc', { id: s.id, proc });
      }
    }
  }

  // Fallback for shells without integration: ask the OS for the shell's cwd.
  cwdOf(id) {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile('lsof', ['-a', '-d', 'cwd', '-p', String(s.p.pid), '-Fn'], { timeout: 1500 }, (err, out) => {
        const line = !err && out.split('\n').find((l) => l.startsWith('n'));
        resolve(line ? line.slice(1) : null);
      });
    });
  }

  runningCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.proc && s.proc !== s.shell && s.proc !== 'login') n++;
    return n;
  }

  killAll() {
    clearInterval(this.pollTimer);
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}
