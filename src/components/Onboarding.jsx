import '../styles/onboarding.css';
import { useEffect, useState } from 'react';
import { app, ui, newSpace } from '../state/model.js';
import * as A from '../state/actions.js';
import { SPACE_COLORS, uid } from '../lib/meta.js';
import { tildify } from '../lib/routing.js';
import { formatAccel } from '../lib/keys.js';
import { IconSearch, LogoMark } from './icons.jsx';

const api = window.termac;
const STEPS = ['welcome', 'import', 'spaces', 'tips'];
const FOLDER_NAMES = { work: 'Work', projects: 'Projects', side: 'Side Project', personal: 'Personal', developer: 'Developer', code: 'Code', dev: 'Dev', src: 'Code', repos: 'Repos', sites: 'Sites' };
const CARD_GLYPHS = ['◆', '●', '■', '✦', '☾', '♣', '★'];
const CARD_COLORS = [0, 1, 3, 4, 5, 6, 7].map((i) => SPACE_COLORS[i]); // green is kept for Servers

function card(fields, i) {
  return { key: uid('c'), name: 'New Space', glyph: CARD_GLYPHS[i % CARD_GLYPHS.length], color: CARD_COLORS[i % CARD_COLORS.length], startDir: '~', hosts: 0, on: true, ...fields };
}

function suggest({ folders = [], ssh = [] }, home) {
  const out = [];
  const names = new Set();
  for (const f of folders) {
    if (out.length >= 3) break;
    const base = f.split('/').pop();
    const name = FOLDER_NAMES[base.toLowerCase()] || base;
    if (names.has(name)) continue;
    names.add(name);
    const dir = tildify(f, home);
    out.push(card({ name, startDir: dir }, out.length));
  }
  if (ssh.length) out.push(card({ name: 'Servers', glyph: '▲', color: SPACE_COLORS[2], hosts: ssh.length }, out.length));
  if (!out.length) out.push(card({ name: 'Personal' }, 0));
  return out;
}

export default function Onboarding({ onDone }) {
  const [step, setStep] = useState(0);
  const [found, setFound] = useState(null);
  const [pick, setPick] = useState({ iterm: true, ssh: true });
  const [cards, setCards] = useState(null);

  useEffect(() => {
    let live = true;
    Promise.resolve(api.sys.detectImports())
      .catch(() => null)
      .then((r) => {
        if (!live) return;
        const f = { ssh: r?.ssh || [], iterm: r?.iterm || [], folders: r?.folders || [] };
        setFound(f);
        setCards(suggest(f, r?.home || ui.get().home));
      });
    return () => (live = false);
  }, []);

  const skipAll = () => {
    app.set((s) => ({ ...s, onboarded: true }));
    onDone?.();
  };

  const finish = () => {
    const s = app.get();
    const chosen = (cards || []).filter((c) => c.on);
    const spaces = chosen.map((c) => newSpace({ name: c.name.trim() || 'Space', glyph: c.glyph, color: c.color, startDir: c.startDir || '~' }));
    const taken = new Set(s.profiles.map((p) => p.name));
    const imported = pick.iterm
      ? (found?.iterm || [])
          .filter((p) => !taken.has(p.name))
          .map((p) => ({ id: uid('p'), name: p.name, command: p.command || '', cwdMode: p.cwd ? 'custom' : 'space', cwd: p.cwd || '', env: [], startup: '' }))
      : [];
    if (!spaces.length) return skipAll();
    const kept = s.spaces.filter((sp) => A.tabsOfSpace(sp).length);
    app.set((st) => ({ ...st, spaces: [...kept, ...spaces], activeSpaceId: spaces[0].id, profiles: [...st.profiles, ...imported], onboarded: true }));
    A.switchSpace(spaces[0].id); // re-syncs focus when kept Spaces had sessions
    onDone?.();
  };

  const name = STEPS[step];
  return (
    <div className="ob">
      <div className="ob-top">
        {step > 0 && (
          <span className="ob-bars">
            {[1, 2, 3].map((i) => (
              <i key={i} className={i <= step ? 'on' : ''} />
            ))}
          </span>
        )}
      </div>
      {name === 'welcome' && <Welcome onNext={() => setStep(1)} onSkip={skipAll} />}
      {name === 'import' && <Import found={found} pick={pick} setPick={setPick} onBack={() => setStep(0)} onSkip={() => (setPick({ iterm: false, ssh: false }), setStep(2))} onNext={() => setStep(2)} />}
      {name === 'spaces' && <Spaces cards={cards} setCards={setCards} sshCount={found?.ssh.length || 0} onBack={() => setStep(1)} onNext={() => setStep(3)} />}
      {name === 'tips' && <Tips onBack={() => setStep(2)} onDone={finish} />}
    </div>
  );
}

function Foot({ onBack, onSkip, children }) {
  return (
    <div className="ob-foot">
      {onBack && (
        <button className="ob-link" onClick={onBack}>
          Back
        </button>
      )}
      <span className="grow" />
      {onSkip && (
        <button className="ob-link" onClick={onSkip}>
          Skip
        </button>
      )}
      {children}
    </div>
  );
}

function Welcome({ onNext, onSkip }) {
  return (
    <>
      <div className="ob-body ob-welcome">
        <div className="ob-hero">
          <div className="ob-logo">
            <LogoMark size={40} />
          </div>
          <h1>Welcome to Termorc</h1>
          <p>Terminals that live in a sidebar, sorted into Spaces, and tidy themselves up.</p>
          <div className="row-inline">
            <button className="btn primary ob-big" onClick={onNext} autoFocus>
              Get started
            </button>
            <span className="dim ob-small">Takes about a minute</span>
          </div>
        </div>
        <MockSidebar />
      </div>
      <Foot onSkip={onSkip} />
    </>
  );
}

const MOCK_ROWS = [
  ['js', 'shell-app', 'idle'],
  ['js', 'vitest run', 'fail', true],
  ['py', 'pytest -k auth', 'ok'],
  ['db', 'migrations', 'idle'],
];
const MOCK_TODAY = [
  ['dk', 'docker build', 'run'],
  ['>_', 'brew upgrade', 'ok'],
  ['ssh', 'ssh bastion', 'idle'],
];

function MockRow({ kind, name, status, on }) {
  return (
    <div className={`row${on ? ' on' : ''}`}>
      <span className="chip">{kind}</span>
      <span className="name">{name}</span>
      {status === 'fail' ? <span className="status st-fail">!</span> : status === 'ok' ? <span className="status st-ok">✓</span> : status === 'run' ? <span className="status st-run" /> : <span className="status st-idle" />}
    </div>
  );
}

function MockSidebar() {
  return (
    <div className="ob-mock" aria-hidden>
      <div className="sec-title">
        <span className="glyph">◆</span>
        <span className="grow">Work</span>
      </div>
      <div className="rows">
        {MOCK_ROWS.map(([k, n, s, on]) => (
          <MockRow key={n} kind={k} name={n} status={s} on={on} />
        ))}
      </div>
      <div className="today-head">
        Today <span className="rule" />
      </div>
      <div className="rows">
        {MOCK_TODAY.map(([k, n, s]) => (
          <MockRow key={n} kind={k} name={n} status={s} />
        ))}
      </div>
    </div>
  );
}

function Import({ found, pick, setPick, onBack, onSkip, onNext }) {
  const sources = [];
  if (found?.iterm.length) {
    const n = found.iterm.length;
    sources.push({ id: 'iterm', icon: '$_', title: 'iTerm2', sub: `${n} profile${n > 1 ? 's' : ''} · ${found.iterm.slice(0, 3).map((p) => p.name).join(', ')}${n > 3 ? '…' : ''}`, meta: '→ Termorc profiles' });
  }
  if (found?.ssh.length) {
    const n = found.ssh.length;
    sources.push({ id: 'ssh', icon: 'ssh', title: '~/.ssh/config', sub: `${n} host${n > 1 ? 's' : ''} · ${found.ssh.slice(0, 4).map((h) => h.alias).join(', ')}${n > 4 ? '…' : ''}`, meta: 'Read-only', mono: true });
  }
  const count = sources.filter((s) => pick[s.id]).length;
  return (
    <>
      <div className="ob-body">
        <h2>Bring your setup with you</h2>
        <p className="ob-lead">We looked for these on your Mac. Profiles become Termorc profiles; SSH hosts show up in the command bar.</p>
        {!found ? (
          <div className="ob-empty dim">Looking around…</div>
        ) : sources.length ? (
          <div className="ob-list">
            {sources.map((s) => (
              <label key={s.id} className="ob-src">
                <input type="checkbox" checked={!!pick[s.id]} onChange={(e) => setPick((p) => ({ ...p, [s.id]: e.target.checked }))} />
                <span className="ob-icon">{s.icon}</span>
                <span className="grow">
                  <span className="ob-src-title">{s.title}</span>
                  <span className={`ob-src-sub ellipsis${s.mono ? ' mono' : ''}`}>{s.sub}</span>
                </span>
                <span className="dim ob-small">{s.meta}</span>
              </label>
            ))}
          </div>
        ) : (
          <div className="ob-empty dim">Nothing to import — you can add profiles later in Settings.</div>
        )}
      </div>
      <Foot onBack={onBack} onSkip={sources.length ? onSkip : null}>
        <button className="btn primary" onClick={onNext} disabled={!found}>
          {count ? `Import ${count} source${count > 1 ? 's' : ''}` : 'Continue'}
        </button>
      </Foot>
    </>
  );
}

function Spaces({ cards, setCards, sshCount, onBack, onNext }) {
  const list = cards || [];
  const n = list.filter((c) => c.on).length;
  const update = (key, patch) => setCards((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const toggle = (c) => {
    if (c.on && n <= 1) return; // always keep at least one Space
    update(c.key, { on: !c.on });
  };
  const add = () => setCards((cs) => [...cs, card({ fresh: true }, cs.length)]);

  return (
    <>
      <div className="ob-body">
        <h2>Make a Space for each part of your life</h2>
        <p className="ob-lead">Each Space gets its own color, pinned sessions and start directory.{list.length > 1 ? ' We suggested a few from your folders' + (sshCount ? ' and SSH hosts.' : '.') : ''}</p>
        <div className="ob-cards">
          {list.map((c) => (
            <div key={c.key} className={`ob-card${c.on ? ' on' : ''}`} style={{ '--c': c.color }} onClick={() => toggle(c)}>
              <div className="ob-card-top">
                <span className="ob-glyph">{c.glyph}</span>
                <span className="ob-check">{c.on ? '✓' : ''}</span>
              </div>
              <div className="ob-card-body">
                <input className="ob-name" value={c.name} autoFocus={c.fresh} spellCheck={false} onClick={(e) => e.stopPropagation()} onFocus={(e) => e.target.select()} onChange={(e) => update(c.key, { name: e.target.value })} />
                <div className="ob-meta mono ellipsis">{c.hosts ? `${c.hosts} SSH host${c.hosts > 1 ? 's' : ''}` : c.startDir}</div>
              </div>
            </div>
          ))}
          <button className="ob-card ob-add" onClick={add}>
            <span>+</span>
            Add Space
          </button>
        </div>
      </div>
      <Foot onBack={onBack}>
        <button className="btn primary" onClick={onNext} disabled={!n}>
          Create {n} Space{n === 1 ? '' : 's'}
        </button>
      </Foot>
    </>
  );
}

function Tips({ onBack, onDone }) {
  const kb = app.use((s) => s.settings.keybindings);
  const tips = [
    [formatAccel(kb.commandBar), 'Command bar', 'Jump to any session, folder, SSH host or command.'],
    [formatAccel(kb.newTerminal), 'New terminal', 'Opens in the current directory, in the current Space.'],
    ['⇡', 'Drag a row up to pin', 'Pinned sessions stay put; everything in Today tidies itself away.'],
    [`${formatAccel(kb.prevSpace)} ${formatAccel(kb.nextSpace)}`, 'Switch Spaces', 'Or swipe two fingers sideways on the sidebar.'],
  ];
  return (
    <>
      <div className="ob-body">
        <h2>Four moves to remember</h2>
        <p className="ob-lead">That's all you need. Everything else is in the command bar.</p>
        <div className="ob-tips">
          {tips.map(([key, title, sub]) => (
            <div key={title} className="ob-tip">
              <kbd>{key}</kbd>
              <span className="grow">
                <span className="ob-src-title">{title}</span>
                <span className="ob-src-sub">{sub}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
      <Foot onBack={onBack}>
        <button className="btn primary" onClick={onDone} autoFocus>
          Start using Termorc
        </button>
      </Foot>
    </>
  );
}
