// Everything the app remembers lives in this browser's localStorage and nowhere else.
// The listener can turn saving off: data then lives only in memory for the current visit,
// and the only thing kept in localStorage is the "don't save" choice itself.
// Every access is wrapped: private windows and blocked storage must not break playback.

const PREFIX = 'aio:v1:';
const OPT_OUT_KEY = 'aio:no-storage';
const LOCAL_BROKEN_DAYS = 3;

const memory = new Map();

function storageOptedOut() {
  try { return localStorage.getItem(OPT_OUT_KEY) === '1'; } catch { return false; }
}

let persist = !storageOptedOut();

function read(key, fallback) {
  if (!persist) return memory.has(key) ? structuredClone(memory.get(key)) : fallback;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  if (!persist) {
    memory.set(key, structuredClone(value));
    return true;
  }
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

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

export const store = {
  /** True when progress and settings are saved in this browser. */
  isPersistent: () => persist,

  /**
   * Turn saving on or off. Turning it off moves this visit's data into memory and deletes
   * everything the app saved in this browser; turning it on saves the in-memory data.
   */
  setPersistent(on) {
    if (on === persist) return;
    if (!on) {
      for (const k of savedKeys()) {
        memory.set(k, read(k, null));
        try { localStorage.removeItem(PREFIX + k); } catch {}
      }
      try { localStorage.setItem(OPT_OUT_KEY, '1'); } catch {}
      persist = false;
    } else {
      persist = true;
      try { localStorage.removeItem(OPT_OUT_KEY); } catch {}
      for (const [k, v] of memory) write(k, v);
      memory.clear();
    }
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
