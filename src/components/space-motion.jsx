// Space switching for the sidebar, done as a real carousel (Arc-style): neighbouring Spaces'
// actual content sits side by side on one track. A two-finger swipe drags the track 1:1 and
// it springs to the nearest Space on release, carrying the swipe's velocity. Dots, keys and
// drag-hover switches run the same track. Swiping past the last Space fills a ＋ ring that
// creates a new, empty Space.
import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { app } from '../state/model.js';
import * as A from '../state/actions.js';
import { closePeek } from './sidebar-shared.js';

const IDLE = 140; // ms without wheel events ends a swipe (trackpad momentum included)
const COMMIT = 0.22; // fraction of the width that switches Space on release…
const FLICK = 500; // …or a flick this fast (px/s)
const AUTO = 0.6; // past this fraction the switch completes on its own
const CREATE = 200; // px past the last Space that creates a new one
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Lightly underdamped spring (settles in ~300ms with a hint of follow-through).
function spring(from, to, v0, onFrame, onDone) {
  const k = 300;
  const c = 31;
  let x = from;
  let v = v0;
  let last = performance.now();
  let raf = 0;
  const step = (now) => {
    const dt = Math.min(0.034, (now - last) / 1000);
    last = now;
    for (let i = 0; i < 4; i++) {
      const h = dt / 4;
      v += (-k * (x - to) - c * v) * h;
      x += v * h;
    }
    if (Math.abs(x - to) < 0.35 && Math.abs(v) < 6) {
      onFrame(to);
      onDone?.();
      return;
    }
    onFrame(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

// Resistance that approaches `max` px however far you pull.
const rubber = (d, max) => max * (1 - 1 / ((d * 0.6) / max + 1));

let nextDir = 0; // set when a switch should slide a particular way regardless of order
const track = { current: null, owner: null }; // the mounted SpaceTrack's controls (one sidebar at a time)

export function SpaceTrack({ render }) {
  const spaces = app.use((s) => s.spaces);
  const activeId = app.use((s) => s.activeSpaceId);
  const [view, setView] = useState({ ids: [activeId], base: 0 });
  const viewport = useRef(null);
  const tr = useRef(null);
  const S = useRef({ x: 0, base: 0, shown: activeId, stop: null, gesture: false, committing: null, pending: null, prev: false, next: false }).current;
  S.base = view.base;

  const width = () => viewport.current?.clientWidth || 1;
  const paint = (x) => {
    S.x = x;
    if (tr.current) tr.current.style.transform = `translate3d(calc(${-S.base * 100}% + ${x}px), 0, 0)`;
  };
  const show = (ids, base, x = 0) => {
    S.base = base;
    S.x = x;
    setView({ ids, base });
  };
  const rest = (id) => {
    S.stop = null;
    show([id], 0, 0);
  };
  const idx = (id) => app.get().spaces.findIndex((x) => x.id === id);
  const animate = (to, v, done) => {
    S.stop?.();
    if (reduced()) {
      paint(to);
      return done();
    }
    S.stop = spring(S.x, to, v, paint, done);
  };

  // A switch from anywhere (dot, key, drag spring, new Space): slide from the shown Space
  // to the active one, starting wherever the track is right now.
  useLayoutEffect(() => {
    if (activeId === S.shown) return;
    const from = S.shown;
    S.shown = activeId;
    if (S.committing === activeId) {
      S.committing = null;
      return; // a swipe is already springing there
    }
    const dir = nextDir || (idx(activeId) > idx(from) ? 1 : -1);
    nextDir = 0;
    S.stop?.();
    S.gesture = false;
    if (idx(from) < 0 || !viewport.current?.offsetParent) return rest(activeId);
    S.pending = { to: activeId, dir };
    show(dir > 0 ? [from, activeId] : [activeId, from], dir > 0 ? 0 : 1, S.x);
  }, [activeId]);

  // Every render repaints the transform for the current panes, then starts a queued slide.
  useLayoutEffect(() => {
    paint(S.x);
    const p = S.pending;
    if (p && view.ids.includes(p.to)) {
      S.pending = null;
      animate(-p.dir * width(), 0, () => rest(p.to));
    }
  });

  useLayoutEffect(
    () => () => {
      if (track.owner === S) track.current = track.owner = null;
    },
    []
  );

  track.owner = S;
  track.current = {
    begin() {
      if (S.stop || S.pending || view.ids.length > 1) return false;
      const i = idx(S.shown);
      const all = app.get().spaces;
      const prev = all[i - 1];
      const next = all[i + 1];
      S.prev = !!prev;
      S.next = !!next;
      S.gesture = true;
      flushSync(() => show([prev?.id, S.shown, next?.id].filter(Boolean), prev ? 1 : 0, 0));
      return true;
    },
    // dx: accumulated wheel deltaX (fingers left = positive = towards the next Space).
    drag(dx) {
      if (!S.gesture) return { past: 0 };
      let x = -dx;
      let past = 0;
      if (x < 0 && !S.next) {
        past = -x;
        x = -rubber(past, 110);
      } else if (x > 0 && !S.prev) x = rubber(x, 56);
      paint(x);
      return { past, frac: Math.abs(x) / width(), toward: x < 0 ? (S.next ? 1 : 0) : S.prev ? -1 : 0 };
    },
    // v: content velocity in px/s (negative = moving left, towards the next Space).
    release(v = 0) {
      if (!S.gesture) return;
      S.gesture = false;
      const w = width();
      let dir = 0;
      if (S.next && (S.x < -w * COMMIT || v < -FLICK)) dir = 1;
      else if (S.prev && (S.x > w * COMMIT || v > FLICK)) dir = -1;
      if (!dir) return animate(0, v, () => rest(S.shown));
      const target = app.get().spaces[idx(S.shown) + dir]?.id;
      if (!target) return animate(0, v, () => rest(S.shown));
      // Switch right away so the terminal follows the fingers; the track finishes the slide.
      S.committing = target;
      A.switchSpace(target);
      animate(-dir * w, v, () => rest(target));
    },
    // Hand an in-flight swipe over to a programmatic switch (e.g. the new-Space ring).
    handoff() {
      S.gesture = false;
    },
  };

  const byId = new Map(spaces.map((x) => [x.id, x]));
  return (
    <div className="space-viewport" ref={viewport}>
      <div className="space-track" ref={tr}>
        {view.ids.map((id) => {
          const sp = byId.get(id);
          if (!sp) return <div key={id} className="space-pane" />;
          return (
            <div key={id} className={`space-pane${id === activeId ? ' cur' : ''}`} style={id === activeId ? undefined : { pointerEvents: 'none' }} aria-hidden={id !== activeId || undefined}>
              {render(sp)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Wheel handler for the sidebar: drives the track and the new-Space ring.
export function useSpaceMotion(loaderRef) {
  const g = useRef({ on: false, lock: false, dx: 0, timer: 0, samples: [] }).current;

  const setLoader = (p, done = false) => {
    const el = loaderRef.current;
    if (!el) return;
    el.style.setProperty('--p', String(p));
    el.classList.toggle('show', p > 0.02);
    el.classList.toggle('done', done);
  };
  const velocity = () => {
    const now = performance.now();
    const recent = g.samples.filter(([t]) => now - t < 90);
    if (recent.length < 2) return 0;
    const span = (recent[recent.length - 1][0] - recent[0][0]) / 1000 || 0.016;
    return -recent.reduce((s, [, d]) => s + d, 0) / span;
  };
  const end = () => {
    g.on = false;
    if (!g.lock) track.current?.release(velocity());
    g.lock = false;
    g.samples = [];
    setTimeout(() => setLoader(0), 120);
  };

  return (e) => {
    const s = app.get();
    if (!s.settings.gestures.swipeSpaces || !track.current) return;
    if (!g.on) {
      if (Math.abs(e.deltaX) < 2 || Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5) return;
      g.on = true;
      g.dx = 0;
      g.samples = [];
      g.lock = !track.current.begin();
      closePeek();
    }
    clearTimeout(g.timer);
    g.timer = setTimeout(end, IDLE);
    if (g.lock) return;
    g.dx += e.deltaX;
    g.samples.push([performance.now(), e.deltaX]);
    if (g.samples.length > 12) g.samples.shift();
    const r = track.current.drag(g.dx);
    const p = Math.min(1, Math.max(0, (r.past - 16) / (CREATE - 16)));
    setLoader(p);
    if (p >= 1) {
      g.lock = true;
      setLoader(1, true);
      track.current.handoff();
      nextDir = 1;
      A.createBlankSpace();
    } else if (r.toward && r.frac >= AUTO) {
      g.lock = true;
      track.current.release(velocity());
    }
  };
}
