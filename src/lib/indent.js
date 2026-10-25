// How a file is indented, so the editor's Tab matches it.

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// Tabs or spaces, and how many: tabs if most indented lines use them, otherwise the step
// all space indents share (2, 3 or 4; deeper steps count as 4).
export function detectIndent(text) {
  let tabs = 0;
  let spaced = 0;
  let step = 0;
  for (const line of text.split('\n', 2000)) {
    if (line.startsWith('\t')) tabs++;
    else {
      const m = /^( +)\S/.exec(line);
      if (!m) continue;
      spaced++;
      step = gcd(step, m[1].length);
    }
  }
  if (tabs > spaced) return { tabs: true, size: 4 };
  if (!step || step === 1) return { tabs: false, size: 2 };
  return { tabs: false, size: step >= 4 ? 4 : step };
}
