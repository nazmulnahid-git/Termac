import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzy, highlight } from '../src/lib/fuzzy.js';

describe('fuzzy', () => {
  test('empty query matches everything with score 0', () => {
    assert.deepEqual(fuzzy('', 'anything'), { score: 0, indices: [] });
  });
  test('returns null when the query is not a subsequence', () => {
    assert.equal(fuzzy('xyz', 'abc'), null);
    assert.equal(fuzzy('ba', 'ab'), null);
    assert.equal(fuzzy('abcd', 'abc'), null);
  });
  test('substring indices are contiguous', () => {
    assert.deepEqual(fuzzy('ter', 'my terminal').indices, [3, 4, 5]);
  });
  test('case-insensitive', () => {
    const r = fuzzy('GIT', 'git status');
    assert.ok(r);
    assert.deepEqual(r.indices, [0, 1, 2]);
  });
  test('subsequence indices pick the earliest characters in order', () => {
    assert.deepEqual(fuzzy('gst', 'git status').indices, [0, 4, 5]);
  });
  test('spaces in the query are skipped in subsequence mode', () => {
    assert.deepEqual(fuzzy('g s', 'git status').indices, [0, 4]);
  });
  test('substring beats subsequence', () => {
    const sub = fuzzy('abc', 'xxabcxx');
    const seq = fuzzy('abc', 'axbxcxx');
    assert.ok(sub && seq);
    assert.ok(sub.score > seq.score);
  });
  test('substring at a word start beats one mid-word', () => {
    assert.ok(fuzzy('ap', 'my-app').score > fuzzy('ap', 'mmap').score);
    assert.ok(fuzzy('api', 'work/api').score > fuzzy('api', 'workapi').score);
  });
  test('subsequence word-start bonus', () => {
    // same length, same query; "s" lands on a word start only in the first
    assert.ok(fuzzy('gs', 'git status').score > fuzzy('gs', 'gitxstatus').score);
  });
  test('contiguous subsequence runs score higher', () => {
    assert.ok(fuzzy('abd', 'abxxxd').score > fuzzy('abd', 'axbxxd').score);
  });
  test('earlier and shorter matches score higher', () => {
    assert.ok(fuzzy('dev', 'dev server').score > fuzzy('dev', 'npm run dev').score);
    assert.ok(fuzzy('api', 'api').score > fuzzy('api', 'api-gateway-service').score);
  });
});

describe('highlight', () => {
  test('no indices gives one plain part', () => {
    assert.deepEqual(highlight('abc', []), [{ text: 'abc', hit: false }]);
    assert.deepEqual(highlight('abc', undefined), [{ text: 'abc', hit: false }]);
  });
  test('groups adjacent hits and misses', () => {
    assert.deepEqual(highlight('abcd', [0, 1]), [
      { text: 'ab', hit: true },
      { text: 'cd', hit: false },
    ]);
    assert.deepEqual(highlight('abc', [1]), [
      { text: 'a', hit: false },
      { text: 'b', hit: true },
      { text: 'c', hit: false },
    ]);
  });
  test('round-trips with fuzzy indices', () => {
    const text = 'git status';
    const parts = highlight(text, fuzzy('gst', text).indices);
    assert.equal(parts.map((p) => p.text).join(''), text);
    assert.equal(parts.filter((p) => p.hit).map((p) => p.text).join(''), 'gst');
  });
});
