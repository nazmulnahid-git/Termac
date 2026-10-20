// Archived sessions: a small JSON index plus one ANSI scrollback file per session.
// Full-text search reads scrollback lazily and keeps a bounded cache of stripped text.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJSON, debouncedWriter } from './store.js';

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;
const CACHE_LIMIT = 24 * 1024 * 1024;

export class Library {
  constructor(dir) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    this.entries = readJSON(this.indexFile, []);
    this.writer = debouncedWriter(this.indexFile, 300);
    this.cache = new Map();
    this.cacheSize = 0;
  }

  file(id) {
    return path.join(this.dir, `${id.replace(/[^\w-]/g, '')}.ans`);
  }

  async add(entry, ansi) {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.file(entry.id), ansi || '');
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    this.entries.unshift({ ...entry, bytes: (ansi || '').length });
    this.writer.save(this.entries);
    return entry;
  }

  async remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.writer.save(this.entries);
    this.dropCache(id);
    await fsp.rm(this.file(id), { force: true });
  }

  content(id) {
    return fsp.readFile(this.file(id), 'utf8').catch(() => '');
  }

  async prune(days) {
    if (!days) return;
    const cutoff = Date.now() - days * 86400000;
    const old = this.entries.filter((e) => (e.endedAt || 0) < cutoff);
    for (const e of old) await this.remove(e.id);
  }

  dropCache(id) {
    const t = this.cache.get(id);
    if (t != null) {
      this.cacheSize -= t.length;
      this.cache.delete(id);
    }
  }

  async text(id) {
    let t = this.cache.get(id);
    if (t != null) {
      this.cache.delete(id);
      this.cache.set(id, t);
      return t;
    }
    t = (await this.content(id)).replace(ANSI_RE, '').toLowerCase();
    this.cache.set(id, t);
    this.cacheSize += t.length;
    for (const [k, v] of this.cache) {
      if (this.cacheSize <= CACHE_LIMIT) break;
      this.cache.delete(k);
      this.cacheSize -= v.length;
    }
    return t;
  }

  async search({ q = '', spaceId, cwd, host, status, sinceDays } = {}) {
    const query = q.trim().toLowerCase();
    const since = sinceDays ? Date.now() - sinceDays * 86400000 : 0;
    const out = [];
    for (const e of this.entries) {
      if (spaceId && e.spaceId !== spaceId) continue;
      if (cwd && e.cwd !== cwd) continue;
      if (host && (e.host || 'local') !== host) continue;
      if (status && e.status !== status) continue;
      if (since && (e.endedAt || 0) < since) continue;
      if (!query) {
        out.push(e);
      } else {
        let hit = null;
        if (e.name?.toLowerCase().includes(query)) hit = 'name';
        else if (e.commands?.some((c) => c.cmd.toLowerCase().includes(query))) hit = 'command';
        else if (e.cwd?.toLowerCase().includes(query) || e.host?.toLowerCase().includes(query)) hit = 'path';
        else if ((await this.text(e.id)).includes(query)) hit = 'output';
        if (hit) out.push({ ...e, hit });
      }
      if (out.length >= 500) break;
    }
    return { total: this.entries.length, results: out };
  }

  flushSync() {
    this.writer.flushSync();
  }
}
