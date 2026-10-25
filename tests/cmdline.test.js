import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, suggest, recallList, applyCompletion, commonPrefix } from '../src/lib/cmdline.js';

const kinds = (text) => tokenize(text).filter((t) => t.k !== 'space').map((t) => `${t.k}:${t.t}`);

describe('tokenize', () => {
  test('finds commands after operators, flags, strings and variables', () => {
    assert.deepEqual(kinds(`FOO=1 git commit -m "hi there" && echo $HOME | wc -l`), [
      'assign:FOO=1', 'cmd:git', 'arg:commit', 'flag:-m', 'str:"hi there"', 'op:&&', 'cmd:echo', 'var:$HOME', 'op:|', 'cmd:wc', 'flag:-l',
    ]);
  });
  test('keeps every character, even unfinished quotes', () => {
    for (const s of [`echo "unterminated`, `ls > out.txt`, `cd my\\ dir`, `echo $`]) assert.equal(tokenize(s).map((t) => t.t).join(''), s);
  });
});

describe('history', () => {
  const history = ['git status', 'git stash pop', 'npm test', 'git status'];
  test('suggests the newest entry extending the input', () => {
    assert.equal(suggest('git st', history), 'atus');
    assert.equal(suggest('', history), '');
    assert.equal(suggest('npm test', history), '');
  });
  test('recalls by prefix without duplicates', () => {
    assert.deepEqual(recallList('git', history), ['git status', 'git stash pop']);
    assert.deepEqual(recallList('', history), ['git status', 'git stash pop', 'npm test']);
  });
});

describe('completion', () => {
  test('replaces the word and spaces after files but not folders', () => {
    assert.deepEqual(applyCompletion('cat rea', 7, 4, { value: 'readme.md', kind: 'file' }), { text: 'cat readme.md ', caret: 14 });
    assert.deepEqual(applyCompletion('cd sr', 5, 3, { value: 'src/', kind: 'dir' }), { text: 'cd src/', caret: 7 });
    assert.deepEqual(applyCompletion('cat rea | wc', 7, 4, { value: 'readme.md', kind: 'file' }), { text: 'cat readme.md | wc', caret: 13 });
  });
  test('common prefix of candidates', () => {
    assert.equal(commonPrefix(['package.json', 'package-lock.json']), 'package');
    assert.equal(commonPrefix([]), '');
  });
});
