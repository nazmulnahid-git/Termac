// The code editor inside the file viewer (CodeMirror 6): syntax colors for most languages
// (loaded on demand from the file name), search and replace, multiple cursors, bracket
// matching, folding and undo. ⌘S saves. Colors come from the app's --hl-* variables, so it
// follows light and dark like the rest of the chrome.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxHighlighting, HighlightStyle, indentUnit, LanguageDescription } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { languages } from '@codemirror/language-data';
import { tags as t } from '@lezer/highlight';
import { detectIndent } from '../lib/indent.js';

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], color: 'var(--hl-kw)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--hl-str)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--hl-num)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--hl-com)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--hl-fn)' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.annotation], color: 'var(--hl-type)' },
  { tag: [t.attributeName, t.propertyName], color: 'var(--hl-fn)', opacity: 0.9 },
  { tag: [t.heading], color: 'var(--hl-kw)', fontWeight: 'bold' },
  { tag: [t.link, t.url], color: 'var(--hl-fn)', textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: 'bold' },
  { tag: [t.invalid], color: 'var(--fail)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--dim)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', background: 'var(--panel)', color: 'var(--ink)', fontSize: 'var(--ed-font)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', overscrollBehavior: 'contain' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0 40vh' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { background: 'color-mix(in oklab, var(--accent) 26%, transparent) !important' },
  '.cm-gutters': { background: 'var(--panel)', color: 'var(--faint)', border: 'none', paddingLeft: '6px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 14px 0 8px', minWidth: '3ch' },
  '.cm-activeLine': { background: 'color-mix(in oklab, var(--ink) 4%, transparent)' },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--ink)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--faint)', cursor: 'pointer' },
  '.cm-matchingBracket': { background: 'color-mix(in oklab, var(--accent) 22%, transparent)', outline: '1px solid color-mix(in oklab, var(--accent) 50%, transparent)' },
  '.cm-selectionMatch': { background: 'color-mix(in oklab, var(--accent) 12%, transparent)' },
  '.cm-searchMatch': { background: 'color-mix(in oklab, var(--bell) 30%, transparent)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { background: 'color-mix(in oklab, var(--bell) 60%, transparent)' },
  '.cm-foldPlaceholder': { background: 'var(--sel)', border: 'none', color: 'var(--dim)', padding: '0 6px', borderRadius: '4px' },
  '.cm-panels': { background: 'var(--panel-2)', color: 'var(--ink)', borderColor: 'var(--panel-line)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--panel-line)' },
  '.cm-search': { padding: '8px 12px', fontFamily: 'var(--ui)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  '.cm-search br': { display: 'none' },
  '.cm-textfield': { height: '26px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--panel-line)', background: 'var(--input)', color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: 'inherit' },
  '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)' },
  '.cm-button': { height: '26px', padding: '0 10px', borderRadius: '6px', border: 'none', backgroundImage: 'none', background: 'var(--sel)', color: 'var(--ink)', fontFamily: 'var(--ui)', fontSize: 'inherit' },
  '.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--dim)' },
  '.cm-search [name=close]': { marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--dim)', fontSize: '18px', cursor: 'pointer' },
  '.cm-tooltip': { background: 'var(--panel)', border: 'none', borderRadius: '8px', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'color-mix(in oklab, var(--accent) 22%, transparent)', color: 'var(--ink)' },
});

export default function Editor({ path, text, line, readOnly, fontSize, onChange, onSave, onCursor, onLanguage }) {
  const host = useRef(null);
  const view = useRef(null);
  const handlers = useRef({});
  handlers.current = { onChange, onSave, onCursor };

  useLayoutEffect(() => {
    const lang = new Compartment();
    const indent = detectIndent(text);
    const state = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter({ openText: '⌄', closedText: '›' }),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(highlight),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: false }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        indentUnit.of(indent.tabs ? '\t' : ' '.repeat(indent.size)),
        EditorState.tabSize.of(indent.size),
        EditorState.readOnly.of(!!readOnly),
        lang.of([]),
        theme,
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: (v) => (handlers.current.onSave?.(v.state.doc.toString()), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.current.onChange?.(u.state.doc);
          if (u.selectionSet || u.docChanged) {
            const head = u.state.selection.main.head;
            const l = u.state.doc.lineAt(head);
            handlers.current.onCursor?.({ line: l.number, col: head - l.from + 1, selections: u.state.selection.ranges.length });
          }
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    onLanguage?.(null, indent);
    const desc = LanguageDescription.matchFilename(languages, path.split('/').pop());
    if (desc)
      desc.load().then((support) => {
        if (view.current !== v) return;
        v.dispatch({ effects: lang.reconfigure(support) });
        onLanguage?.(desc.name, indent);
      });
    if (line) {
      const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
      v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
    }
    v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [path, readOnly]);

  // A newer copy from disk (changed outside, no local edits): swap it in, keeping the cursor.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === text) return;
    const head = Math.min(v.state.selection.main.head, text.length);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: head } });
  }, [text]);

  return <div className="ed-host" ref={host} style={{ '--ed-font': `${fontSize}px` }} />;
}
