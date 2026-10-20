// Subsequence fuzzy matcher. Scores contiguous runs and word starts higher and
// returns the matched character indices for highlighting.
const BOUNDARY = /[\s/._\-@:·]/;

export function fuzzy(query, text) {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // A plain substring always wins and is cheap to find.
  const at = t.indexOf(q);
  if (at !== -1) {
    const start = at === 0 || BOUNDARY.test(t[at - 1]);
    const indices = Array.from({ length: q.length }, (_, i) => at + i);
    return { score: 100 + q.length * 4 + (start ? 30 : 0) - at * 0.5 - t.length * 0.05, indices };
  }

  let score = 0;
  let ti = 0;
  let prev = -2;
  const indices = [];
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti++;
        break;
      }
      ti++;
    }
    if (found === -1) return null;
    indices.push(found);
    score += 1;
    if (found === prev + 1) score += 5;
    if (found === 0 || BOUNDARY.test(t[found - 1])) score += 8;
    prev = found;
  }
  return { score: score - t.length * 0.05, indices };
}

// Splits text into [{text, hit}] parts for rendering highlighted matches.
export function highlight(text, indices) {
  if (!indices?.length) return [{ text, hit: false }];
  const set = new Set(indices);
  const parts = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else parts.push({ text: text[i], hit });
  }
  return parts;
}
