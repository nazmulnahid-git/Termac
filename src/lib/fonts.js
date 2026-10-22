// Font stacks for the chrome (sans) and for terminals and code (mono), and the CSS
// variables that carry them into the stylesheets.

const SANS_FALLBACK = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif";
const MONO_FALLBACK = "'SF Mono', Menlo, monospace";

// Quotes family names with spaces so they survive a CSS font shorthand.
const quote = (list) =>
  String(list || '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => (/^['"]/.test(f) || !/\s/.test(f) ? f : `'${f}'`))
    .join(', ');

export const uiStack = (family) => [quote(family), SANS_FALLBACK].filter(Boolean).join(', ');

export function monoStack(family) {
  const f = quote(family);
  return /monospace\s*$/.test(f) ? f : [f, MONO_FALLBACK].filter(Boolean).join(', ');
}

export function applyFontVars(settings, root = document.documentElement) {
  const st = root.style;
  st.setProperty('--ui', uiStack(settings.uiFontFamily));
  st.setProperty('--ui-size', `${settings.uiFontSize}px`);
  st.setProperty('--ui-lh', String(settings.uiLineHeight));
  st.setProperty('--mono', monoStack(settings.fontFamily));
  st.setProperty('--zoom', String(settings.zoomLevel / 100));
}
