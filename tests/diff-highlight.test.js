import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, diffStats } from '../src/lib/diff.js';
import { highlightLine, highlightLines, langOf } from '../src/lib/highlight.js';

const DIFF = `diff --git a/x.js b/x.js
index 1..2 100644
--- a/x.js
+++ b/x.js
@@ -1,3 +1,4 @@ function top()
 a
-b
+B
+c
 d
\\ No newline at end of file`;

describe('parseDiff', () => {
  test('numbers context, added and removed lines per side', () => {
    const { hunks, binary } = parseDiff(DIFF);
    assert.equal(binary, false);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].context, 'function top()');
    const l = hunks[0].lines;
    assert.deepEqual(l.map((x) => x.type), ['ctx', 'del', 'add', 'add', 'ctx', 'meta']);
    assert.deepEqual([l[0].oldNo, l[0].newNo], [1, 1]);
    assert.deepEqual([l[1].oldNo, l[1].newNo], [2, null]);
    assert.deepEqual([l[2].oldNo, l[2].newNo], [null, 2]);
    assert.deepEqual([l[4].oldNo, l[4].newNo], [3, 4]);
  });
  test('stats and binary files', () => {
    assert.deepEqual(diffStats(parseDiff(DIFF)), { add: 2, del: 1 });
    assert.equal(parseDiff('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ').binary, true);
    assert.deepEqual(parseDiff('').hunks, []);
  });
});

describe('highlight', () => {
  test('language from file name', () => {
    assert.equal(langOf('src/App.jsx'), 'js');
    assert.equal(langOf('a/b/Dockerfile'), 'sh');
    assert.equal(langOf('README'), null);
  });
  test('keywords, strings, numbers, comments', () => {
    const { tokens } = highlightLine('const a = "x // y" + 42; // done', 'js');
    assert.deepEqual(tokens, [['kw', 'const'], [null, ' a = '], ['str', '"x // y"'], [null, ' + '], ['num', '42'], [null, '; '], ['com', '// done']]);
  });
  test('block comments carry across lines', () => {
    const lines = highlightLines(['a /* one', 'two', 'three */ b'], 'js');
    assert.deepEqual(lines[1], [['com', 'two']]);
    assert.deepEqual(lines[2], [['com', 'three */'], [null, ' b']]);
  });
  test('unknown language passes through', () => {
    assert.deepEqual(highlightLine('plain text', null).tokens, [[null, 'plain text']]);
  });
});
