import { store } from './store.js?v=dev';
import {
  reconcilePrefs, candidates, pickSource, resumePoint, recordPosition,
  fraction, formatTime, matchesQuery, sourceImpact,
} from './logic.js?v=dev';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
};

const PLAY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const PAGE = 100;
const RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];

const state = {
  data: null,
  byId: new Map(),
  sourceInfo: new Map(),
  prefs: null,
  view: 'episodes',
  extras: [], // podcast extras, oldest first
  lists: {
    episodes: { query: '', filter: 'playable', shown: PAGE },
    extras: { query: '', filter: 'playable', shown: PAGE },
  },
  current: null, // { item, source, isExtra }
};

// ---------- data ----------

async function load() {
  try {
    const res = await fetch('data/episodes.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    $('#episode-list').replaceChildren(el('p', { class: 'empty', text: `Couldn't load the episode list (${err.message}). Try reloading.` }));
    return;
  }
  const { data } = state;
  for (const ep of data.episodes) state.byId.set(ep.id, ep);
  for (const ex of data.extras ?? []) {
    const item = { ...ex, id: `extra-${hash(ex.guid)}`, isExtra: true, sources: [{ source: 'omny', url: ex.url, label: null, status: ex.status ?? 'ok', duration: ex.duration }] };
    state.byId.set(item.id, item);
    state.extras.push(item);
  }
  state.extras.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  for (const s of data.sources) state.sourceInfo.set(s.id, s);
  state.prefs = reconcilePrefs(store.prefs(), data.sources);

  const ui = store.ui();
  for (const [name, cfg] of Object.entries(LISTS)) {
    const saved = ui[cfg.uiFilter];
    if (saved) { state.lists[name].filter = saved; $(cfg.ids.filter).value = saved; }
  }
  const d = new Date(data.generatedAt);
  $('#data-date').textContent = Number.isNaN(d.getTime()) ? '' : `Links last updated ${d.toLocaleDateString()}.`;

  renderAll();
  restoreLast();
  openFromHash();
  restoreAfterUpdate();
}

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

const localBroken = () => store.localBroken();
const playableNow = (ep) => candidates(ep, state.prefs, localBroken()).length > 0;
const sourceName = (id) => state.sourceInfo.get(id)?.name ?? id;

// ---------- rendering ----------

function renderAll() {
  renderEpisodes();
  renderContinue();
  renderExtras();
}

function passesFilter(ep, prog, filter) {
  switch (filter) {
    case 'playable': return playableNow(ep);
    case 'unplayed': return !prog && playableNow(ep);
    case 'progress': return prog && !prog.done && fraction(prog) > 0;
    case 'done': return prog?.done;
    default: return true;
  }
}

// The Episodes and Podcast extras tabs are the same list with different audio:
// same search, filter, collapsible groups and rows. Only these settings differ.
const LISTS = {
  episodes: {
    items: () => state.data.episodes,
    groupKey: (ep) => String(ep.season ?? 'other'),
    groupLabel: (key) => (key === 'other' ? 'Specials and album-only episodes' : `Season ${key}`),
    groupMeta: (key, items) => (key === 'other' ? '' : items[0].year),
    noun: ['episode', 'episodes'],
    uiOpen: 'open',
    uiFilter: 'filter',
    ids: { list: '#episode-list', search: '#search', filter: '#filter', stats: '#stats' },
  },
  extras: {
    items: () => state.extras,
    groupKey: (x) => x.date?.slice(0, 4) ?? 'Undated',
    groupLabel: (key) => key,
    groupMeta: () => '',
    noun: ['extra', 'extras'],
    uiOpen: 'openExtras',
    uiFilter: 'filterExtras',
    ids: { list: '#extras-list', search: '#search-extras', filter: '#filter-extras', stats: '#stats-extras' },
  },
};

const renderEpisodes = () => renderList('episodes');
const renderExtras = () => renderList('extras');

function renderList(name) {
  const cfg = LISTS[name];
  const ls = state.lists[name];
  const [one, many] = cfg.noun;
  const progress = store.allProgress();
  const list = $(cfg.ids.list);
  const all = cfg.items();
  const items = all.filter((ep) => passesFilter(ep, progress[ep.id], ls.filter) && matchesQuery(ep, ls.query));
  const playable = all.filter(playableNow).length;
  $(cfg.ids.stats).textContent = `${items.length} shown · ${playable} of ${all.length} ${many} playable with your source settings`;

  if (!items.length) {
    list.replaceChildren(el('p', { class: 'empty', text: ls.filter === 'playable' && !ls.query
      ? `No playable ${many}. Check your source settings.` : `No ${many} match.` }));
    return;
  }

  if (ls.query) {
    const rows = items.slice(0, ls.shown).map((ep) => epRow(ep, progress[ep.id]));
    list.replaceChildren(el('div', { class: 'list' }, rows));
    if (items.length > ls.shown) {
      list.append(el('button', { class: 'btn more-btn', type: 'button', text: `Show more (${items.length - ls.shown} left)`,
        onclick: () => { ls.shown += PAGE; renderList(name); } }));
    }
    return;
  }

  // Grouped (seasons or years); bodies are built only when a group is opened.
  const groups = new Map();
  for (const ep of items) {
    const key = cfg.groupKey(ep);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ep);
  }
  const openSet = new Set(store.ui()[cfg.uiOpen] ?? []);
  const frag = document.createDocumentFragment();
  for (const [key, group] of groups) {
    const done = group.filter((e) => progress[e.id]?.done).length;
    const meta = [cfg.groupMeta(key, group), `${group.length} ${group.length === 1 ? one : many}`, done ? `${done} finished` : ''];
    const det = el('details', { class: 'season', 'data-group': key },
      el('summary', {}, el('span', { text: cfg.groupLabel(key) }), el('span', { class: 'season-meta', text: meta.filter(Boolean).join(' · ') })));
    const fill = () => {
      if (det.querySelector('.season-body')) return;
      const p = store.allProgress();
      det.append(el('div', { class: 'season-body' }, group.map((ep) => epRow(ep, p[ep.id]))));
    };
    det.addEventListener('toggle', () => {
      if (det.open) fill();
      const set = new Set(store.ui()[cfg.uiOpen] ?? []);
      det.open ? set.add(key) : set.delete(key);
      store.setUi({ [cfg.uiOpen]: [...set] });
    });
    if (openSet.has(key)) { det.open = true; fill(); }
    frag.append(det);
  }
  list.replaceChildren(frag);
}

function epRow(ep, prog, { removable = false } = {}) {
  const can = playableNow(ep);
  const isCurrent = state.current?.item.id === ep.id;
  const onlyArchive = ep.sources?.length && ep.sources.every((s) => s.source === 'wayback');
  const best = candidates(ep, state.prefs, localBroken())[0];
  const dur = prog?.dur?.[prog.last] ?? best?.duration;
  const f = fraction(prog);

  let side;
  if (prog?.done) side = el('span', { class: 'badge done', text: 'Finished' });
  else if (f > 0 && dur) side = el('span', { text: `${formatTime(dur - (prog.pos[prog.last] ?? 0))} left` });
  else if (dur) side = el('span', { text: formatTime(dur) });

  const sub = [
    ep.isExtra && ep.date ? new Date(`${ep.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null,
    (ep.albums ?? []).find((a) => a.startsWith('#')) ?? ep.albums?.[0],
    ep.year && !ep.albums?.length ? String(ep.year) : null,
    ep.unlisted ? 'Not in Wikipedia list' : null,
    !can && ep.sources?.length ? (onlyArchive ? 'Archive copy only, turn on in Settings' : 'No working link right now') : null,
    !ep.sources?.length ? 'No known link' : null,
  ].filter(Boolean);

  const btn = el('button', {
    class: 'play-btn', type: 'button', disabled: !can,
    'aria-label': `Play ${ep.title}`,
    onclick: () => playItem(ep, { autoplay: true }),
  });
  btn.innerHTML = PLAY_ICON;

  const remove = removable && el('button', {
    class: 'remove-btn', type: 'button', 'aria-label': `Remove ${ep.title} from this list`, title: 'Remove from list',
    onclick: () => removeProgress(ep),
  });
  if (remove) remove.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

  return el('div', { class: `ep${isCurrent ? ' current' : ''}${can ? '' : ' unavailable'}${removable ? ' removable' : ''}`, 'data-id': ep.id, 'data-removable': removable || null, id: ep.isExtra || removable ? null : ep.id },
    btn,
    el('div', { class: 'ep-main' },
      el('div', { class: 'ep-title' }, ep.code ? el('span', { class: 'ep-num', text: `#${ep.code}` }) : null, ep.title),
      sub.length ? el('div', { class: 'ep-sub' }, sub.map((s) => el('span', { text: s }))) : null,
      ep.isExtra && ep.description ? el('div', { class: 'extra-desc', text: ep.description }) : null),
    el('div', { class: 'ep-side' }, side, onlyArchive && can ? el('span', { class: 'badge archive', text: 'Archive' }) : null),
    remove || null,
    f > 0 && f < 1 ? el('div', { class: 'progress', 'aria-hidden': 'true' }, el('i', { style: `width:${(f * 100).toFixed(1)}%` })) : null,
  );
}

function renderContinue() {
  const progress = store.allProgress();
  const entries = Object.entries(progress)
    .filter(([id]) => state.byId.has(id))
    .sort((a, b) => (b[1].updated ?? 0) - (a[1].updated ?? 0));
  const inProgress = entries.filter(([, p]) => !p.done && fraction(p) > 0);
  const finished = entries.filter(([, p]) => p.done).slice(0, 20);
  $('#continue-count').textContent = inProgress.length || '';

  const list = $('#continue-list');
  // Some records belong in neither list (e.g. an episode paused at 0:00), so check what's shown.
  if (!inProgress.length && !finished.length) {
    list.replaceChildren(el('p', { class: 'empty', text: 'Episodes you start will appear here so you can pick up where you left off.' }));
    return;
  }
  list.replaceChildren(...[
    inProgress.length ? el('h3', { text: 'In progress' }) : null,
    ...inProgress.map(([id, p]) => epRow(state.byId.get(id), p, { removable: true })),
    finished.length ? el('h3', { text: 'Recently finished' }) : null,
    ...finished.map(([id, p]) => epRow(state.byId.get(id), p, { removable: true })),
  ].filter(Boolean));
}

/** Refresh only the rows for one episode (cheap; used while playing). */
function refreshRows(id) {
  const ep = state.byId.get(id);
  const prog = store.progress(id);
  document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((row) =>
    row.replaceWith(epRow(ep, prog, { removable: row.hasAttribute('data-removable') })));
}

// ---------- player ----------

const audio = $('#audio');
const player = $('#player');
let lastSave = 0;
let pendingResume = null;
let triedThisLoad = new Set();
let loadTimer;

function setPlayerHeight() {
  document.documentElement.style.setProperty('--player-h', player.hidden ? '0px' : `${player.offsetHeight}px`);
}

function playItem(item, { source, autoplay = true, silentFallback = false } = {}) {
  const prev = state.current;
  if (prev && prev.item.id !== item.id) saveNow();
  const prog = store.progress(item.id);
  const src = source ?? pickSource(item, state.prefs, prog, localBroken());
  if (!src) {
    toast('No working link for this episode with your current source settings.');
    return;
  }
  if (!prev || prev.item.id !== item.id) triedThisLoad = new Set();
  triedThisLoad.add(src.url);

  state.current = { item, source: src };
  state.wantPlay = autoplay;
  pendingResume = { autoplay, fromSource: prev?.item.id === item.id ? prev.source : null, silentFallback };
  audio.src = src.url;
  audio.playbackRate = state.prefs.rate ?? 1;
  audio.load();
  $('#seek').value = 0;
  $('#seek').max = 0;
  $('#cur').textContent = '0:00';
  $('#dur').textContent = src.duration ? formatTime(src.duration) : '0:00';
  // Some hosts never answer at all; treat 20s of silence like a failed link.
  clearTimeout(loadTimer);
  const loadingUrl = src.url;
  loadTimer = setTimeout(() => {
    if (state.current?.source.url === loadingUrl && audio.readyState === 0) handleLoadFailure();
  }, 20000);

  player.hidden = false;
  player.classList.add('loading');
  $('#np-title').textContent = item.code ? `#${item.code} ${item.title}` : item.title;
  renderSourceSelect();
  $('#rate').textContent = `${audio.playbackRate}×`;
  setPlayerHeight();
  store.setUi({ lastId: item.id });
  if (!item.isExtra) history.replaceState(null, '', `#ep=${encodeURIComponent(item.id)}`);
  document.querySelectorAll('.ep.current').forEach((r) => r.classList.remove('current'));
  document.querySelectorAll(`[data-id="${CSS.escape(item.id)}"]`).forEach((r) => r.classList.add('current'));
  setupMediaSession(item);
}

function renderSourceSelect() {
  const { item, source } = state.current;
  const broken = localBroken();
  const sel = $('#np-source');
  // Only sources the listener has turned on (plus whatever is loaded right now, so the menu
  // never shows the wrong copy). Links the scraper confirmed dead can't play, so they're left out.
  const sources = (item.sources ?? [])
    .filter((s) => s.url === source.url || (state.prefs.enabled[s.source] && s.status !== 'broken'))
    .sort((a, b) => state.prefs.order.indexOf(a.source) - state.prefs.order.indexOf(b.source));
  sel.replaceChildren(...sources.map((s) => {
    const notes = [];
    if (!state.prefs.enabled[s.source]) notes.push('off in settings');
    if (broken[s.url]) notes.push('failed here recently');
    const text = `From: ${sourceName(s.source)}${s.label ? ` (${s.label})` : ''}${notes.length ? ` [${notes.join(', ')}]` : ''}`;
    return el('option', { value: s.url, selected: s.url === source.url, text });
  }));
  sel.disabled = sources.length < 2;
}

$('#np-source').addEventListener('change', (e) => {
  const { item } = state.current;
  const s = item.sources.find((x) => x.url === e.target.value);
  if (!s) return;
  saveNow();
  playItem(item, { source: s, autoplay: !audio.paused || audio.currentTime === 0 });
});

audio.addEventListener('loadedmetadata', () => {
  const cur = state.current;
  if (!cur || !pendingResume) return;
  const prog = store.progress(cur.item.id);
  const { time, approximate } = resumePoint(prog, cur.source.url, audio.duration);
  if (time > 0 && time < audio.duration - 5) {
    audio.currentTime = time;
    if (approximate) toast(`This copy is a different length, so it resumed at about ${formatTime(time)}.`);
    else if (!pendingResume.silentFallback) toast(`Resuming at ${formatTime(time)}`);
  }
  if (pendingResume.autoplay) audio.play().catch(() => {});
  pendingResume = null;
  updateTimes();
});

audio.addEventListener('canplay', () => { clearTimeout(loadTimer); player.classList.remove('loading'); });
audio.addEventListener('play', () => { if (state.current) removed.delete(state.current.item.id); });
audio.addEventListener('play', () => { player.classList.add('playing'); $('#play').setAttribute('aria-label', 'Pause'); });
audio.addEventListener('pause', () => { player.classList.remove('playing'); $('#play').setAttribute('aria-label', 'Play'); saveNow(); maybeReload(); });
audio.addEventListener('timeupdate', () => {
  updateTimes();
  if (Date.now() - lastSave > 5000 && !audio.paused) saveNow();
});
audio.addEventListener('ended', () => {
  saveNow();
  toast('Finished. Nice listening!');
});

audio.addEventListener('error', () => {
  if (!state.current || !audio.getAttribute('src')) return;
  // Only remember the failure for network/format errors, not when the user aborted.
  if (audio.error?.code === MediaError.MEDIA_ERR_ABORTED) return;
  handleLoadFailure();
});

function handleLoadFailure() {
  const cur = state.current;
  clearTimeout(loadTimer);
  store.markBroken(cur.source.url);
  const next = candidates(cur.item, state.prefs, localBroken()).find((s) => !triedThisLoad.has(s.url));
  const wasAuto = Boolean(state.wantPlay || pendingResume?.autoplay || !audio.paused);
  if (next) {
    toast(`That link didn't load. Switched to ${sourceName(next.source)}.`);
    playItem(cur.item, { source: next, autoplay: wasAuto, silentFallback: true });
  } else {
    player.classList.remove('loading');
    toast('None of the links for this episode are working right now. Try turning on more sources in Settings.');
    renderSourceSelect();
  }
  refreshRows(cur.item.id);
}

function saveNow() {
  const cur = state.current;
  if (!cur || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  if (removed.has(cur.item.id)) return; // cleared by the listener; comes back only if they press play again
  if (audio.currentTime < 2 && !store.progress(cur.item.id)) return; // don't record a bare click
  const prev = store.progress(cur.item.id);
  const rec = recordPosition(prev, cur.source.url, audio.currentTime, audio.duration);
  // Nothing moved (e.g. the page was just hidden): don't rewrite it, or it would look like an unsaved change.
  if (prev && prev.last === rec.last && prev.pos?.[rec.last] === rec.pos[rec.last] && Boolean(prev.done) === Boolean(rec.done)) return;
  store.setProgress(cur.item.id, rec);
  lastSave = Date.now();
  refreshRows(cur.item.id);
  if (state.view === 'continue') renderContinue();
  else $('#continue-count').textContent = Object.values(store.allProgress()).filter((p) => !p.done && fraction(p) > 0).length || '';
}

function updateTimes() {
  const d = Number.isFinite(audio.duration) ? audio.duration : 0;
  const seek = $('#seek');
  seek.max = Math.floor(d);
  if (!seek.matches(':active')) seek.value = Math.floor(audio.currentTime);
  $('#cur').textContent = formatTime(audio.currentTime);
  $('#dur').textContent = formatTime(d);
  if ('mediaSession' in navigator && d && navigator.mediaSession.setPositionState) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: audio.playbackRate }); } catch {}
  }
}

const skip = (s) => { audio.currentTime = Math.max(0, Math.min((audio.duration || 0) - 1, audio.currentTime + s)); };
const toggle = () => {
  if (!state.current) return;
  state.wantPlay = audio.paused;
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
};

$('#play').addEventListener('click', toggle);
$('#back').addEventListener('click', () => skip(-15));
$('#fwd').addEventListener('click', () => skip(30));
$('#seek').addEventListener('input', (e) => { audio.currentTime = Number(e.target.value); });
$('#rate').addEventListener('click', () => {
  const i = RATES.indexOf(audio.playbackRate);
  audio.playbackRate = RATES[(i + 1) % RATES.length];
  state.prefs.rate = audio.playbackRate;
  store.setPrefs(state.prefs);
  $('#rate').textContent = `${audio.playbackRate}×`;
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, dialog')) return;
  if (e.key === ' ' && state.current) { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowLeft' && state.current) skip(-15);
  else if (e.key === 'ArrowRight' && state.current) skip(30);
});

window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
window.addEventListener('resize', setPlayerHeight);

function setupMediaSession(item) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: item.title,
    artist: 'Adventures in Odyssey',
    album: item.albums?.find((a) => a.startsWith('#')) ?? item.albums?.[0] ?? (item.isExtra ? 'Official Podcast' : ''),
    // Square PNGs: iOS shows SVG artwork shrunk into a corner of a white tile on the lock screen.
    artwork: item.image
      ? [{ src: item.image, sizes: '512x512' }]
      : [192, 512].map((n) => ({ src: new URL(`icon-${n}.png`, location.href).href, sizes: `${n}x${n}`, type: 'image/png' })),
  });
  const h = {
    play: () => audio.play(), pause: () => audio.pause(),
    // Lock-screen buttons skip by the amount the system draws on them (10s on iPhone).
    seekbackward: (d) => skip(-(d?.seekOffset || 10)), seekforward: (d) => skip(d?.seekOffset || 10),
    seekto: (d) => { audio.currentTime = d.seekTime; },
  };
  for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch {} }
}

/** Show the last episode in the player (paused) so the listener sees where they stopped. */
function restoreLast() {
  const id = store.ui().lastId;
  const item = id && state.byId.get(id);
  if (item && !location.hash.startsWith('#ep=') && playableNow(item)) playItem(item, { autoplay: false });
}

function openFromHash() {
  const m = location.hash.match(/^#ep=(.+)$/);
  const ep = m && state.byId.get(decodeURIComponent(m[1]));
  if (!ep) return;
  if (ep.season != null || !ep.isExtra) {
    const det = document.querySelector(`#episode-list .season[data-group="${ep.season ?? 'other'}"]`);
    if (det && !det.open) det.open = true;
    det?.dispatchEvent(new Event('toggle'));
  }
  if (playableNow(ep)) playItem(ep, { autoplay: false });
  requestAnimationFrame(() => document.getElementById(ep.id)?.scrollIntoView({ block: 'center' }));
}

window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#ep=(.+)$/);
  if (m && state.current?.item.id !== decodeURIComponent(m[1])) { showView('episodes'); openFromHash(); }
});

// ---------- tabs, search, filter ----------

document.querySelectorAll('.tabs [role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
});

function showView(view) {
  state.view = view;
  document.querySelectorAll('.tabs [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  for (const v of ['episodes', 'continue', 'extras']) $(`#view-${v}`).hidden = v !== view;
  if (view === 'continue') renderContinue();
  if (view === 'extras') renderExtras();
  if (view === 'episodes') renderEpisodes();
}

for (const [name, cfg] of Object.entries(LISTS)) {
  let searchTimer;
  $(cfg.ids.search).addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.lists[name].query = e.target.value.trim();
      state.lists[name].shown = PAGE;
      renderList(name);
    }, 150);
  });
  $(cfg.ids.filter).addEventListener('change', (e) => {
    state.lists[name].filter = e.target.value;
    store.setUi({ [cfg.uiFilter]: e.target.value });
    renderList(name);
  });
}

// ---------- settings ----------

const dlg = $('#settings');
$('#settings-btn').addEventListener('click', () => { renderSourcePrefs(); renderSaveSettings(); dlg.showModal(); });

// ---------- saving (off by default) ----------

const saveDlg = $('#save-dlg');
let nudged = false;
let quiet = false; // "Not now" hides the dot (not the button) for the rest of this visit

function unsavedSummary() {
  const n = Object.values(store.allProgress()).filter((p) => p.done || fraction(p) > 0).length;
  return n ? `${n} episode${n === 1 ? '' : 's'}` : 'your settings';
}

function updateSaveIndicator() {
  const btn = $('#save-btn');
  const auto = store.mode() === 'auto';
  const unsaved = store.hasUnsaved();
  // Three states: unsaved changes (save icon + dot), autosaving (check icon), or nothing to show.
  btn.hidden = !auto && !unsaved;
  btn.classList.toggle('auto', auto);
  btn.classList.toggle('unsaved', unsaved);
  btn.classList.toggle('quiet', quiet && unsaved);
  const label = auto ? 'Autosave is on: progress is saved in this browser'
    : unsaved ? `Unsaved progress for ${unsavedSummary()}. Save it` : 'Save';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.setAttribute('aria-haspopup', 'dialog');
  // One gentle nudge per visit the first time there is something to lose.
  if (unsaved && !nudged && store.mode() === 'none') {
    nudged = true;
    btn.classList.add('nudge');
    toast('Your progress isn\'t being saved yet. Tap the save icon at the top to keep it.');
  }
  if (dlg.open) renderSaveSettings();
}
store.onChange(updateSaveIndicator);

function renderSaveSettings() {
  const mode = store.mode();
  const when = store.lastSaved() ? new Date(store.lastSaved()).toLocaleString() : null;
  $('#autosave-toggle').checked = mode === 'auto';
  $('#save-status').textContent =
    mode === 'auto' ? 'Autosave is on. Your progress is saved in this browser as you listen.'
    : mode === 'manual' ? `Saved in this browser${when ? ` on ${when}` : ''}.${store.hasUnsaved() ? ' You have newer changes that are not saved.' : ''}`
    : 'Nothing is saved in this browser. Your progress is kept only until you close this page.';
  $('#save-once-settings').hidden = mode === 'auto';
  $('#delete-saved').hidden = mode === 'none';
}

$('#save-btn').addEventListener('click', () => {
  $('#save-btn').classList.remove('nudge');
  if (store.mode() === 'auto') {
    // Autosaving: open Settings at the saving options instead of the save prompt.
    renderSourcePrefs();
    renderSaveSettings();
    dlg.showModal();
    $('#autosave-toggle').closest('label').scrollIntoView({ block: 'center' });
    return;
  }
  $('#save-msg').textContent = store.mode() === 'manual'
    ? `You have changes to ${unsavedSummary()} that aren't saved yet. Your last save will load next time unless you save again.`
    : `Nothing is saved right now, so closing this page loses your place in ${unsavedSummary()}.`;
  saveDlg.returnValue = '';
  saveDlg.showModal();
});

function doSave(auto) {
  const ok = auto ? store.setAutosave(true) : store.saveOnce();
  toast(ok
    ? (auto ? 'Saved. Autosave is on.' : 'Saved in this browser.')
    : 'This browser blocked saving (private browsing, or storage turned off).');
}
saveDlg.addEventListener('close', () => setTimeout(maybeReload, 0));
saveDlg.addEventListener('close', () => {
  // Not now, the close button or Escape: stop drawing attention for this visit.
  if (saveDlg.returnValue !== 'saved') { quiet = true; updateSaveIndicator(); }
});
$('#save-auto').addEventListener('click', () => { doSave(true); saveDlg.close('saved'); });
$('#save-once').addEventListener('click', () => { doSave(false); saveDlg.close('saved'); });
$('#save-once-settings').addEventListener('click', () => { doSave(false); renderSaveSettings(); });

$('#autosave-toggle').addEventListener('change', (e) => {
  if (e.target.checked) doSave(true);
  else { store.setAutosave(false); toast('Autosave is off. What is already saved stays until you delete it.'); }
  renderSaveSettings();
});

$('#delete-saved').addEventListener('click', () => {
  if (!confirm('Delete everything this player saved in this browser? Your progress from this visit stays until you close the page.')) return;
  store.deleteSaved();
  toast('Saved data deleted from this browser.');
  renderSaveSettings();
});
dlg.addEventListener('close', () => setTimeout(maybeReload, 0));
dlg.addEventListener('close', () => {
  renderAll();
  if (state.current) renderSourceSelect();
});

function renderSourcePrefs() {
  const ol = $('#source-prefs');
  const order = state.prefs.order;
  const broken = localBroken();
  const eps = sourceImpact(state.data.episodes, state.prefs, order, broken);
  const ext = sourceImpact(state.extras, state.prefs, order, broken);
  const n = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  $('#source-summary').textContent = `With these settings: ${n(eps.playable, 'episode')} and ${n(ext.playable, 'extra')} playable`;

  ol.replaceChildren(...order.map((id, i) => {
    const s = state.sourceInfo.get(id);
    const on = state.prefs.enabled[id];
    const e = eps.bySource[id], x = ext.bySource[id];
    // "Only here": what no other switched-on source has. Red when on (turning it off loses them),
    // green when off (turning it on adds them). For a switched-off source that's what it would add.
    const only = (counts) => (on ? counts.onlyHere : counts.wouldAdd);
    const mark = (text) => el('span', { class: on ? 'only lose' : 'only gain', text });
    const parts = [el('span', { text: n(e.total, 'episode') })];
    if (e.total) parts.push(' · ', only(e) ? mark(`${only(e)} only here`) : el('span', { text: '0 only here' }));
    if (x.total) parts.push(' · ', el('span', { text: n(x.total, 'extra') }), only(x) ? mark(` (${only(x) === x.total ? 'all' : only(x)} only here)`) : null);
    const cb = el('input', { type: 'checkbox', checked: on, 'aria-label': `Use ${s.name}`,
      onchange: (ev) => {
        state.prefs.enabled[id] = ev.target.checked;
        store.setPrefs(state.prefs);
        renderSourcePrefs(); // counts depend on every switch
        ol.querySelectorAll('li')[i]?.querySelector('input')?.focus();
      } });
    const move = (d) => {
      const j = i + d;
      [order[i], order[j]] = [order[j], order[i]];
      store.setPrefs(state.prefs);
      renderSourcePrefs();
      ol.querySelectorAll('li')[j]?.querySelector(d < 0 ? '.up' : '.down')?.focus();
    };
    return el('li', {},
      cb,
      el('div', {},
        el('div', { class: 'name' }, s.name, s.official ? null : el('span', { class: 'tag', text: 'Unofficial copy' })),
        el('div', { class: 'desc', text: s.description }),
        el('div', { class: 'counts' }, parts.filter(Boolean))),
      el('div', { class: 'order-btns' },
        el('button', { type: 'button', class: 'up', 'aria-label': `Move ${s.name} up`, disabled: i === 0, onclick: () => move(-1), text: '↑' }),
        el('button', { type: 'button', class: 'down', 'aria-label': `Move ${s.name} down`, disabled: i === order.length - 1, onclick: () => move(1), text: '↓' })));
  }));
}

$('#reset-broken').addEventListener('click', () => { store.clearBroken(); toast('Links will be retried.'); });
$('#clear-history').addEventListener('click', () => {
  if (!confirm('Clear all listening progress saved in this browser?')) return;
  store.clearAllProgress();
  toast('Listening history cleared.');
});

// ---------- toast ----------

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(el('span', { text: msg }));
  if (action) {
    t.append(el('button', { type: 'button', class: 'toast-action', text: action.label, onclick: () => {
      t.classList.remove('show');
      action.run();
    } }));
  }
  t.classList.toggle('has-action', Boolean(action));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 3500);
}

// ---------- removing items from Continue ----------

const removed = new Set();

function removeProgress(ep) {
  const before = store.progress(ep.id);
  store.clearProgress(ep.id);
  removed.add(ep.id);
  renderContinue();
  refreshRows(ep.id);
  toast(`Removed "${ep.title}".`, {
    label: 'Undo',
    run: () => {
      if (before) store.setProgress(ep.id, before);
      removed.delete(ep.id);
      renderContinue();
      refreshRows(ep.id);
    },
  });
}

// ---------- staying up to date ----------
// A Home Screen web app on iPhone is resumed rather than reloaded, so it can stay on an old
// version indefinitely. Each deploy writes version.json; when the app comes back to the
// foreground (and every 15 minutes) it compares that with its own version and, if newer,
// reloads itself at a moment that won't interrupt anything.

const APP_VERSION = new URL(import.meta.url).searchParams.get('v') || 'dev';
let newVersion = null;
let lastCheck = 0;
const skipVersion = new URL(location.href).searchParams.get('updated'); // a reload already tried this one

async function checkForUpdate() {
  if (APP_VERSION === 'dev' || document.hidden || Date.now() - lastCheck < 60_000) return;
  lastCheck = Date.now();
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (version && version !== APP_VERSION && version !== skipVersion) {
      newVersion = version;
      maybeReload();
    }
  } catch { /* offline: try again later */ }
}

function busy() {
  if (state.current && !audio.paused) return 'playing';
  if (dlg.open || saveDlg.open) return 'dialog';
  if (document.activeElement?.matches('input, select, textarea')) return 'typing';
  return null;
}

function maybeReload() {
  if (!newVersion || busy()) return;
  // Reloading would lose progress that only lives in memory (saving not turned on). Stay on this
  // version quietly; it updates later once there's nothing to lose (e.g. after saving or a fresh open).
  if (store.hasUnsaved()) return;
  reloadForUpdate();
}

function reloadForUpdate() {
  saveNow();
  const u = new URL(location.href);
  u.searchParams.set('updated', newVersion); // also makes the address new, so the phone can't serve a cached old page
  u.searchParams.set('view', state.view);
  u.searchParams.set('y', String(Math.round(scrollY)));
  if (state.current) u.searchParams.set('item', state.current.item.id);
  location.replace(u.href);
}

/** After an update reload: put the listener back where they were, then tidy the address. */
function restoreAfterUpdate() {
  const u = new URL(location.href);
  if (!u.searchParams.has('updated')) return;
  const view = u.searchParams.get('view');
  const y = Number(u.searchParams.get('y')) || 0;
  const item = state.byId.get(u.searchParams.get('item'));
  for (const k of ['updated', 'view', 'y', 'item']) u.searchParams.delete(k);
  history.replaceState(null, '', u.pathname + u.search + u.hash);
  if (item && state.current?.item.id !== item.id && playableNow(item)) playItem(item, { autoplay: false });
  if (view && view !== state.view && ['episodes', 'continue', 'extras'].includes(view)) showView(view);
  requestAnimationFrame(() => scrollTo(0, y));
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
window.addEventListener('pageshow', () => checkForUpdate());
window.addEventListener('focusout', () => setTimeout(maybeReload, 0));
audio.addEventListener('ended', maybeReload);
setInterval(checkForUpdate, 15 * 60_000);

updateSaveIndicator();
load();
