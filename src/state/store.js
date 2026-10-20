// Minimal external stores with selector subscriptions (no extra dependency).
import { useRef, useSyncExternalStore } from 'react';

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  const store = {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? next(state) : next;
      if (value === state) return;
      state = value;
      for (const l of listeners) l();
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  store.use = (selector = (s) => s, eq = Object.is) => useSelector(store, selector, eq);
  return store;
}

function useSelector(store, selector, eq) {
  const cache = useRef(null);
  const getSnapshot = () => {
    const next = selector(store.get());
    if (cache.current && eq(cache.current.v, next)) return cache.current.v;
    cache.current = { v: next };
    return next;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

export function shallow(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}
