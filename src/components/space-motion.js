// Space switching motion for the sidebar (Arc-style). The Space's content slides between
// Spaces however the switch happened (dots, keys, swipe, a drag hovering a dot); a
// two-finger swipe drags it along live; swiping past the last Space fills a ＋ ring that
// creates a new empty Space.
import { useEffect, useRef } from 'react';
import { app } from '../state/model.js';
import * as A from '../state/actions.js';
import { closePeek } from './sidebar-shared.js';

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const COMMIT = 120; // px of horizontal scroll that switches Space
const CREATE = 260; // px past the last Space that creates a new one
const IDLE = 170; // ms without wheel events ends the gesture (trackpad momentum included)
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let nextDir = 0; // a swipe sets this so the slide follows the fingers, even when it wraps

// Slide the Space content out and the new one in. Called synchronously from the store
// listener, so `pane` still holds the old Space's DOM: that becomes the outgoing copy.
function slide(pane, dir) {
  const ghost = pane.cloneNode(true);
  ghost.classList.add('space-ghost');
  for (const el of [ghost, ...ghost.querySelectorAll('*')]) for (const a of [...el.attributes]) if (a.name.startsWith('data-')) el.removeAttribute(a.name);
  Object.assign(ghost.style, { position: 'absolute', left: `${pane.offsetLeft}px`, top: `${pane.offsetTop}px`, width: `${pane.offsetWidth}px`, margin: '0', pointerEvents: 'none' });
  pane.parentNode.appendChild(ghost);
  const from = pane.style.transform || 'none';
  const fromOpacity = pane.style.opacity || '1';
  pane.style.transform = '';
  pane.style.opacity = '';
  const d = Math.max(120, pane.offsetWidth * 0.85);
  ghost.animate([{ transform: from, opacity: fromOpacity }, { transform: `translateX(${-dir * d}px)`, opacity: 0 }], { duration: 280, easing: EASE }).onfinish = () => ghost.remove();
  pane.animate([{ transform: `translateX(${dir * d}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 340, easing: EASE });
}

export function useSpaceMotion(rootRef, loaderRef) {
  const g = useRef({ on: false, lock: false, dx: 0, timer: 0 });

  useEffect(() => {
    let prev = app.get().activeSpaceId;
    return app.subscribe(() => {
      const s = app.get();
      if (s.activeSpaceId === prev) return;
      const from = s.spaces.findIndex((x) => x.id === prev);
      const to = s.spaces.findIndex((x) => x.id === s.activeSpaceId);
      const dir = nextDir || (from < 0 ? 1 : Math.sign(to - from) || 1);
      nextDir = 0;
      prev = s.activeSpaceId;
      const pane = rootRef.current?.querySelector('.space-pane');
      if (!pane) return;
      if (reduced()) {
        pane.style.transform = pane.style.opacity = '';
        return;
      }
      slide(pane, dir);
    });
  }, []);

  const pane = () => rootRef.current?.querySelector('.space-pane');
  const setLoader = (p, done = false) => {
    const el = loaderRef.current;
    if (!el) return;
    el.style.setProperty('--p', String(p));
    el.classList.toggle('show', p > 0.02);
    el.classList.toggle('done', done);
  };

  const release = () => {
    const G = g.current;
    G.on = false;
    G.dx = 0;
    const el = pane();
    if (el && (el.style.transform || el.style.opacity)) {
      const from = { transform: el.style.transform || 'none', opacity: el.style.opacity || '1' };
      el.style.transform = el.style.opacity = '';
      if (!reduced()) el.animate([from, { transform: 'none', opacity: 1 }], { duration: 260, easing: EASE });
    }
    if (!G.lock) setLoader(0);
    else setTimeout(() => setLoader(0), 260);
    G.lock = false;
  };

  const onWheel = (e) => {
    const s = app.get();
    if (!s.settings.gestures.swipeSpaces) return;
    const G = g.current;
    const ax = Math.abs(e.deltaX);
    if (!G.on) {
      if (ax < 2 || ax <= Math.abs(e.deltaY) * 1.5) return;
      G.on = true;
      G.lock = false;
      G.dx = 0;
      closePeek();
    }
    clearTimeout(G.timer);
    G.timer = setTimeout(release, IDLE);
    if (G.lock) return;

    G.dx += e.deltaX;
    const i = s.spaces.findIndex((x) => x.id === s.activeSpaceId);
    const dir = Math.sign(G.dx);
    const el = pane();
    const create = dir > 0 && i === s.spaces.length - 1;
    const edge = create || (dir < 0 && i === 0);
    const p = create ? Math.min(1, Math.max(0, (G.dx - 24) / (CREATE - 24))) : 0;
    if (el) {
      // Free travel between Spaces; past the last one the content makes room for the ＋ ring;
      // before the first it only gives a little.
      const shift = create ? -Math.min(96, G.dx * 0.42) : edge ? Math.min(48, -G.dx * 0.2) : -G.dx * 0.45;
      el.style.transform = `translateX(${shift}px)`;
      el.style.opacity = String(create ? 1 - p * 0.45 : edge ? 1 : Math.max(0.35, 1 - Math.abs(G.dx) / 320));
    }
    if (create) {
      setLoader(p);
      if (p >= 1) {
        G.lock = true;
        setLoader(1, true);
        nextDir = 1;
        A.createBlankSpace();
      }
      return;
    }
    setLoader(0);
    if (!edge && Math.abs(G.dx) >= COMMIT) {
      G.lock = true;
      nextDir = dir;
      A.switchSpace(dir);
    }
  };

  return onWheel;
}
