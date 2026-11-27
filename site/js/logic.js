// Pure functions (no DOM, no storage) so they can be unit-tested in Node.

/** Default listener preferences derived from the data file's source list. */
export function defaultPrefs(sources) {
  return {
    order: sources.map((s) => s.id),
    enabled: Object.fromEntries(sources.map((s) => [s.id, s.defaultEnabled !== false])),
    rate: 1,
  };
}

/** Merge saved prefs with the current source list (new sources appended, removed ones dropped). */
export function reconcilePrefs(saved, sources) {
  const base = defaultPrefs(sources);
  if (!saved) return base;
  const ids = new Set(sources.map((s) => s.id));
  const order = (saved.order ?? []).filter((id) => ids.has(id));
  for (const id of base.order) if (!order.includes(id)) order.push(id);
  const enabled = { ...base.enabled };
  for (const id of ids) if (typeof saved.enabled?.[id] === 'boolean') enabled[id] = saved.enabled[id];
  return { ...base, ...saved, order, enabled };
}

/**
 * Sources for an episode the player may try, best first.
 * Skips sources the listener turned off, links the scraper marked broken,
 * and links that failed in this browser recently.
 */
export function candidates(episode, prefs, localBroken = {}) {
  const rank = (id) => { const i = prefs.order.indexOf(id); return i < 0 ? 999 : i; };
  return episode.sources
    .filter((s) => prefs.enabled[s.source] && s.status !== 'broken' && !localBroken[s.url])
    .sort((a, b) => rank(a.source) - rank(b.source) || statusRank(a) - statusRank(b));
}

const statusRank = (s) => (s.status === 'ok' ? 0 : 1);

/** Which source to start with: the one used last time, if still allowed, else the best candidate. */
export function pickSource(episode, prefs, progress, localBroken = {}) {
  const list = candidates(episode, prefs, localBroken);
  const last = progress?.last && list.find((s) => s.url === progress.last);
  return last ?? list[0] ?? null;
}

/**
 * Where to resume on `source`. Positions are stored per link because copies differ in length
 * (broadcast intros, credits). If only another copy has a position, convert proportionally.
 * @returns {{ time: number, approximate: boolean }}
 */
export function resumePoint(progress, sourceUrl, duration) {
  if (!progress || progress.done) return { time: 0, approximate: false };
  const own = progress.pos?.[sourceUrl];
  if (own != null) return { time: own, approximate: false };
  // Fall back to the most recently saved position on any other copy.
  const other = progress.last && progress.last !== sourceUrl ? progress.last : Object.keys(progress.pos ?? {})[0];
  const pos = other && progress.pos?.[other];
  const dur = other && progress.dur?.[other];
  if (pos && dur && duration) return { time: Math.max(0, (pos / dur) * duration - 5), approximate: true };
  return { time: 0, approximate: false };
}

export const DONE_FRACTION = 0.96;

/** Return an updated progress record after saving a position. */
export function recordPosition(progress, sourceUrl, time, duration, now = Date.now()) {
  const p = { pos: {}, dur: {}, ...progress, pos: { ...(progress?.pos ?? {}) }, dur: { ...(progress?.dur ?? {}) } };
  const done = duration > 0 && (time / duration >= DONE_FRACTION || duration - time < 20);
  p.pos[sourceUrl] = done ? 0 : Math.floor(time);
  if (duration > 0) p.dur[sourceUrl] = Math.round(duration);
  p.last = sourceUrl;
  p.updated = now;
  if (done) p.done = true;
  else if (time > 30) p.done = false; // re-listening clears "finished" once they're well into it
  return p;
}

/** 0..1 for the progress bar. */
export function fraction(progress) {
  if (!progress) return 0;
  if (progress.done) return 1;
  const u = progress.last;
  const pos = progress.pos?.[u], dur = progress.dur?.[u];
  return pos && dur ? Math.min(1, pos / dur) : 0;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Lowercase, accent- and punctuation-free text for search. */
export function searchKey(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '').replace(/[^a-z0-9#]+/g, ' ').trim();
}

export function matchesQuery(ep, q) {
  if (!q) return true;
  const hay = searchKey(`${ep.code ?? ''} #${ep.code ?? ''} ${ep.title} ${(ep.albums ?? []).join(' ')} ${ep.year ?? ''} ${ep.date ?? ''} ${ep.description ?? ''}`);
  return searchKey(q).split(' ').every((w) => hay.includes(w));
}

/**
 * What each source contributes, given the listener's current switches (same rules as the player).
 * @param items  episodes or extras ({ sources: [{ source, url, status }] })
 * @returns {{ playable: number, bySource: { [id]: { total, onlyHere, wouldAdd } } }}
 *   total     items with a usable link from this source
 *   onlyHere  (source on)  items that only this source makes playable: turning it off hides them
 *   wouldAdd  (source off) items not playable now that this source would make playable
 */
export function sourceImpact(items, prefs, sourceIds, localBroken = {}) {
  const usable = (s) => s.status !== 'broken' && !localBroken[s.url];
  const playableWith = (ep, enabled) => ep.sources.some((s) => enabled[s.source] && usable(s));
  const now = prefs.enabled;
  const bySource = {};
  for (const id of sourceIds) {
    const flipped = { ...now, [id]: !now[id] };
    let total = 0, onlyHere = 0, wouldAdd = 0;
    for (const ep of items) {
      if (ep.sources.some((s) => s.source === id && usable(s))) total++;
      const before = playableWith(ep, now);
      const after = playableWith(ep, flipped);
      if (now[id] && before && !after) onlyHere++;
      if (!now[id] && !before && after) wouldAdd++;
    }
    bySource[id] = { total, onlyHere, wouldAdd };
  }
  return { playable: items.filter((ep) => playableWith(ep, now)).length, bySource };
}

/** "2026-11-20" -> "Nov 20, 2026" (also inside text like "Aired 2026-11-20"). */
export function readableDates(text) {
  return String(text ?? '').replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) =>
    new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
}
