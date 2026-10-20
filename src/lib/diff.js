// Unified diff (git diff output for one file) → hunks of numbered lines for the review panel.

export function parseDiff(text) {
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
      hunk = { header: line, context: h[3].trim(), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (/^Binary files /.test(line)) binary = true;
      continue;
    }
    if (line.startsWith('+')) hunk.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    else if (line.startsWith('-')) hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    else if (line.startsWith(' ')) hunk.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    else if (line.startsWith('\\')) hunk.lines.push({ type: 'meta', text: line.slice(2), oldNo: null, newNo: null });
  }
  return { hunks, binary };
}

export function diffStats(parsed) {
  let add = 0;
  let del = 0;
  for (const h of parsed.hunks) for (const l of h.lines) l.type === 'add' ? add++ : l.type === 'del' && del++;
  return { add, del };
}
