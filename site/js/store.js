// Everything the app remembers lives in this browser's localStorage and nowhere else.
// Every access is wrapped: private windows and blocked storage must not break playback.

const PREFIX = 'aio:v1:';
const LOCAL_BROKEN_DAYS = 3;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const store = {
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
