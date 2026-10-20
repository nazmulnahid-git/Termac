import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { parseBlocks, parseInline, toggleTask } from '../src/lib/markdown.js';

const MODULE_URL = new URL('../src/lib/markdown.js', import.meta.url).href;

// Runs parseBlocks in a worker so an infinite loop fails the test instead of hanging the run.
function parseWithTimeout(src, ms = 2000) {
  return new Promise((resolve, reject) => {
    const w = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       import(workerData.url).then((m) => parentPort.postMessage(m.parseBlocks(workerData.src)));`,
      { eval: true, workerData: { url: MODULE_URL, src } },
    );
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error(`parseBlocks did not return within ${ms}ms for ${JSON.stringify(src)}`));
    }, ms);
    w.once('message', (v) => {
      clearTimeout(timer);
      w.terminate();
      resolve(v);
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe('parseBlocks', () => {
  test('headings h1-h3 with line numbers', () => {
    assert.deepEqual(parseBlocks('# One\n## Two\n### Three'), [
      { type: 'heading', level: 1, text: 'One', line: 0 },
      { type: 'heading', level: 2, text: 'Two', line: 1 },
      { type: 'heading', level: 3, text: 'Three', line: 2 },
    ]);
  });
  test('#### and #nospace are not headings', () => {
    assert.deepEqual(parseBlocks('#### Four'), [{ type: 'para', text: '#### Four', line: 0 }]);
    assert.deepEqual(parseBlocks('#tag'), [{ type: 'para', text: '#tag', line: 0 }]);
  });
  test('tasks: open, done (x / X), indented, * marker', () => {
    assert.deepEqual(parseBlocks('- [ ] todo\n- [x] done\n* [X] Done too\n  - [ ] nested'), [
      { type: 'task', done: false, text: 'todo', line: 0 },
      { type: 'task', done: true, text: 'done', line: 1 },
      { type: 'task', done: true, text: 'Done too', line: 2 },
      { type: 'task', done: false, text: 'nested', line: 3 },
    ]);
  });
  test('bullets', () => {
    assert.deepEqual(parseBlocks('- one\n* two\n  - three'), [
      { type: 'bullet', text: 'one', line: 0 },
      { type: 'bullet', text: 'two', line: 1 },
      { type: 'bullet', text: 'three', line: 2 },
    ]);
  });
  test('fenced code keeps content verbatim, including markdown-looking lines', () => {
    const src = 'intro\n```js\nconst a = 1;\n# not a heading\n- not a bullet\n```\nafter';
    assert.deepEqual(parseBlocks(src), [
      { type: 'para', text: 'intro', line: 0 },
      { type: 'code', lang: 'js', text: 'const a = 1;\n# not a heading\n- not a bullet', line: 1 },
      { type: 'para', text: 'after', line: 6 },
    ]);
  });
  test('fence without language, and unterminated fence runs to the end', () => {
    assert.deepEqual(parseBlocks('```\nx\n```'), [{ type: 'code', lang: '', text: 'x', line: 0 }]);
    assert.deepEqual(parseBlocks('```sh\nls\npwd'), [{ type: 'code', lang: 'sh', text: 'ls\npwd', line: 0 }]);
  });
  test('paste provenance with {sid:mark}', () => {
    const src = '> pasted from api (ssh web-01) {s1abc:42}\n> line one\n>line two\nafter';
    assert.deepEqual(parseBlocks(src), [
      { type: 'paste', source: 'api (ssh web-01)', sessionId: 's1abc', mark: 42, text: 'line one\nline two', line: 0 },
      { type: 'para', text: 'after', line: 3 },
    ]);
  });
  test('paste provenance without {sid:mark}', () => {
    assert.deepEqual(parseBlocks('> pasted from ~/work\n> out'), [
      { type: 'paste', source: '~/work', sessionId: null, mark: null, text: 'out', line: 0 },
    ]);
  });
  test('paste provenance with {sid} only', () => {
    assert.deepEqual(parseBlocks('> pasted from web-01 {s9}\n> out'), [
      { type: 'paste', source: 'web-01', sessionId: 's9', mark: null, text: 'out', line: 0 },
    ]);
  });
  test('paragraphs join wrapped lines and stop at blank lines and other blocks', () => {
    const src = 'hello\nworld\n\nsecond para\n- bullet\nthird\n# Head';
    assert.deepEqual(parseBlocks(src), [
      { type: 'para', text: 'hello world', line: 0 },
      { type: 'para', text: 'second para', line: 3 },
      { type: 'bullet', text: 'bullet', line: 4 },
      { type: 'para', text: 'third', line: 5 },
      { type: 'heading', level: 1, text: 'Head', line: 6 },
    ]);
  });
  test('empty and whitespace-only input', () => {
    assert.deepEqual(parseBlocks(''), []);
    assert.deepEqual(parseBlocks('\n  \n\n'), []);
  });

  // Lines that the paragraph loop refuses to consume but no block rule accepts used to
  // make parseBlocks spin forever. It must always terminate and keep the text.
  for (const src of ['```c++\nint x;\n```', '> pasted from', '- item\r\n- two\r\n', '# Title\r\nbody\r\n']) {
    test(`terminates on ${JSON.stringify(src)}`, async () => {
      const blocks = await parseWithTimeout(src);
      assert.ok(Array.isArray(blocks));
      assert.ok(blocks.length > 0);
      assert.ok(blocks.every((b) => b.type !== 'para' || b.text !== ''), 'no empty paragraphs');
    });
  }
});

describe('toggleTask', () => {
  const src = '# List\n- [ ] a\n- [x] b\n- [X] c';
  test('open → done', () => {
    assert.equal(toggleTask(src, 1), '# List\n- [x] a\n- [x] b\n- [X] c');
  });
  test('done (x or X) → open', () => {
    assert.equal(toggleTask(src, 2), '# List\n- [ ] a\n- [ ] b\n- [X] c');
    assert.equal(toggleTask(src, 3), '# List\n- [ ] a\n- [x] b\n- [ ] c');
  });
  test('only the first checkbox on the line is toggled', () => {
    assert.equal(toggleTask('- [ ] see [x] here', 0), '- [x] see [x] here');
  });
  test('round-trips with parseBlocks line numbers', () => {
    const task = parseBlocks(src).find((b) => b.type === 'task' && b.text === 'a');
    const next = toggleTask(src, task.line);
    assert.equal(parseBlocks(next).find((b) => b.text === 'a').done, true);
  });
});

describe('parseInline', () => {
  test('plain text', () => {
    assert.deepEqual(parseInline('hello'), [{ t: 'text', v: 'hello' }]);
    assert.deepEqual(parseInline(''), []);
  });
  test('code and bold spans', () => {
    assert.deepEqual(parseInline('run `npm test` **now** please'), [
      { t: 'text', v: 'run ' },
      { t: 'code', v: 'npm test' },
      { t: 'text', v: ' ' },
      { t: 'bold', v: 'now' },
      { t: 'text', v: ' please' },
    ]);
  });
  test('spans at the edges', () => {
    assert.deepEqual(parseInline('`a`**b**'), [
      { t: 'code', v: 'a' },
      { t: 'bold', v: 'b' },
    ]);
  });
  test('bold markers inside code stay literal', () => {
    assert.deepEqual(parseInline('`**x**`'), [{ t: 'code', v: '**x**' }]);
  });
  test('unmatched markers are text', () => {
    assert.deepEqual(parseInline('a ` b ** c'), [{ t: 'text', v: 'a ` b ** c' }]);
  });
});
