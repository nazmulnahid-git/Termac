import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { highlightLine, highlightLines, langOf } from '../src/lib/highlight.js';

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
