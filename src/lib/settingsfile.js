// settings.json: the user-editable mirror of `state.settings`. The file is nested and
// snake_case (appearance.terminal.font_size); the app keeps its flat camelCase keys. FIELDS
// maps one to the other and also drives validation and the generated JSON Schema.
// Settings not listed here (panel widths and the like) live only in state.json.

const FIELDS = [
  ['appearance.theme', 'termTheme', { values: ['system', 'dark', 'light'], desc: 'Terminal theme for Spaces without a custom background.' }],
  ['appearance.zoom_level', 'zoomLevel', { min: 50, max: 200, int: true, desc: 'Zoom for the whole window, in percent.' }],
  ['appearance.ui.font_family', 'uiFontFamily', { desc: 'Font for the interface (sidebar, bars, menus). "system-ui" is SF Pro on macOS.' }],
  ['appearance.ui.font_size', 'uiFontSize', { min: 10, max: 20, desc: 'Interface font size in px.' }],
  ['appearance.ui.line_height', 'uiLineHeight', { min: 1, max: 2, desc: 'Interface line height, as a multiple of the font size.' }],
  ['appearance.terminal.font_family', 'fontFamily', { desc: 'Terminal font. A comma-separated list works; SF Mono is the fallback.' }],
  ['appearance.terminal.font_size', 'fontSize', { min: 9, max: 28, desc: 'Terminal font size in pt. ⌘= / ⌘- change it too.' }],
  ['appearance.terminal.line_height', 'lineHeight', { min: 1, max: 2, desc: 'Terminal line height, as a multiple of the font size.' }],
  ['appearance.terminal.letter_spacing', 'letterSpacing', { min: -2, max: 4, desc: 'Extra space between characters, in px.' }],
  ['appearance.terminal.font_weight', 'fontWeight', { values: ['normal', '300', '400', '500', '600', '700'], desc: 'Weight of regular text.' }],
  ['appearance.terminal.font_weight_bold', 'fontWeightBold', { values: ['bold', '500', '600', '700', '800'], desc: 'Weight of bold text.' }],
  ['appearance.terminal.cursor_style', 'cursorStyle', { values: ['block', 'bar', 'underline'] }],
  ['appearance.terminal.cursor_blink', 'cursorBlink', {}],
  ['appearance.sidebar.mode', 'sidebarMode', { values: ['expanded', 'compact', 'hidden'] }],
  ['appearance.sidebar.width', 'sidebarWidth', { min: 200, max: 380, int: true, desc: 'Width of the expanded sidebar in px.' }],
  ['general.on_launch', 'onLaunch', { values: ['restore', 'fresh'], desc: '"fresh" starts with only pinned sessions.' }],
  ['general.new_terminal_dir', 'newTerminalDir', { values: ['current', 'space', 'home'], desc: 'Where new terminals start.' }],
  ['general.confirm_quit', 'confirmQuit', { desc: 'Ask before quitting while processes are running.' }],
  ['terminal.scrollback', 'scrollback', { min: 100, max: 200000, int: true, desc: 'Lines kept per session.' }],
  ['terminal.option_as_meta', 'optionAsMeta', { desc: 'Send ⌥ as Meta (Esc-prefixed keys) instead of typing special characters.' }],
  ['terminal.prompt', 'promptStyle', { values: ['termorc', 'shell'], desc: '"termorc": Termorc\'s input bar and command blocks. "shell": your shell\'s own prompt. Applies to new sessions.' }],
  ['terminal.welcome', 'terminalWelcome', { desc: 'Show the tips card in a new, empty session.' }],
  ['terminal.click_to_move', 'clickToMove', { desc: 'Click inside the command you are typing to move the cursor there.' }],
  ['terminal.shell_priority', 'shellPriority', { desc: 'Let the shell have Ctrl shortcuts that the app would otherwise take.' }],
  ['sessions.archive_after_hours', 'archiveAfterH', { min: 0, max: 8760, desc: 'Archive idle unpinned sessions after this many hours. 0 = never.' }],
  ['sessions.never_archive_running', 'neverArchiveRunning', {}],
  ['sessions.library_days', 'libraryDays', { min: 0, max: 3650, int: true, desc: 'Days of history kept in the Library. 0 = forever.' }],
  ['notifications.after_seconds', 'notifyAfterS', { min: 0, max: 86400, int: true, desc: 'Notify when a command runs longer than this. 0 = never.' }],
  ['notifications.os', 'osNotify', { values: ['always', 'background', 'never'], desc: 'When to also send a macOS notification.' }],
  ['gestures.swipe_spaces', 'gestures.swipeSpaces', { desc: 'Two-finger swipe switches Spaces.' }],
  ['gestures.pinch', 'gestures.pinch', { desc: 'Pinch opens the overview of all Spaces.' }],
  ['gestures.edge_reveal', 'gestures.edgeReveal', { desc: 'Hovering the left edge reveals a hidden sidebar.' }],
  ['gestures.peek', 'gestures.peek', { desc: 'Hovering a session previews it.' }],
].map(([path, key, opts]) => ({ path: path.split('.'), key: key.split('.'), ...opts }));

const get = (obj, keys) => keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);

function set(obj, keys, value) {
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

// Strips // and /* */ comments and trailing commas, leaving strings alone.
export function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const chunk = text.slice(i, end < 0 ? text.length : end + 2);
      out += chunk.replace(/[^\n]/g, ' '); // keep line numbers in parse errors
      i += chunk.length - 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function check(field, value, def) {
  const name = field.path.join('.');
  if (field.values) {
    const v = typeof value === 'number' ? String(value) : value;
    return field.values.includes(v) ? { value: v } : { value: def, error: `${name}: expected one of ${field.values.map((x) => `"${x}"`).join(', ')}` };
  }
  if (typeof def === 'boolean') return typeof value === 'boolean' ? { value } : { value: def, error: `${name}: expected true or false` };
  if (typeof def === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { value: def, error: `${name}: expected a number` };
    let v = field.int ? Math.round(value) : value;
    v = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, v));
    return v === value ? { value: v } : { value: v, error: `${name}: ${value} is out of range, using ${v} (${field.min}–${field.max})` };
  }
  return typeof value === 'string' && value.trim() ? { value: value.trim() } : { value: def, error: `${name}: expected a non-empty string` };
}

// Reports keys the app doesn't know, so typos don't fail silently.
function unknownKeys(obj, known, prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!prefix.length && (k === '$schema' || k === 'keybindings')) continue;
    const p = [...prefix, k];
    const id = p.join('.');
    if (v && typeof v === 'object' && !Array.isArray(v) && known.sections.has(id)) out.push(...unknownKeys(v, known, p));
    else if (!known.leaves.has(id)) out.push(`${id}: unknown setting`);
  }
  return out;
}

const KNOWN = {
  leaves: new Set(FIELDS.map((f) => f.path.join('.'))),
  sections: new Set(FIELDS.flatMap((f) => f.path.slice(0, -1).map((_, i) => f.path.slice(0, i + 1).join('.')))),
};

// Text → the settings it describes. Missing keys get their default, invalid ones fall back
// (numbers are clamped) and are listed in `warnings`. A syntax error returns `error` only.
export function parseSettingsFile(text, defaults) {
  let obj;
  try {
    obj = JSON.parse(stripJsonc(text));
  } catch (e) {
    return { error: e.message };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'The file must contain a JSON object { … }' };
  const settings = { gestures: { ...defaults.gestures } };
  const warnings = unknownKeys(obj, KNOWN);
  for (const f of FIELDS) {
    const def = get(defaults, f.key);
    const raw = get(obj, f.path);
    if (raw === undefined) {
      set(settings, f.key, def);
      continue;
    }
    const r = check(f, raw, def);
    set(settings, f.key, r.value);
    if (r.error) warnings.push(r.error);
  }
  const kb = obj.keybindings;
  settings.keybindings = { ...defaults.keybindings };
  if (kb !== undefined && (typeof kb !== 'object' || Array.isArray(kb) || kb === null)) warnings.push('keybindings: expected an object of "action": "Shortcut"');
  else if (kb) {
    for (const [action, accel] of Object.entries(kb)) {
      if (!(action in defaults.keybindings)) warnings.push(`keybindings.${action}: unknown action`);
      else if (typeof accel !== 'string') warnings.push(`keybindings.${action}: expected a shortcut like "Cmd+T", or "" to turn it off`);
      else settings.keybindings[action] = accel.trim();
    }
  }
  return { settings, warnings };
}

export function settingsToFile(settings, schemaUrl) {
  const out = schemaUrl ? { $schema: schemaUrl } : {};
  for (const f of FIELDS) set(out, f.path, get(settings, f.key));
  out.keybindings = { ...settings.keybindings };
  return JSON.stringify(out, null, 2) + '\n';
}

// JSON Schema (draft-07) for editors: completion, hover docs and squiggles for bad values.
export function settingsSchema(defaults, actions = []) {
  const root = { $schema: 'http://json-schema.org/draft-07/schema#', title: 'Termorc settings', type: 'object', properties: { $schema: { type: 'string' } }, additionalProperties: false };
  for (const f of FIELDS) {
    let node = root;
    for (const k of f.path.slice(0, -1)) {
      node.properties[k] ??= { type: 'object', properties: {}, additionalProperties: false };
      node = node.properties[k];
    }
    const def = get(defaults, f.key);
    const leaf = { default: def };
    if (f.desc) leaf.description = f.desc;
    if (f.values) leaf.enum = f.values;
    else if (typeof def === 'boolean') leaf.type = 'boolean';
    else if (typeof def === 'number') Object.assign(leaf, { type: f.int ? 'integer' : 'number', minimum: f.min, maximum: f.max });
    else leaf.type = 'string';
    node.properties[f.path.at(-1)] = leaf;
  }
  root.properties.keybindings = {
    type: 'object',
    description: 'Shortcuts as Electron accelerators ("Shift+Cmd+D"). Use "" to turn one off.',
    properties: Object.fromEntries(actions.map((a) => [a.id, { type: 'string', description: a.label, default: a.def }])),
    additionalProperties: false,
  };
  return JSON.stringify(root, null, 2) + '\n';
}
