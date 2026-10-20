// Minimal Markdown for the notes panel: headings, paragraphs, checklists, bullets,
// fenced code and "pasted from" provenance quotes. Returns blocks with source line
// numbers so the UI can toggle a checkbox by editing that line.

export function parseBlocks(src) {
  const lines = src.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```([^`\s]*)\s*$/.exec(line);
    if (fence) {
      const start = i;
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang: fence[1], text: body.join('\n'), line: start });
      continue;
    }
    const prov = /^>\s*pasted from (.+?)(?:\s*\{(\w+)(?::(\d+))?\})?\s*$/.exec(line);
    if (prov) {
      const start = i;
      const body = [];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ type: 'paste', source: prov[1], sessionId: prov[2] || null, mark: prov[3] ? Number(prov[3]) : null, text: body.join('\n'), line: start });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2], line: i });
      i++;
      continue;
    }
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (task) {
      blocks.push({ type: 'task', done: task[1] !== ' ', text: task[2], line: i });
      i++;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ type: 'bullet', text: bullet[1], line: i });
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const start = i;
    // Always consume the first line so text no rule claims can't stall the loop.
    const para = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|\s*[-*]\s|>\s*pasted from)/.test(lines[i])) para.push(lines[i++]);
    blocks.push({ type: 'para', text: para.join(' '), line: start });
  }
  return blocks;
}

// Inline spans: `code`, **bold**.
export function parseInline(text) {
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    out.push(m[1] != null ? { t: 'code', v: m[1] } : { t: 'bold', v: m[2] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

export function toggleTask(src, line) {
  const lines = src.split('\n');
  lines[line] = lines[line].replace(/\[( |x|X)\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'));
  return lines.join('\n');
}
