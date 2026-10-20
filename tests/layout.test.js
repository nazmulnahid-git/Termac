import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PANES, leaf, leaves, insert, insertRoot, remove, setRatio, snapRatio, rects, neighbor } from '../src/lib/layout.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

// 2x2 grid: 1 | 2
//           3 | 4
const grid = () => ({ dir: 'row', ratio: 0.5, a: { dir: 'col', ratio: 0.5, a: leaf('1'), b: leaf('3') }, b: { dir: 'col', ratio: 0.5, a: leaf('2'), b: leaf('4') } });

describe('leaves', () => {
  test('in-order leaf ids', () => {
    assert.deepEqual(leaves(null), []);
    assert.deepEqual(leaves(leaf('a')), ['a']);
    assert.deepEqual(leaves(grid()), ['1', '3', '2', '4']);
  });
});

describe('insert', () => {
  test('right/bottom put the new pane second, left/top first', () => {
    assert.deepEqual(insert(leaf('a'), 'a', 'b'), { dir: 'row', ratio: 0.5, a: leaf('a'), b: leaf('b') });
    assert.deepEqual(insert(leaf('a'), 'a', 'b', 'right'), { dir: 'row', ratio: 0.5, a: leaf('a'), b: leaf('b') });
    assert.deepEqual(insert(leaf('a'), 'a', 'b', 'left'), { dir: 'row', ratio: 0.5, a: leaf('b'), b: leaf('a') });
    assert.deepEqual(insert(leaf('a'), 'a', 'b', 'bottom'), { dir: 'col', ratio: 0.5, a: leaf('a'), b: leaf('b') });
    assert.deepEqual(insert(leaf('a'), 'a', 'b', 'top'), { dir: 'col', ratio: 0.5, a: leaf('b'), b: leaf('a') });
  });
  test('splits only the target leaf in a nested tree', () => {
    const t = insert(insert(leaf('a'), 'a', 'b'), 'b', 'c', 'bottom');
    assert.deepEqual(t, { dir: 'row', ratio: 0.5, a: leaf('a'), b: { dir: 'col', ratio: 0.5, a: leaf('b'), b: leaf('c') } });
  });
  test('unknown target leaves the tree unchanged', () => {
    const t = insert(leaf('a'), 'a', 'b');
    assert.deepEqual(insert(t, 'zzz', 'c'), t);
  });
  test(`caps at MAX_PANES (${MAX_PANES})`, () => {
    let t = leaf('p0');
    for (let i = 1; i < 10; i++) t = insert(t, `p${i - 1}`, `p${i}`);
    assert.equal(leaves(t).length, MAX_PANES);
    const full = t;
    assert.equal(insert(full, 'p0', 'extra'), full);
  });
  test('does not mutate the input', () => {
    const t = insert(leaf('a'), 'a', 'b');
    const snapshot = structuredClone(t);
    insert(t, 'b', 'c');
    assert.deepEqual(t, snapshot);
  });
});

describe('insertRoot', () => {
  test('wraps the whole tree on the given edge', () => {
    const t = insert(leaf('a'), 'a', 'b');
    assert.deepEqual(insertRoot(t, leaf('c'), 'right'), { dir: 'row', ratio: 0.5, a: t, b: leaf('c') });
    assert.deepEqual(insertRoot(t, leaf('c'), 'left'), { dir: 'row', ratio: 0.5, a: leaf('c'), b: t });
    assert.deepEqual(insertRoot(t, leaf('c'), 'top'), { dir: 'col', ratio: 0.5, a: leaf('c'), b: t });
    assert.deepEqual(insertRoot(t, leaf('c'), 'bottom'), { dir: 'col', ratio: 0.5, a: t, b: leaf('c') });
  });
  test('refuses when the result would exceed MAX_PANES', () => {
    const g = grid();
    assert.equal(insertRoot(g, leaf('5')), g);
    const three = insert(insert(leaf('a'), 'a', 'b'), 'b', 'c');
    assert.equal(insertRoot(three, insert(leaf('x'), 'x', 'y')), three);
    assert.equal(leaves(insertRoot(three, leaf('d'))).length, 4);
  });
});

describe('remove', () => {
  test('removing one side of a split collapses it to the sibling', () => {
    const t = insert(leaf('a'), 'a', 'b');
    assert.deepEqual(remove(t, 'b'), leaf('a'));
    assert.deepEqual(remove(t, 'a'), leaf('b'));
  });
  test('nested removal collapses only the affected split and keeps ratios', () => {
    const t = setRatio(insert(insert(leaf('a'), 'a', 'b'), 'b', 'c', 'bottom'), [], 0.3);
    assert.deepEqual(remove(t, 'c'), { dir: 'row', ratio: 0.3, a: leaf('a'), b: leaf('b') });
    assert.deepEqual(remove(t, 'a'), { dir: 'col', ratio: 0.5, a: leaf('b'), b: leaf('c') });
  });
  test('removing the last leaf returns null; unknown sid is a no-op', () => {
    assert.equal(remove(leaf('a'), 'a'), null);
    assert.equal(remove(null, 'a'), null);
    assert.deepEqual(remove(grid(), 'zzz'), grid());
  });
  test('2x2 grid minus one is three panes', () => {
    const t = remove(grid(), '4');
    assert.deepEqual(leaves(t), ['1', '3', '2']);
    assert.deepEqual(t.b, leaf('2'));
  });
});

describe('setRatio', () => {
  test('root and nested paths, without mutating', () => {
    const g = grid();
    assert.equal(setRatio(g, [], 0.7).ratio, 0.7);
    const t = setRatio(g, ['b'], 0.25);
    assert.equal(t.b.ratio, 0.25);
    assert.equal(t.a.ratio, 0.5);
    assert.equal(t.ratio, 0.5);
    assert.equal(g.b.ratio, 0.5);
    assert.equal(t.a, g.a, 'untouched branch is shared');
  });
});

describe('snapRatio', () => {
  test('snaps to 1/3, 1/2, 2/3 within 0.025', () => {
    assert.equal(snapRatio(0.34), 1 / 3);
    assert.equal(snapRatio(0.31), 1 / 3);
    assert.equal(snapRatio(0.51), 0.5);
    assert.equal(snapRatio(0.48), 0.5);
    assert.equal(snapRatio(0.65), 2 / 3);
  });
  test('passes through values outside the snap zones', () => {
    assert.equal(snapRatio(0.4), 0.4);
    assert.equal(snapRatio(0.3), 0.3);
    assert.equal(snapRatio(0.6), 0.6);
  });
  test('clamps to [0.15, 0.85]', () => {
    assert.equal(snapRatio(0.05), 0.15);
    assert.equal(snapRatio(-1), 0.15);
    assert.equal(snapRatio(0.95), 0.85);
    assert.equal(snapRatio(2), 0.85);
  });
});

describe('rects', () => {
  test('single leaf fills the card', () => {
    assert.deepEqual(rects(leaf('a')), { a: { x: 0, y: 0, w: 1, h: 1 } });
    assert.deepEqual(rects(null), {});
  });
  test('row/col splits honour ratio', () => {
    const r = rects(setRatio(insert(leaf('a'), 'a', 'b'), [], 0.25));
    assert.deepEqual(r.a, { x: 0, y: 0, w: 0.25, h: 1 });
    assert.deepEqual(r.b, { x: 0.25, y: 0, w: 0.75, h: 1 });
    const c = rects(insert(leaf('a'), 'a', 'b', 'top'));
    assert.deepEqual(c.b, { x: 0, y: 0, w: 1, h: 0.5 });
    assert.deepEqual(c.a, { x: 0, y: 0.5, w: 1, h: 0.5 });
  });
  test('areas sum to 1 for an uneven nested tree', () => {
    let t = setRatio(grid(), [], 0.3);
    t = setRatio(t, ['a'], 0.7);
    t = setRatio(t, ['b'], 0.2);
    const all = rects(t);
    assert.equal(Object.keys(all).length, 4);
    near(Object.values(all).reduce((s, r) => s + r.w * r.h, 0), 1);
    near(all['2'].x, 0.3);
    near(all['3'].y, 0.7);
  });
});

describe('neighbor', () => {
  test('2x2 grid', () => {
    const g = grid();
    assert.equal(neighbor(g, '1', 'right'), '2');
    assert.equal(neighbor(g, '1', 'down'), '3');
    assert.equal(neighbor(g, '1', 'left'), null);
    assert.equal(neighbor(g, '1', 'up'), null);
    assert.equal(neighbor(g, '4', 'up'), '2');
    assert.equal(neighbor(g, '4', 'left'), '3');
    assert.equal(neighbor(g, '3', 'right'), '4');
    assert.equal(neighbor(g, '2', 'down'), '4');
  });
  test('unknown sid and single pane give null', () => {
    assert.equal(neighbor(grid(), 'zzz', 'left'), null);
    assert.equal(neighbor(leaf('a'), 'a', 'right'), null);
  });
});
