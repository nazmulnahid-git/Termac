import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, hunkPatch, splitRows, splitFiles } from '../src/lib/diff.js';
import { reviewMarkdown } from '../src/lib/review.js';

const TWO_HUNKS = `diff --git a/x.js b/x.js
index 1..2 100644
--- a/x.js
+++ b/x.js
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -20,2 +20,3 @@ tail()
 y
+z
 w
\\ No newline at end of file`;

describe('hunkPatch', () => {
  test('keeps the file header and only the chosen hunk', () => {
    const p = hunkPatch(parseDiff(TWO_HUNKS), 1);
    assert.match(p, /^diff --git a\/x.js b\/x.js\nindex 1..2 100644\n--- a\/x.js\n\+\+\+ b\/x.js\n@@ -20,2 \+20,3 @@ tail\(\)\n/);
    assert.ok(!p.includes('+B'));
    assert.ok(p.endsWith('\\ No newline at end of file\n'));
  });
});

describe('splitRows', () => {
  test('pairs removals with the additions that replace them', () => {
    const h = parseDiff(`@@ -1,4 +1,4 @@
 a
-b
-c
+B
 d
+e`).hunks[0];
    const rows = splitRows(h).map((r) => [r.left?.text ?? null, r.right?.text ?? null]);
    assert.deepEqual(rows, [['a', 'a'], ['b', 'B'], ['c', null], ['d', 'd'], [null, 'e']]);
  });
});

describe('splitFiles', () => {
  test('cuts a commit patch into files with their status', () => {
    const files = splitFiles(`diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hi
diff --git a/old.js b/renamed.js
similarity index 90%
rename from old.js
rename to renamed.js`);
    assert.deepEqual(files.map((f) => [f.path, f.status, f.from]), [['new.txt', 'A', null], ['renamed.js', 'R', 'old.js']]);
    assert.equal(parseDiff(files[0].text).hunks[0].lines[0].text, 'hi');
  });
});

describe('reviewMarkdown', () => {
  test('groups comments by file with the line they point at', () => {
    const md = reviewMarkdown([
      { path: 'b.js', side: 'new', line: 9, snippet: 'const x = 1;', text: 'Rename x.' },
      { path: 'a.js', side: 'old', line: 3, snippet: '', text: 'Why remove this?\nIt was used.' },
    ]);
    assert.equal(md, 'Review comments (2):\n\na.js:3 (removed line)\n  Why remove this?\n  It was used.\n\nb.js:9\n  > const x = 1;\n  Rename x.');
  });
});
