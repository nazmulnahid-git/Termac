// macOS / filesystem lookups used by the UI. Everything here is cheap or cached.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HOME = os.homedir();

function run(cmd, args, timeout = 2000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, out) => resolve(err ? null : out.trim()));
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
