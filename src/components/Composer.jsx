// The input bar at the bottom of a session (Warp-style). While the shell waits at a prompt
// you type here: syntax colors, a grey suggestion from history (→ accepts), ↑/↓ recall,
// ⇥ completion, ⌃R history search, ⇧⏎ for a second line. ⏎ hands the command to the shell
// and the bar steps aside: keys go to the terminal until the next prompt. Full-screen apps
// (vim, htop) get the whole pane.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { app, rt } from '../state/model.js';
import * as A from '../state/actions.js';
import * as reg from '../term/registry.js';
import { tokenize, suggest, recallList, applyCompletion, commonPrefix } from '../lib/cmdline.js';
import { fuzzy } from '../lib/fuzzy.js';
import { formatAccel } from '../lib/keys.js';
import PaneChips from './PaneChips.jsx';
import { IconSpinner, IconCheckCircle, IconXCircle, IconSearch, LogoMark } from './icons.jsx';

const api = window.termac;

// One history for every session: the shell's history files, plus what was run here since.
let shellHistory = [];
let loaded = null;
const loadHistory = () => (loaded ??= api.shell.history().then((h) => (shellHistory = h || [])).catch(() => []));
function remember(cmd) {
  shellHistory = [cmd, ...shellHistory.filter((h) => h !== cmd)].slice(0, 5000);
}

export default function Composer({ sid, focused, cwd, home }) {
  const r = rt.use((s) => s[sid]) || {};
  const settings = app.use((s) => s.settings);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [popup, setPopup] = useState(null); // { kind: 'complete' | 'search', items, sel, start? }
  const recall = useRef(null); // { prefix, list, i, draft }
  const input = useRef(null);
  const [, bump] = useState(0);

  const mode = r.alt ? 'hidden' : r.atPrompt ? 'input' : r.status === 'run' ? 'running' : 'starting';
  const elapsed = useElapsed(mode === 'running' ? r.cmdStart : null);

  useEffect(() => {
    loadHistory().then(() => bump((n) => n + 1));
  }, []);
  useLayoutEffect(() => {
    reg.setComposer(sid, input.current);
    return () => reg.setComposer(sid, null);
  }, [sid, mode]);

  // Hand focus back and forth with the terminal as commands start and finish.
  useEffect(() => {
    if (!focused) return;
    const el = input.current;
    const term = reg.getHandle(sid)?.term;
    if (mode === 'input' && el && document.activeElement !== el && !document.activeElement?.closest?.('.overlay, .modal, .palette, .find-bar, .composer-popup')) {
      const inPane = !document.activeElement || document.activeElement === document.body || document.activeElement === term?.textarea;
      if (inPane) el.focus();
    } else if (mode === 'running' && document.activeElement === el) {
      reg.focus(sid);
    }
  }, [mode, focused, sid]);

  // Keys typed into the terminal at a prompt (or text the app inserts) land here.
  useEffect(() => {
    const onInput = (e) => {
      if (e.detail.sid !== sid) return;
      const d = e.detail.data;
      if (d === '\x03') return clear();
      if (d === '\r') return submit();
      if (/^[\x00-\x1f\x7f]/.test(d) && d.length < 8) return; // stray control keys
      const t = text.slice(0, caret) + d.replace(/\r\n?/g, '\n') + text.slice(caret);
      setText(t);
      setCaretSoon(caret + d.length);
      input.current?.focus();
    };
    window.addEventListener('composer-input', onInput);
    return () => window.removeEventListener('composer-input', onInput);
  });

  const setCaretSoon = (pos) => {
    setCaret(pos);
    requestAnimationFrame(() => input.current?.setSelectionRange(pos, pos));
  };
  const update = (t, pos = t.length) => {
    setText(t);
    setCaretSoon(pos);
  };
  const clear = () => {
    recall.current = null;
    setPopup(null);
    update('');
  };

  const atEnd = caret === text.length;
  const ghost = mode === 'input' && atEnd && !popup ? suggest(text, shellHistory) : '';
  const tokens = useMemo(() => tokenize(text), [text]);

  const submit = () => {
    const cmd = text.replace(/\s+$/, '');
    if (!cmd.trim() || mode !== 'input') return;
    if (!A.submitCommand(sid, cmd)) return;
    remember(cmd);
    clear();
  };

  const complete = async () => {
    const line = text.slice(0, caret);
    const res = await api.shell.complete(cwd, line);
    const items = res?.items || [];
    if (!items.length) return;
    if (items.length === 1) {
      const next = applyCompletion(text, caret, res.start, items[0]);
      return update(next.text, next.caret);
    }
    // Several: fill in what they share, then offer the list.
    const shared = commonPrefix(items.map((i) => i.value));
    const typed = [...line].slice(res.start).join('').replace(/\\ /g, ' ');
    let base = text;
    let pos = caret;
    if (shared.length > typed.length) {
      const next = applyCompletion(text, caret, res.start, { value: shared, kind: 'dir' });
      base = next.text;
      pos = next.caret;
      update(base, pos);
    }
    setPopup({ kind: 'complete', items, sel: 0, start: res.start, base, pos });
  };

  const openSearch = (query = text) => setPopup({ kind: 'search', query, sel: 0 });
  const searchItems = popup?.kind === 'search' ? rankHistory(popup.query) : null;
  const items = popup?.kind === 'search' ? searchItems : popup?.items || [];

  const pick = (i) => {
    const item = items[i];
    if (!item) return;
    if (popup.kind === 'search') update(item.value);
    else {
      const next = applyCompletion(popup.base, popup.pos, popup.start, item);
      update(next.text, next.caret);
    }
    setPopup(null);
    input.current?.focus();
  };

  const onKeyDown = (e) => {
    const el = e.currentTarget;
    const pos = el.selectionStart;
    const firstLine = !text.slice(0, pos).includes('\n');
    const lastLine = !text.slice(el.selectionEnd).includes('\n');

    if (popup) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (e.key === 'Tab' && popup.kind === 'complete')) {
        e.preventDefault();
        const step = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
        const n = Math.max(1, Math.min(items.length, 60));
        setPopup((p) => ({ ...p, sel: (p.sel + step + n) % n }));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        return pick(popup.sel);
      }
      if (e.key === 'Escape' || (e.key === 'c' && e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        return setPopup(null);
      }
      if (popup.kind === 'search') return; // the search box takes the other keys as typing
      setPopup(null);
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      return submit();
    }
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (ghost && atEnd) return update(text + ghost);
      return complete();
    }
    if ((e.key === 'ArrowRight' || (e.key === 'e' && e.ctrlKey) || e.key === 'End') && ghost && pos === text.length) {
      e.preventDefault();
      return update(text + ghost);
    }
    if (e.key === 'ArrowUp' && firstLine && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const rc = (recall.current ??= { prefix: text, list: recallList(text, shellHistory), i: -1, draft: text });
      if (rc.i + 1 < rc.list.length) {
        rc.i++;
        update(rc.list[rc.i]);
      }
      return;
    }
    if (e.key === 'ArrowDown' && lastLine && recall.current && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const rc = recall.current;
      rc.i--;
      if (rc.i < 0) {
        update(rc.draft);
        recall.current = null;
      } else update(rc.list[rc.i]);
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') return e.preventDefault(), clear();
      if (k === 'r') return e.preventDefault(), openSearch();
      if (k === 'l') return e.preventDefault(), reg.clear(sid);
      if (k === 'u') return e.preventDefault(), update(text.slice(pos), 0);
      if (k === 'd' && !text) return e.preventDefault(), api.pty.write(sid, '\x04');
    }
    if (e.key === 'Escape' && text) {
      e.preventDefault();
      e.stopPropagation();
      clear();
    }
  };

  if (mode === 'hidden') return null;
  const last = r.exitCode == null ? null : { ok: r.exitCode === 0 || r.exitCode === 130, code: r.exitCode, dur: r.duration };
  const welcome = mode !== 'running' && settings.terminalWelcome && reg.commandsOf(sid).length === 0 && isBlank(sid);
  const k = (id) => formatAccel(settings.keybindings[id] || '');

  return (
    <div className={`composer m-${mode}${focused ? ' focused' : ''}`} style={{ '--cp-font': `${settings.fontSize}px`, '--cp-lh': settings.lineHeight }}>
      {welcome && <Welcome k={k} />}
      {popup && items.length > 0 && <Popup popup={popup} items={items} onPick={pick} onHover={(sel) => setPopup((p) => ({ ...p, sel }))} />}
      {popup?.kind === 'search' && (
        <div className="cp-search">
          <IconSearch size={13} />
          <input autoFocus className="cp-search-input" value={popup.query} placeholder="Search history" onChange={(e) => setPopup((p) => ({ ...p, query: e.target.value, sel: 0 }))} onKeyDown={(e) => onKeyDown(e)} />
          <span className="cp-hint">⏎ insert · esc close</span>
        </div>
      )}

      <div className="cp-chips">
        <PaneChips sid={sid} r={r} cwd={cwd || home} />
        <span className="grow" />
        {mode !== 'running' && last && (
          <span className={`cp-last${last.ok ? '' : ' fail'}`} title={`Last command exited ${last.code}`}>
            {last.ok ? <IconCheckCircle size={12} /> : <IconXCircle size={12} />}
            {last.ok ? fmtDur(last.dur) : `exit ${last.code}`}
          </span>
        )}
      </div>
      {mode === 'running' ? (
        <div className="cp-running" onMouseDown={(e) => (e.preventDefault(), reg.focus(sid))}>
          <IconSpinner size={13} />
          <span className="cp-run-cmd ellipsis">{r.command || 'Running…'}</span>
          <span className="cp-run-time">{elapsed}</span>
          <span className="grow" />
          <button className="cp-stop" onMouseDown={(e) => e.stopPropagation()} onClick={() => api.pty.write(sid, '\x03')}>
            ⌃C Stop
          </button>
        </div>
      ) : (
        <div className="cp-editor" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), input.current?.focus())}>
          <pre className="cp-hl" aria-hidden="true">
            {tokens.map((t, i) => (
              <span key={i} className={`tk-${t.k}`}>
                {t.t}
              </span>
            ))}
            {ghost && <span className="cp-ghost">{ghost}</span>}
            {!text && <span className="cp-placeholder">{mode === 'starting' ? 'Starting shell…' : 'Run a command…'}</span>}
            {'\u200b'}
          </pre>
          <textarea
            ref={input}
            className="cp-input"
            rows={1}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            value={text}
            disabled={mode === 'starting'}
            onChange={(e) => {
              recall.current = null;
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              if (popup?.kind === 'complete') setPopup(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onFocus={() => A.focusSession(sid)}
          />
        </div>
      )}
      <div className="cp-foot">
        {mode === 'running' ? (
          <span>Keys go to the running program</span>
        ) : (
          <>
            <span>
              <kbd>⏎</kbd> run
            </span>
            <span>
              <kbd>⇧⏎</kbd> new line
            </span>
            <span>
              <kbd>↑</kbd> history
            </span>
            <span>
              <kbd>⇥</kbd> complete
            </span>
            <span>
              <kbd>⌃R</kbd> search
            </span>
          </>
        )}
        <span className="grow" />
        <span>
          <kbd>{k('commandBar')}</kbd> commands
        </span>
      </div>
    </div>
  );
}

function rankHistory(query) {
  const q = query.trim();
  if (!q) return shellHistory.slice(0, 50).map((value) => ({ value, label: value, kind: 'hist' }));
  const out = [];
  for (const h of shellHistory) {
    const m = fuzzy(q, h);
    if (m.score > 0) out.push({ value: h, label: h, kind: 'hist', score: m.score });
    if (out.length > 400) break;
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 50);
}

function Popup({ popup, items, onPick, onHover }) {
  const list = useRef(null);
  useEffect(() => {
    list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [popup.sel]);
  return (
    <div className="composer-popup" ref={list}>
      {items.slice(0, 60).map((it, i) => (
        <button key={`${it.value}:${i}`} className={`cp-item${i === popup.sel ? ' on' : ''}`} onMouseDown={(e) => (e.preventDefault(), onPick(i))} onMouseEnter={() => onHover(i)}>
          <span className={`cp-kind k-${it.kind}`}>{{ dir: '▸', file: '·', cmd: '$', branch: '⎇', hist: '↺' }[it.kind]}</span>
          <span className="ellipsis">{it.label || it.value}</span>
        </button>
      ))}
    </div>
  );
}

function Welcome({ k }) {
  return (
    <div className="cp-welcome">
      <div className="cp-welcome-title">
        <span className="cp-logo">
          <LogoMark size={20} />
        </span>
        New terminal session
      </div>
      <ul>
        <li>
          <kbd>{k('commandBar')}</kbd> jump anywhere: sessions, folders, SSH hosts, snippets
        </li>
        <li>
          <kbd>↑</kbd> cycle past commands, <kbd>⌃R</kbd> to search them
        </li>
        <li>
          <kbd>⇥</kbd> complete commands, paths and branches
        </li>
        <li>
          <kbd>{k('splitRight')}</kbd> split the pane
        </li>
      </ul>
      <button className="cp-welcome-hide" onClick={() => A.setSettings({ terminalWelcome: false })}>
        Don't show again
      </button>
    </div>
  );
}

// Nothing printed yet but the blank prompt line (a restored session has its scrollback).
function isBlank(sid) {
  const b = reg.getHandle(sid)?.term.buffer.active;
  if (!b || b.baseY > 0) return false;
  for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString(true).trim()) return false;
  return true;
}

function useElapsed(since) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? fmtDur(Math.max(0, now - since)) : '';
}

function fmtDur(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
