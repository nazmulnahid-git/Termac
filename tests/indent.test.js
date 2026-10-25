import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIndent } from '../src/lib/indent.js';

test('detects the indentation a file already uses', () => {
  assert.deepEqual(detectIndent('a\n  b\n    c\n  d'), { tabs: false, size: 2 });
  assert.deepEqual(detectIndent('a\n    b\n        c'), { tabs: false, size: 4 });
  assert.deepEqual(detectIndent('a\n\tb\n\t\tc\n  d'), { tabs: true, size: 4 });
  assert.deepEqual(detectIndent('no indentation'), { tabs: false, size: 2 });
});
