// Small JSON persistence helpers: atomic writes (tmp + rename) and debounced saves.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

export function writeAtomicSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Coalesces frequent saves into one write per `delay` ms. `flushSync` is for quit.
export function debouncedWriter(file, delay = 400) {
  let pending = null;
  let timer = null;
  let writing = Promise.resolve();
  const run = () => {
    timer = null;
    const data = pending;
    pending = null;
    if (data == null) return;
    writing = writing.then(() => writeAtomic(file, data)).catch((e) => console.error('save failed', file, e));
  };
  return {
    save(obj) {
      pending = JSON.stringify(obj);
      if (!timer) timer = setTimeout(run, delay);
    },
    flushSync() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (pending != null) writeAtomicSync(file, pending);
      pending = null;
    },
  };
}
