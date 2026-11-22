// Listener data (progress, settings, last played) always lives in memory first.
// Nothing touches the browser's storage unless the listener asks:
//   'none'   default: nothing saved; everything is forgotten when the page closes
//   'manual' the listener pressed "Save just this once": that snapshot loads on later visits,
//            and newer changes are only saved when they press Save again
//   'auto'   autosave on: every change is written to localStorage right away
// Every storage access is wrapped: private windows and blocked storage must not break playback.

const PREFIX = 'aio:v1:';
const AUTOSAVE_KEY = 'autosave';
const LOCAL_BROKEN_DAYS = 3;
// Changes to these make the "unsaved" indicator light up; others (UI state, failed-link
// memory) are saved along with them but aren't worth nagging about.
const TRACKED = new Set(['progress', 'prefs']);

const memory = new Map();
const listeners = new Set();
let mode = 'none';
let dirty = false;
let lastSaved = null;

function savedKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k.slice(PREFIX.length));
    }
  } catch {}
  return keys;
}

function lsSet(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch { return false; }
}

// Load anything saved on an earlier visit.
(function init() {
  const keys = savedKeys();
  for (const k of keys) {
    try { memory.set(k, JSON.parse(localStorage.getItem(PREFIX + k))); } catch {}
  }
  lastSaved = memory.get('savedAt') ?? null;
  memory.delete('savedAt');
  if (memory.get(AUTOSAVE_KEY) === true) mode = 'auto';
  else if (keys.length) mode = 'manual';
  memory.delete(AUTOSAVE_KEY);
})();

const notify = () => listeners.forEach((fn) => { try { fn(); } catch {} });

function read(key, fallback) {
  return memory.has(key) ? structuredClone(memory.get(key)) : fallback;
}

function write(key, value) {
  memory.set(key, structuredClone(value));
  if (mode === 'auto') {
    lsSet(key, value);
  } else if (TRACKED.has(key) && !dirty) {
    dirty = true;
    notify();
  }
  return true;
}

function saveAll() {
  let ok = true;
  for (const [k, v] of memory) ok = lsSet(k, v) && ok;
  lastSaved = Date.now();
  lsSet('savedAt', lastSaved);
  if (ok) dirty = false;
  return ok;
}

export const store = {
  /** 'none' | 'manual' | 'auto' */
  mode: () => mode,
  /** True when there are changes worth keeping that aren't saved in the browser. */
  hasUnsaved: () => mode !== 'auto' && dirty,
  lastSaved: () => lastSaved,
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  /** Save everything now, without turning on autosave. */
  saveOnce() {
    const ok = saveAll();
    if (ok && mode === 'none') mode = 'manual';
    notify();
    return ok;
  },

  setAutosave(on) {
    if (on) {
      const ok = saveAll();
      if (!ok) { notify(); return false; }
      lsSet(AUTOSAVE_KEY, true);
      mode = 'auto';
    } else if (mode === 'auto') {
      try { localStorage.removeItem(PREFIX + AUTOSAVE_KEY); } catch {}
      mode = 'manual'; // the saved copy stays until the listener deletes it
    }
    notify();
    return true;
  },

  /** Remove everything this app saved in the browser. This visit's data stays in memory. */
  deleteSaved() {
    for (const k of savedKeys()) { try { localStorage.removeItem(PREFIX + k); } catch {} }
    mode = 'none';
    lastSaved = null;
    dirty = [...TRACKED].some((k) => {
      const v = memory.get(k);
      return v && (typeof v !== 'object' || Object.keys(v).length);
    });
    notify();
  },

  prefs: () => read('prefs', null),
  setPrefs: (p) => write('prefs', p),

  /** { [episodeId]: { pos: {url: sec}, dur: {url: sec}, last: url, updated: ms, done: bool } } */
  allProgress: () => read('progress', {}),
  progress: (id) => read('progress', {})[id] ?? null,
  setProgress(id, record) {
    const all = read('progress', {});
    all[id] = record;
    return write('progress', all);
  },
  clearProgress: (id) => {
    const all = read('progress', {});
    delete all[id];
    write('progress', all);
  },
  clearAllProgress: () => write('progress', {}),

  /** Links that failed to load in this browser, remembered for a few days. */
  localBroken() {
    const all = read('broken', {});
    const cutoff = Date.now() - LOCAL_BROKEN_DAYS * 864e5;
    let changed = false;
    for (const [url, t] of Object.entries(all)) if (t < cutoff) { delete all[url]; changed = true; }
    if (changed) write('broken', all);
    return all;
  },
  markBroken(url) {
    const all = read('broken', {});
    all[url] = Date.now();
    write('broken', all);
  },
  clearBroken: () => write('broken', {}),

  ui: () => read('ui', {}),
  setUi: (patch) => write('ui', { ...read('ui', {}), ...patch }),
};
