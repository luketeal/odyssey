// Attaches every collected link to one catalog episode.
// Order of evidence: manual override > episode code (checked against title) > exact title > fuzzy title.
// Everything uncertain is written to the match report so it can be fixed once in config/overrides.json.

import { normTitle, similarity, codeToId } from './lib/normalize.js';

const CODE_TITLE_MIN = 0.5;  // code matches, but titles must look at least this alike
const FUZZY_MIN = 0.86;      // title-only matches must be this close...
const FUZZY_MARGIN = 0.06;   // ...and clearly better than the runner-up

export function buildTitleIndex(episodes) {
  const index = new Map();
  for (const ep of episodes) {
    const key = normTitle(ep.title);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(ep);
  }
  return index;
}

/** When a title exists more than once (e.g. a radio episode and its album re-release), prefer the numbered radio episode. */
function preferRadio(candidates) {
  return candidates.find((e) => /^\d/.test(e.code ?? '')) ?? candidates[0];
}

export function matchLink(link, { byId, byTitle, episodes, overrides }) {
  const ov = overrides.links?.[link.url];
  if (ov === null) return { ignored: true, reason: 'override' };
  if (Array.isArray(ov)) {
    const eps = ov.map((id) => byId.get(id)).filter(Boolean);
    return eps.length ? { eps, how: 'override' } : { issue: `override points to unknown episodes ${ov}` };
  }
  if (ov || link.fixedId) {
    const ep = byId.get(ov || link.fixedId);
    return ep ? { ep, how: 'override' } : { issue: `override points to unknown episode ${ov || link.fixedId}` };
  }

  const key = normTitle(link.title);
  const titleHits = byTitle.get(key) ?? [];

  if (link.code) {
    const ep = byId.get(codeToId(link.code));
    if (ep) {
      const sim = similarity(link.title, ep.title);
      if (sim >= CODE_TITLE_MIN) return { ep, how: 'code', sim };
      if (titleHits.length) return { ep: preferRadio(titleHits), how: 'title', note: `code ${link.code} is "${ep.title}" but title matched elsewhere` };
      return { ep, how: 'code', sim, issue: `code ${link.code} title mismatch: "${link.title}" vs "${ep.title}"` };
    }
    if (titleHits.length) return { ep: preferRadio(titleHits), how: 'title', note: `code ${link.code} not in catalog` };
    // A "split episode" broadcast (e.g. 428 = 428a + 428b in one file): attach to every half.
    const halves = ['a', 'b', 'c'].map((s) => byId.get(codeToId(link.code + s))).filter(Boolean);
    if (/^\d+$/.test(link.code) && halves.length) return { eps: halves, how: 'split' };
    return { newEpisode: true, issue: `code ${link.code} not in catalog; added from link` };
  }

  if (titleHits.length) return { ep: preferRadio(titleHits), how: 'title' };

  let best = null, second = 0;
  for (const ep of episodes) {
    const s = similarity(link.title, ep.title);
    if (!best || s > best.sim) { second = best?.sim ?? 0; best = { ep, sim: s }; }
    else if (s > second) second = s;
  }
  if (best && best.sim >= FUZZY_MIN && best.sim - second >= FUZZY_MARGIN) {
    return { ep: best.ep, how: 'fuzzy', sim: best.sim, issue: `fuzzy match "${link.title}" -> "${best.ep.title}" (${best.sim.toFixed(2)})` };
  }
  return { issue: `no match for "${link.title}"${best ? ` (closest: "${best.ep.title}" ${best.sim.toFixed(2)})` : ''}` };
}

/**
 * @returns {{ episodes, report: { matched, unmatched[], flagged[], added[] } }}
 * episodes get a `links` array of the matched raw links.
 */
export function matchAll(catalog, links, overrides = {}) {
  const episodes = catalog.map((e) => ({ ...e, links: [] }));
  const byId = new Map(episodes.map((e) => [e.id, e]));
  const byTitle = buildTitleIndex(episodes);
  const report = { matched: 0, ignored: 0, unmatched: [], flagged: [], added: [] };

  for (const link of links) {
    const r = matchLink(link, { byId, byTitle, episodes, overrides });
    if (r.ignored) { report.ignored++; continue; }
    if (r.eps) {
      for (const half of r.eps) {
        if (!half.links.some((l) => l.url === link.url)) half.links.push({ ...link, label: link.label ?? 'Full broadcast (includes both stories)' });
      }
      report.matched++;
      continue;
    }
    let ep = r.ep;
    if (r.newEpisode) {
      ep = { id: codeToId(link.code), code: link.code, title: link.title, season: null, year: link.year ?? null,
        airDate: null, note: null, albums: [], links: [], unlisted: true };
      episodes.push(ep);
      byId.set(ep.id, ep);
      const k = normTitle(ep.title);
      byTitle.set(k, [...(byTitle.get(k) ?? []), ep]);
      report.added.push({ id: ep.id, title: ep.title, url: link.url });
    }
    if (!ep) { report.unmatched.push({ ...link, reason: r.issue }); continue; }
    if (r.issue) report.flagged.push({ id: ep.id, url: link.url, reason: r.issue });
    if (!ep.links.some((l) => l.url === link.url)) ep.links.push(link);
    report.matched++;
  }
  return { episodes, report };
}
