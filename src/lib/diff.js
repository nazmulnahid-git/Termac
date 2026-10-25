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

// ---- Word-level changes ----------------------------------------------------------------
// For a removed line and the added line that replaced it, the character ranges that differ
// on each side, found with an LCS over word, space and punctuation tokens. Lines that have
// little in common get none: the whole line already reads as changed.
const WORD = /\w+|\s+|[^\w\s]/g;

export function inlineDiff(a, b) {
  const ta = a.match(WORD) || [];
  const tb = b.match(WORD) || [];
  if (!ta.length || !tb.length || ta.length * tb.length > 60000) return null;
  const n = ta.length;
  const m = tb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keepA = new Uint8Array(n);
  const keepB = new Uint8Array(m);
  let common = 0;
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ta[i] === tb[j]) {
      keepA[i++] = keepB[j++] = 1;
      common += ta[i - 1].trim() ? ta[i - 1].length : 0;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const meaningful = (s) => s.replace(/\s+/g, '').length;
  if (common < 0.35 * Math.min(meaningful(a), meaningful(b))) return null;
  const ranges = (tokens, keep) => {
    const out = [];
    let at = 0;
    tokens.forEach((t, i) => {
      if (!keep[i]) {
        const last = out[out.length - 1];
        if (last && last[1] === at) last[1] = at + t.length;
        else out.push([at, at + t.length]);
      }
      at += t.length;
    });
    return out;
  };
  return { a: ranges(ta, keepA), b: ranges(tb, keepB) };
}

// Word-level ranges for every changed line of a hunk, by line index: each run of removals
// is paired line for line with the additions that follow it.
export function hunkInline(hunk) {
  const out = new Map();
  const lines = hunk.lines;
  for (let i = 0; i < lines.length; ) {
    if (lines[i].type !== 'del') {
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(i++);
    while (i < lines.length && lines[i].type === 'add') adds.push(i++);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const d = inlineDiff(lines[dels[k]].text, lines[adds[k]].text);
      if (!d) continue;
      out.set(dels[k], d.a);
      out.set(adds[k], d.b);
    }
  }
  return out;
}

// Splits syntax tokens ([class, text]) at the edges of changed ranges, marking the pieces
// inside one: [class, text, changed].
export function markRanges(tokens, ranges) {
  if (!ranges?.length) return tokens;
  const out = [];
  let at = 0;
  let r = 0;
  for (const [cls, text] of tokens) {
    let i = 0;
    while (i < text.length) {
      while (r < ranges.length && ranges[r][1] <= at + i) r++;
      const range = ranges[r];
      const inside = !!range && range[0] <= at + i;
      const stop = inside ? range[1] : range ? range[0] : Infinity;
      const end = Math.min(text.length, stop - at);
      out.push([cls, text.slice(i, end), inside]);
      i = end;
    }
    at += text.length;
  }
  return out;
}

// GitHub-style five-block bar for a file's additions and deletions: more lines fill more
// blocks (log scale), split between added and removed.
export function statBlocks(add, del, n = 5) {
  const total = add + del;
  if (!total) return Array(n).fill('none');
  const filled = Math.min(n, Math.max(1, Math.ceil(Math.log10(total + 1) * 2)));
  const adds = Math.round((add / total) * filled);
  return [...Array(adds).fill('add'), ...Array(filled - adds).fill('del'), ...Array(n - filled).fill('none')];
}
