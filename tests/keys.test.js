import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, defaultBindings, eventToAccel, normalizeAccel, formatAccel, buildKeymap, isShellKey } from '../src/lib/keys.js';

const ev = (o) => ({ shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, code: '', key: '', ...o });

describe('eventToAccel', () => {
  test('letters via code with modifiers in canonical order', () => {
    assert.equal(eventToAccel(ev({ code: 'KeyD', key: 'd', metaKey: true, shiftKey: true })), 'Shift+Cmd+D');
    assert.equal(eventToAccel(ev({ code: 'KeyT', key: 't', metaKey: true })), 'Cmd+T');
    assert.equal(eventToAccel(ev({ code: 'KeyK', key: 'k', metaKey: true, altKey: true, ctrlKey: true, shiftKey: true })), 'Shift+Ctrl+Alt+Cmd+K');
  });
  test('Alt+Space uses code, not the nbsp key value', () => {
    assert.equal(eventToAccel(ev({ code: 'Space', key: ' ', altKey: true })), 'Alt+Space');
  });
  test('Option-modified letters keep the physical key', () => {
    assert.equal(eventToAccel(ev({ code: 'KeyD', key: '∂', altKey: true, metaKey: true })), 'Alt+Cmd+D');
  });
  test('digits and punctuation via code', () => {
    assert.equal(eventToAccel(ev({ code: 'Digit1', key: '!', shiftKey: true, metaKey: true })), 'Shift+Cmd+1');
    assert.equal(eventToAccel(ev({ code: 'Comma', key: ',', metaKey: true })), 'Cmd+,');
    assert.equal(eventToAccel(ev({ code: 'BracketLeft', key: '{', shiftKey: true, metaKey: true })), 'Shift+Cmd+[');
    assert.equal(eventToAccel(ev({ code: 'Equal', key: '=', metaKey: true })), 'Cmd+=');
    assert.equal(eventToAccel(ev({ code: 'Minus', key: '-', metaKey: true })), 'Cmd+-');
  });
  test('named keys', () => {
    assert.equal(eventToAccel(ev({ code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: true })), 'Ctrl+Left');
    assert.equal(eventToAccel(ev({ code: 'ArrowDown', key: 'ArrowDown', altKey: true, metaKey: true })), 'Alt+Cmd+Down');
    assert.equal(eventToAccel(ev({ code: 'Escape', key: 'Escape' })), 'Esc');
    assert.equal(eventToAccel(ev({ code: 'Enter', key: 'Enter', metaKey: true })), 'Cmd+Enter');
    assert.equal(eventToAccel(ev({ code: 'F5', key: 'F5' })), 'F5');
  });
  test('falls back to key when code is missing', () => {
    assert.equal(eventToAccel({ key: 'a', metaKey: true }), 'Cmd+A');
  });
  test('modifier-only presses return null', () => {
    for (const key of ['Meta', 'Shift', 'Control', 'Alt']) assert.equal(eventToAccel(ev({ key, code: key + 'Left', shiftKey: key === 'Shift' })), null);
  });
  test('round-trips through normalizeAccel for every default binding shape', () => {
    assert.equal(normalizeAccel(eventToAccel(ev({ code: 'KeyD', key: 'd', metaKey: true, shiftKey: true }))), 'Shift+Cmd+D');
  });
});

describe('normalizeAccel', () => {
  test('aliases', () => {
    assert.equal(normalizeAccel('CommandOrControl+N'), 'Cmd+N');
    assert.equal(normalizeAccel('CmdOrCtrl+N'), 'Cmd+N');
    assert.equal(normalizeAccel('Command+N'), 'Cmd+N');
    assert.equal(normalizeAccel('Meta+N'), 'Cmd+N');
    assert.equal(normalizeAccel('Control+Left'), 'Ctrl+Left');
    assert.equal(normalizeAccel('Option+Space'), 'Alt+Space');
  });
  test('orders modifiers Shift, Ctrl, Alt, Cmd and uppercases single-char keys', () => {
    assert.equal(normalizeAccel('Cmd+Shift+d'), 'Shift+Cmd+D');
    assert.equal(normalizeAccel('Cmd+Alt+Ctrl+Shift+x'), 'Shift+Ctrl+Alt+Cmd+X');
    assert.equal(normalizeAccel('Command+Option+Left'), 'Alt+Cmd+Left');
  });
  test('empty input', () => {
    assert.equal(normalizeAccel(''), '');
    assert.equal(normalizeAccel(undefined), '');
  });
  test('is idempotent on defaults', () => {
    for (const a of ACTIONS) assert.equal(normalizeAccel(normalizeAccel(a.def)), normalizeAccel(a.def));
  });
});

describe('formatAccel', () => {
  test('mac glyphs in ⌃⌥⇧⌘ order', () => {
    assert.equal(formatAccel('Shift+Cmd+D'), '⇧⌘D');
    assert.equal(formatAccel('Cmd+Shift+D'), '⇧⌘D');
    assert.equal(formatAccel('Cmd+T'), '⌘T');
    assert.equal(formatAccel('Ctrl+Left'), '⌃←');
    assert.equal(formatAccel('Alt+Cmd+Up'), '⌥⌘↑');
    assert.equal(formatAccel('Shift+Ctrl+Alt+Cmd+K'), '⌃⌥⇧⌘K');
  });
  test('special keys', () => {
    assert.equal(formatAccel('Alt+Space'), '⌥ Space');
    assert.equal(formatAccel('Cmd+Enter'), '⌘↵');
    assert.equal(formatAccel('Esc'), 'esc');
    assert.equal(formatAccel('Cmd+,'), '⌘,');
  });
  test('empty input', () => {
    assert.equal(formatAccel(''), '');
  });
});

describe('buildKeymap', () => {
  test('maps normalized accelerators to action ids and skips global actions', () => {
    const map = buildKeymap(defaultBindings());
    const globals = ACTIONS.filter((a) => a.global);
    assert.ok(globals.length > 0);
    assert.equal(map.size, ACTIONS.length - globals.length);
    assert.equal(map.get('Shift+Cmd+D'), 'splitDown');
    assert.equal(map.get('Cmd+D'), 'splitRight');
    assert.equal(map.get('Alt+Space'), undefined);
    for (const id of map.values()) assert.ok(!globals.some((g) => g.id === id));
  });
  test('normalizes user bindings and skips unbound actions', () => {
    const map = buildKeymap({ splitDown: 'Command+Shift+x', splitRight: '' });
    assert.equal(map.get('Shift+Cmd+X'), 'splitDown');
    assert.equal(map.size, 1);
  });
  test('defaultBindings covers every action', () => {
    const b = defaultBindings();
    for (const a of ACTIONS) assert.equal(b[a.id], a.def);
  });
});

describe('isShellKey', () => {
  test('Ctrl/Alt-led accelerators belong to the shell', () => {
    assert.equal(isShellKey('Ctrl+A'), true);
    assert.equal(isShellKey('Alt+B'), true);
    assert.equal(isShellKey('Cmd+K'), false);
    assert.equal(isShellKey('Shift+Cmd+D'), false);
  });
});
