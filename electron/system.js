// macOS / filesystem lookups used by the UI. Everything here is cheap or cached.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HOME = os.homedir();

function run(cmd, args, timeout = 2000, { raw = false, ...opts } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20, ...opts }, (err, out) => resolve(err ? null : raw ? out : out.trim()));
  });
}

async function readSshConfig(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  const hosts = [];
  let current = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s*=?\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'include') {
      for (const pattern of val.split(/\s+/)) {
        const abs = pattern.startsWith('~') ? path.join(HOME, pattern.slice(1)) : path.isAbsolute(pattern) ? pattern : path.join(HOME, '.ssh', pattern);
        const dir = path.dirname(abs);
        const re = new RegExp('^' + path.basename(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        const names = await fsp.readdir(dir).catch(() => []);
        for (const n of names) if (re.test(n)) hosts.push(...(await readSshConfig(path.join(dir, n), seen)));
      }
    } else if (key === 'host') {
      current = val.split(/\s+/).filter((h) => !/[*?!]/.test(h)).map((alias) => ({ alias, hostname: '', user: '' }));
      hosts.push(...current);
    } else if (key === 'hostname') {
      for (const h of current) h.hostname = val;
    } else if (key === 'user') {
      for (const h of current) h.user = val;
    }
  }
  return hosts;
}

export async function sshHosts() {
  const hosts = await readSshConfig(path.join(HOME, '.ssh', 'config'));
  const seen = new Set();
  return hosts.filter((h) => !seen.has(h.alias) && seen.add(h.alias));
}

const branchCache = new Map();
export function gitBranch(cwd) {
  if (!cwd) return null;
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < 1500) return hit.branch;
  let branch = null;
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const dotgit = path.join(dir, '.git');
    try {
      const st = fs.statSync(dotgit);
      let gitdir = dotgit;
      if (st.isFile()) {
        const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotgit, 'utf8'));
        if (m) gitdir = path.resolve(dir, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
      branch = head.startsWith('ref: ') ? head.replace(/^ref: refs\/heads\//, '') : head.slice(0, 7);
      break;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  branchCache.set(cwd, { branch, at: Date.now() });
  if (branchCache.size > 500) branchCache.delete(branchCache.keys().next().value);
  return branch;
}

// ---- Pane header chips ---------------------------------------------------------------
// Changed-file count for the working tree (null outside a repo).
export async function gitStatus(cwd) {
  if (!cwd) return null;
  const out = await run('git', ['-C', cwd, 'status', '--porcelain=v1'], 3000);
  if (out == null) return null;
  return { changes: out ? out.split('\n').length : 0 };
}

// Local branches, most recently committed first.
export async function gitBranches(cwd) {
  if (!cwd) return [];
  const out = await run('git', ['-C', cwd, 'for-each-ref', '--sort=-committerdate', '--count=80', '--format=%(refname:short)', 'refs/heads'], 3000);
  return out ? out.split('\n') : [];
}

// Open PR for the branch via the GitHub CLI, if it's installed and signed in. GUI apps don't
// inherit the shell's PATH, so look in the usual Homebrew spots too. Cached: it hits the network.
const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', 'gh'].find((p) => !p.includes('/') || fs.existsSync(p));
const prCache = new Map();
export async function gitPr(cwd, branch) {
  if (!cwd || !branch) return null;
  const key = `${cwd}|${branch}`;
  const hit = prCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.pr;
  const out = await run(GH, ['pr', 'view', '--json', 'number,url,state'], 8000, { cwd });
  let pr = null;
  try {
    const j = JSON.parse(out || 'null');
    if (j?.number) pr = { number: j.number, url: j.url, state: j.state };
  } catch {
    pr = null;
  }
  prCache.set(key, { pr, at: Date.now() });
  if (prCache.size > 200) prCache.delete(prCache.keys().next().value);
  return pr;
}

// Visible subfolders of a directory, for the directory switcher.
export async function listDirs(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .slice(0, 300);
}

// ---- Project explorer, file viewer, code review --------------------------------------
export async function gitRoot(cwd) {
  if (!cwd) return null;
  return run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], 2000);
}

// One directory level for the explorer tree: folders first, then files.
export async function listDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return null;
  const out = [];
  for (const e of entries) {
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) isDir = isDir || (await fsp.stat(path.join(dir, e.name)).then((st) => st.isDirectory()).catch(() => false));
    out.push({ name: e.name, dir: isDir });
  }
  const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  return [...out.filter((e) => e.dir).sort(cmp), ...out.filter((e) => !e.dir).sort(cmp)].slice(0, 2000);
}

const MAX_VIEW = 2 << 20;
export async function readFile(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) return { error: 'Not a file' };
  const fh = await fsp.open(file, 'r');
  try {
    const len = Math.min(st.size, MAX_VIEW);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const binary = buf.subarray(0, 8000).includes(0);
    return { size: st.size, truncated: st.size > MAX_VIEW, binary, text: binary ? '' : buf.toString('utf8') };
  } finally {
    await fh.close();
  }
}

// Every file in the project for quick-open: git's view when it's a repo (fast, respects
// .gitignore), otherwise a bounded walk that skips the usual heavy folders.
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache', 'target', 'vendor', '.venv']);
export async function projectFiles(root) {
  const out = await run('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], 5000);
  if (out != null) return out ? out.split('\n').slice(0, 50000) : [];
  const files = [];
  const walk = async (rel, depth) => {
    if (depth > 8 || files.length >= 20000) return;
    const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (files.length >= 20000) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(r, depth + 1);
      } else files.push(r);
    }
  };
  await walk('', 0);
  return files;
}

// Changed files with line counts, staged and unstaged parts reported separately like git does.
export async function gitChanges(cwd) {
  const root = await gitRoot(cwd);
  if (!root) return null;
  const [status, unstaged, staged] = await Promise.all([
    run('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], 5000, { raw: true }),
    run('git', ['-C', root, 'diff', '--numstat', '-z'], 5000, { raw: true }),
    run('git', ['-C', root, 'diff', '--cached', '--numstat', '-z'], 5000, { raw: true }),
  ]);
  const counts = (out) => {
    const m = new Map();
    const parts = (out || '').split('\0');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p) continue;
      const [add, del, file] = p.split('\t');
      // Renames come as "add\tdel\t" followed by two NUL-separated paths.
      const name = file || (i += 2, parts[i]);
      m.set(name, { add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) });
    }
    return m;
  };
  const u = counts(unstaged);
  const c = counts(staged);
  const files = [];
  const parts = (status || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const x = p[0];
    const y = p[1];
    const file = p.slice(3);
    let from = null;
    if (x === 'R' || x === 'C') from = parts[++i];
    const untracked = x === '?';
    files.push({ path: file, from, x, y, untracked, staged: c.get(file) || null, unstaged: u.get(file) || null });
  }
  return { root, files };
}

export async function gitDiff(root, file, { staged = false, untracked = false } = {}) {
  if (untracked) return untrackedDiff(root, file);
  return run('git', ['-C', root, 'diff', '--no-color', '-U3', ...(staged ? ['--cached'] : []), '--', file], 5000);
}

// git diff --no-index exits 1 when files differ, which run() reports as failure.
function untrackedDiff(root, file) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, 'diff', '--no-index', '--no-color', '--', '/dev/null', file], { timeout: 5000, maxBuffer: 8 << 20 }, (_err, out) => resolve(out || ''));
  });
}

export async function gitStage(root, file, stage) {
  const args = stage ? ['add', '--', file] : ['restore', '--staged', '--', file];
  return (await run('git', ['-C', root, ...args], 5000)) != null;
}

export async function gitDiscard(root, file, untracked) {
  if (untracked) return (await run('git', ['-C', root, 'clean', '-f', '--', file], 5000)) != null;
  return (await run('git', ['-C', root, 'restore', '--worktree', '--source=HEAD', '--', file], 5000)) != null;
}

// Folder of the frontmost Finder window, if Finder is frontmost. No other app is probed.
export async function frontmostFolder() {
  const asn = await run('lsappinfo', ['front'], 800);
  if (!asn) return null;
  const info = await run('lsappinfo', ['info', '-only', 'bundleid', asn], 800);
  if (!info || !info.includes('com.apple.finder')) return null;
  const out = await run('osascript', ['-e', 'tell application "Finder" to if (count of Finder windows) > 0 then get POSIX path of (target of front window as alias)'], 1500);
  return out || null;
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function detectImports() {
  const ssh = await sshHosts();
  let iterm = [];
  const plist = path.join(HOME, 'Library/Preferences/com.googlecode.iterm2.plist');
  if (fs.existsSync(plist)) {
    const json = await run('plutil', ['-extract', 'New Bookmarks', 'json', '-o', '-', plist], 3000);
    try {
      iterm = JSON.parse(json || '[]').map((b) => ({
        name: b.Name || 'iTerm2 profile',
        command: b['Custom Command'] === 'Yes' && b.Command ? b.Command : '',
        cwd: b['Custom Directory'] === 'Yes' ? b['Working Directory'] || '' : '',
      }));
    } catch {
      iterm = [];
    }
  }
  const folderNames = ['work', 'Work', 'Projects', 'projects', 'Developer', 'code', 'Code', 'dev', 'src', 'repos', 'side', 'Side', 'personal', 'Sites'];
  const folders = [...new Set(folderNames.map((n) => path.join(HOME, n)).filter(isDir).map((p) => fs.realpathSync(p)))];
  return { ssh, iterm, folders, home: HOME };
}
