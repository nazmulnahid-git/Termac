// The input bar's text logic, kept free of React so it can be tested: shell-ish tokens for
// highlighting, history suggestions and recall, and applying a completion.

// Splits a command line into typed tokens. `cmd` marks the word in command position (start
// of the line or after |, ;, &&, ||), where an assignment like FOO=1 doesn't count.
export function tokenize(text) {
  const re = /(\s+)|("(?:[^"\\]|\\.)*"?|'[^']*'?)|(\|\||&&|[|;&<>]+)|(\$\{[^}]*\}?|\$\w+)|((?:\\.|[^\s|;&<>"'$])+)/gy;
  const out = [];
  let expectCmd = true;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    const [t, space, str, op, variable, word] = m;
    if (space) out.push({ t, k: 'space' });
    else if (str) out.push({ t, k: 'str' }), (expectCmd = false);
    else if (op) out.push({ t, k: 'op' }), (expectCmd = /[|;&]/.test(t));
    else if (variable) out.push({ t, k: 'var' });
    else if (word) {
      if (expectCmd && /^\w+=/.test(word)) out.push({ t, k: 'assign' });
      else if (expectCmd) out.push({ t, k: 'cmd' }), (expectCmd = false);
      else out.push({ t, k: word.startsWith('-') ? 'flag' : 'arg' });
    }
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  // Anything the pattern couldn't place (a lone "$") stays plain text.
  const covered = out.reduce((n, x) => n + x.t.length, 0);
  if (covered < text.length) out.push({ t: text.slice(covered), k: 'arg' });
  return out;
}

// The rest of the newest history entry that starts with what's typed (zsh-autosuggestions).
export function suggest(text, history) {
  if (!text.trim() || text.includes('\n')) return '';
  const hit = history.find((h) => h.length > text.length && h.startsWith(text));
  return hit ? hit.slice(text.length) : '';
}

// History entries for ↑/↓: those starting with what was typed when recall began.
export function recallList(prefix, history) {
  const seen = new Set();
  return history.filter((h) => h.startsWith(prefix) && h !== prefix && !seen.has(h) && seen.add(h));
}

// Replaces the word being completed (from `start` up to the caret) with `value`. Folders
// keep the caret right after the slash; anything else gets a trailing space.
export function applyCompletion(text, caret, start, item) {
  const tail = item.kind === 'dir' ? '' : ' ';
  const before = text.slice(0, start) + item.value + (text.slice(caret).startsWith(' ') ? '' : tail);
  return { text: before + text.slice(caret), caret: before.length };
}

export function commonPrefix(values) {
  if (!values.length) return '';
  let p = values[0];
  for (const v of values) while (!v.startsWith(p)) p = p.slice(0, -1);
  return p;
}
