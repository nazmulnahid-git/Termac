import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripJsonc, parseSettingsFile, settingsToFile, settingsSchema } from '../src/lib/settingsfile.js';
import { ACTIONS, defaultBindings } from '../src/lib/keys.js';

const DEFAULTS = {
  termTheme: 'system',
  zoomLevel: 100,
  uiFontFamily: 'system-ui',
  uiFontSize: 13.5,
  uiLineHeight: 1.45,
  fontFamily: 'SF Mono, Menlo, monospace',
  fontSize: 13,
  lineHeight: 1.4,
  letterSpacing: 0,
  fontWeight: 'normal',
  fontWeightBold: '600',
  cursorStyle: 'block',
  cursorBlink: true,
  sidebarMode: 'expanded',
  onLaunch: 'restore',
  newTerminalDir: 'current',
  confirmQuit: true,
  scrollback: 10000,
  optionAsMeta: false,
  clickToMove: true,
  promptStyle: 'termorc',
  terminalWelcome: true,
  shellPriority: false,
  archiveAfterH: 12,
  neverArchiveRunning: true,
  libraryDays: 90,
  notifyAfterS: 30,
  osNotify: 'background',
  gestures: { swipeSpaces: true, pinch: true, edgeReveal: true, peek: true },
  keybindings: defaultBindings(),
};

describe('stripJsonc', () => {
  test('drops comments and trailing commas but not slashes inside strings', () => {
    const text = '{\n  // note\n  "a": "http://x/*y*/", /* block */\n  "b": [1, 2,],\n}';
    assert.deepEqual(JSON.parse(stripJsonc(text)), { a: 'http://x/*y*/', b: [1, 2] });
  });
  test('keeps escaped quotes inside strings', () => {
    assert.deepEqual(JSON.parse(stripJsonc('{"a": "say \\"hi\\" // not a comment"}')), { a: 'say "hi" // not a comment' });
  });
});

describe('parseSettingsFile', () => {
  test('round-trips the defaults', () => {
    const r = parseSettingsFile(settingsToFile(DEFAULTS), DEFAULTS);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.settings, DEFAULTS);
  });

  test('maps nested snake_case keys and fills the rest with defaults', () => {
    const r = parseSettingsFile('{ "appearance": { "ui": { "font_size": 15 }, "terminal": { "font_weight": 500 } }, "gestures": { "pinch": false } }', DEFAULTS);
    assert.equal(r.settings.uiFontSize, 15);
    assert.equal(r.settings.fontWeight, '500');
    assert.equal(r.settings.gestures.pinch, false);
    assert.equal(r.settings.gestures.peek, true);
    assert.equal(r.settings.fontSize, 13);
  });

  test('clamps out-of-range numbers and rejects wrong types with warnings', () => {
    const r = parseSettingsFile('{ "appearance": { "terminal": { "font_size": 99, "cursor_style": "beam", "cursor_blink": "yes" } } }', DEFAULTS);
    assert.equal(r.settings.fontSize, 28);
    assert.equal(r.settings.cursorStyle, 'block');
    assert.equal(r.settings.cursorBlink, true);
    assert.equal(r.warnings.length, 3);
  });

  test('reports unknown keys and actions', () => {
    const r = parseSettingsFile('{ "appearance": { "fnt_size": 3 }, "keybindings": { "nope": "Cmd+X", "commandBar": "Cmd+K" } }', DEFAULTS);
    assert.deepEqual(r.warnings, ['appearance.fnt_size: unknown setting', 'keybindings.nope: unknown action']);
    assert.equal(r.settings.keybindings.commandBar, 'Cmd+K');
  });

  test('drops shortcuts of removed features without a warning', () => {
    const r = parseSettingsFile('{ "keybindings": { "toggleReview": "Shift+Cmd+G", "notes": "Shift+Cmd+N" } }', DEFAULTS);
    assert.deepEqual(r.warnings, []);
    assert.equal('toggleReview' in r.settings.keybindings, false);
  });

  test('a syntax error returns only the error', () => {
    const r = parseSettingsFile('{ "appearance": ', DEFAULTS);
    assert.ok(r.error);
    assert.equal(r.settings, undefined);
  });
});

describe('settingsSchema', () => {
  test('describes every section and keybinding', () => {
    const schema = JSON.parse(settingsSchema(DEFAULTS, ACTIONS));
    assert.equal(schema.properties.appearance.properties.terminal.properties.font_size.maximum, 28);
    assert.deepEqual(schema.properties.appearance.properties.theme.enum, ['system', 'dark', 'light']);
    assert.equal(Object.keys(schema.properties.keybindings.properties).length, ACTIONS.length);
  });
});
