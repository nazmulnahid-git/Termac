import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findTabs } from '../src/lib/tabfind.js';

const items = [
  { tid: 'a', name: 'server', path: '~/code/api', spaceId: 'work' },
  { tid: 'b', name: 'npm run dev', path: '~/code/web', spaceId: 'work' },
  { tid: 'c', name: 'server', path: '~/side/blog', spaceId: 'home' },
  { tid: 'd', name: 'htop', path: '~', spaceId: null },
];

describe('findTabs', () => {
  test('empty or blank query finds nothing', () => {
    assert.deepEqual(findTabs('', items, 'work'), []);
    assert.deepEqual(findTabs('   ', items, 'work'), []);
  });
  test('matches names and returns highlight indices', () => {
    const hits = findTabs('dev', items, 'work');
    assert.deepEqual(hits.map((h) => h.tid), ['b']);
    assert.equal(hits[0].on, 'name');
    assert.deepEqual(hits[0].indices, [8, 9, 10]);
  });
  test('falls back to the path when the name misses', () => {
    const hits = findTabs('blog', items, 'work');
    assert.deepEqual(hits.map((h) => h.tid), ['c']);
    assert.equal(hits[0].on, 'path');
  });
  test('a name hit outranks a path hit', () => {
    const hits = findTabs('web', [...items, { tid: 'e', name: 'webpack', path: '~', spaceId: 'home' }], 'work');
    assert.deepEqual(hits.map((h) => h.tid), ['e', 'b']);
  });
  test('the current Space wins a tie', () => {
    assert.deepEqual(findTabs('server', items, 'home').map((h) => h.tid), ['c', 'a']);
    assert.deepEqual(findTabs('server', items, 'work').map((h) => h.tid), ['a', 'c']);
  });
  test('favorites count as here', () => {
    const hits = findTabs('h', [{ tid: 'x', name: 'h', spaceId: 'other' }, { tid: 'y', name: 'h', spaceId: null }], 'work');
    assert.deepEqual(hits.map((h) => h.tid), ['y', 'x']);
  });
});
