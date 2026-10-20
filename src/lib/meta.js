// Display helpers: session names, kind chips, process labels, durations.
import { tildify } from './routing.js';

export const SPACE_COLORS = ['#3b82f6', '#f08a3c', '#22a06b', '#8b5cf6', '#e5487d', '#0ea5a4', '#d4a017', '#e5484d', '#64748b'];
export const SPACE_GLYPHS = ['◆', '●', '▲', '■', '✦', '☾', '♣', '★'];

const RUNNERS = new Set(['sudo', 'env', 'time', 'npx', 'pnpm', 'yarn', 'bunx', 'exec', 'nohup', 'caffeinate', 'command']);

export function firstToken(cmd) {
  if (!cmd) return '';
  const parts = cmd.trim().split(/\s+/);
  for (const p of parts) {
    if (/^\w+=/.test(p) || RUNNERS.has(p) || p.startsWith('-')) continue;
    if ((p === 'npm' || p === 'bun') && parts.length > 2) return parts.slice(parts.indexOf(p), parts.indexOf(p) + 3).join(' ');
    return p.split('/').pop();
  }
  return parts[0];
}

const KINDS = [
  [/^(node|npm|npx|pnpm|yarn|bun|bunx|deno|tsx|vite|vitest|jest|next|nuxt|astro)\b/, 'js'],
  [/^(python3?|pip3?|pytest|poetry|uv|uvx|ipython|jupyter|django-admin|flask)\b/, 'py'],
  [/^(psql|mysql|sqlite3|redis-cli|mongosh|pgcli)\b/, 'db'],
  [/^(git|gh|lazygit|tig)\b/, 'git'],
  [/^(ssh|mosh|autossh|scp|sftp)\b/, 'ssh'],
  [/^(terraform|tofu|tfenv|pulumi)\b/, 'tf'],
  [/^(kubectl|k9s|helm|minikube|kind)\b/, 'k8'],
  [/^(cargo|rustc|rustup)\b/, 'rs'],
  [/^(go)\b/, 'go'],
  [/^(docker|docker-compose|podman|colima)\b/, 'dk'],
  [/^(vim|nvim|vi|nano|emacs|hx|micro)\b/, 'ed'],
  [/^(htop|top|btop|glances)\b/, 'top'],
];

export function kindOf(cmd) {
  if (!cmd) return '>_';
  const c = cmd.trim().replace(/^(sudo|env|time|exec)\s+/, '');
  for (const [re, k] of KINDS) if (re.test(c)) return k;
  return '>_';
}

export function leafOf(cwd, home) {
  if (!cwd) return '~';
  const t = tildify(cwd, home);
  if (t === '~') return '~';
  const leaf = t.split('/').filter(Boolean).pop();
  return leaf || '/';
}

export function splitCwd(cwd, home) {
  const t = tildify(cwd || '~', home);
  const i = t.lastIndexOf('/');
  if (i < 0) return { dir: '', leaf: t };
  return { dir: t.slice(0, i + 1), leaf: t.slice(i + 1) };
}

// Session name: the user's rename wins, then the running/last notable command, then the folder.
export function sessionName(meta, rt, home) {
  if (meta?.name) return meta.name;
  if (rt?.status === 'run' && rt.command) return rt.command;
  if ((rt?.status === 'fail' || rt?.status === 'ok') && rt.command) return rt.command;
  return leafOf(rt?.cwd || meta?.cwd, home);
}

export function shortName(name) {
  const s = (name || '').trim().split(/\s+/)[0] || '';
  return s.length > 7 ? s.slice(0, 6) + '…' : s;
}

export function procLabel(rt, shell) {
  if (!rt) return shell || 'zsh';
  if (rt.status === 'run' && rt.command) return rt.command.length > 28 ? rt.command.slice(0, 27) + '…' : rt.command;
  if (rt.status === 'fail') return `${firstToken(rt.command)} · exited ${rt.exitCode}`;
  if (rt.status === 'ok' && rt.command) return `${firstToken(rt.command)} · done`;
  if (rt.proc && rt.proc !== rt.shell && rt.proc !== 'login') return rt.proc;
  return rt.shell || shell || 'zsh';
}

export function formatDuration(ms) {
  if (ms == null) return '';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'This week';
  if (diff < 14) return 'Last week';
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

let counter = 0;
export function uid(prefix = 'x') {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
