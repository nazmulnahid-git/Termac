// Unified diff (git diff output) → hunks of numbered lines for the review panel, plus what
// the panel builds from them: a single-hunk patch to stage or discard, side-by-side rows,
// and per-file pieces of a multi-file patch.

export function parseDiff(text) {
  const head = [];
  const hunks = [];
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  let binary = false;
  for (const line of (text || '').split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, context: h[3].trim(), lines: [], raw: [line] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (/^Binary files /.test(line)) binary = true;
      if (line) head.push(line);
      continue;
    }
    if (line.startsWith('+')) hunk.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    else if (line.startsWith('-')) hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    else if (line.startsWith(' ')) hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (line.startsWith('\\')) hunk.lines.push({ type: 'meta', text: line.slice(2), oldNo: null, newNo: null });
    else continue;
    hunk.raw.push(line);
  }
  return { head, hunks, binary };
}

export function diffStats(parsed) {
  let add = 0;
  let del = 0;
  for (const h of parsed.hunks) for (const l of h.lines) l.type === 'add' ? add++ : l.type === 'del' && del++;
  return { add, del };
}

// A patch holding one hunk of a file's diff, for `git apply` to stage, unstage or discard.
export function hunkPatch(parsed, index) {
  const h = parsed.hunks[index];
  return [...parsed.head, ...h.raw].join('\n') + '\n';
}

// Side-by-side rows: context on both sides, and each run of removals paired line for line
// with the additions that replace it.
export function splitRows(hunk) {
  const rows = [];
  const lines = hunk.lines;
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (l.type === 'ctx') {
      rows.push({ left: l, right: l, li: i, ri: i });
      i++;
    } else if (l.type === 'meta') {
      rows.push({ meta: l, mi: i });
      i++;
    } else {
      const dels = [];
      const adds = [];
      while (i < lines.length && lines[i].type === 'del') dels.push(i++);
      while (i < lines.length && lines[i].type === 'add') adds.push(i++);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const li = dels[k] ?? null;
        const ri = adds[k] ?? null;
        rows.push({ left: li == null ? null : lines[li], right: ri == null ? null : lines[ri], li, ri });
      }
    }
  }
  return rows;
}

// `git show` / multi-file diff → [{ path, from, status, text }], one entry per file.
export function splitFiles(text) {
  const files = [];
  let cur = null;
  for (const line of (text || '').split('\n')) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      cur = { path: m[2], from: m[1] === m[2] ? null : m[1], status: 'M', lines: [line] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (line.startsWith('rename from')) cur.status = 'R';
  }
  return files.map(({ lines, ...f }) => ({ ...f, text: lines.join('\n') }));
}
