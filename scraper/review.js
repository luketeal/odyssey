// Match review: turns the matcher's open questions into a GitHub issue with tap-to-answer
// checkboxes, and turns ticked boxes / replies back into edits to config/overrides.json.
// Pure functions (no I/O) so everything here is unit-tested.
//
// Each choice line carries a hidden, encoded marker, so reading ticked boxes never depends on
// how the visible text is worded:  - [ ] ✅ Yes, it's #215 … <!-- review-action:BASE64 -->

import { normCode, codeToId } from './lib/normalize.js';

const SOURCE_NAMES = { subsplash: 'Subsplash', omny: 'Official Podcast', oneplace: 'OnePlace', 'focus-legacy': 'Focus on the Family (older)', wayback: 'Internet Archive' };
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };
const epLabel = (ep) => (ep ? `${ep.code ? `#${ep.code} ` : ''}${ep.title}` : '');

/**
 * Build the list of items needing a decision.
 * @param report      matchAll() report ({ unmatched, flagged, added })
 * @param unknownHosts links skipped because their website isn't recognised
 * @param overrides   config/overrides.json ({ links, reviewed })
 * @param byId        Map of episode id -> episode (for labels)
 */
export function buildReviewItems(report, unknownHosts, overrides, byId, { simulate = false } = {}) {
  const decided = new Set([...Object.keys(overrides.links ?? {}), ...(overrides.reviewed ?? [])]);
  const items = [];
  const add = (item) => { if (!decided.has(item.url) && !items.some((i) => i.url === item.url)) items.push(item); };

  for (const u of report.unmatched ?? []) {
    const guess = u.closest && byId.get(u.closest);
    add({ kind: 'unmatched', url: u.url, title: u.title, source: u.source, why: 'No episode matched this link.',
      choices: [...(guess ? [{ do: 'match', ep: guess.id, label: `✅ It's ${epLabel(guess)}` }] : []), { do: 'ignore', label: '🚫 Ignore this link (not an episode)' }] });
  }
  for (const f of report.flagged ?? []) {
    const ep = byId.get(f.id);
    add({ kind: 'guess', url: f.url, title: f.title, source: f.source, why: `Matched to ${epLabel(ep)} by a guess: ${f.reason}.`,
      choices: [{ do: 'match', ep: f.id, label: `✅ Yes, it's ${epLabel(ep)}` }, { do: 'ignore', label: '🚫 Wrong: ignore this link' }] });
  }
  for (const a of report.added ?? []) {
    add({ kind: 'added', url: a.url, title: a.title, source: a.source, why: `Became episode ${epLabel(byId.get(a.id))}, which isn't in Wikipedia's list.`,
      choices: [{ do: 'keep', label: '✅ Looks right, keep it' }, { do: 'ignore', label: '🚫 Ignore this link' }] });
  }
  for (const url of unknownHosts ?? []) {
    add({ kind: 'host', url, title: null, source: null, why: "Skipped: it's on a website the scraper doesn't recognise.",
      choices: [{ do: 'keep', label: '👍 Fine, stop showing this' }] });
  }
  if (simulate) {
    add({ kind: 'unmatched', url: 'https://example.invalid/review-test.mp3', title: 'Review test item', source: 'test', test: true,
      why: 'Test item from a simulated run. Ticking a box here changes nothing.',
      choices: [{ do: 'match', ep: 'aio-1', label: `✅ It's ${epLabel(byId.get('aio-1')) || '#1'}` }, { do: 'ignore', label: '🚫 Ignore this link (not an episode)' }] });
  }
  return items.map((item, i) => ({ ...item, n: i + 1 }));
}

export function renderIssueBody(items, { runUrl = null } = {}) {
  const lines = [
    `The scraper found ${items.length} link${items.length === 1 ? '' : 's'} that need${items.length === 1 ? 's' : ''} a decision.`,
    '',
    '**Tick one box per item.** Your choice is saved automatically, and this list updates within a few minutes.',
    'If an item is a different episode, reply with the item number and the episode number, for example `3 is 467`. Reply `undo 3` to take a choice back.',
    '',
  ];
  for (const it of items) {
    lines.push(`### ${it.n}. ${it.title ? `"${it.title}"` : 'Link'}${it.source ? ` (${SOURCE_NAMES[it.source] ?? it.source})` : ''}`);
    lines.push(`<!-- review-item:${enc({ n: it.n, url: it.url, test: !!it.test })} -->`);
    lines.push(`${it.why} [Listen](${it.url})`, '');
    for (const c of it.choices) lines.push(`- [ ] ${c.label} <!-- review-action:${enc({ n: it.n, url: it.url, do: c.do, ep: c.ep ?? null, test: !!it.test })} -->`);
    lines.push('');
  }
  if (runUrl) lines.push(`<sub>Last updated by ${runUrl}</sub>`);
  return lines.join('\n') + '\n';
}

/** Item number -> { url, test } from an issue body. */
export function itemsFromBody(body) {
  const map = new Map();
  for (const m of String(body).matchAll(/<!-- review-item:([A-Za-z0-9_-]+) -->/g)) {
    const o = dec(m[1]);
    if (o?.url) map.set(o.n, o);
  }
  return map;
}

/** Every choice in an issue body, ticked or not. */
export function allActions(body) {
  const out = [];
  for (const m of String(body).matchAll(/^\s*[-*] \[[ xX]\] .*<!-- review-action:([A-Za-z0-9_-]+) -->/gm)) {
    const o = dec(m[1]);
    if (o?.url && o.do) out.push(o);
  }
  return out;
}

/** Ticked choices in an issue body. */
export function checkedActions(body) {
  const out = [];
  for (const m of String(body).matchAll(/^\s*[-*] \[[xX]\] .*<!-- review-action:([A-Za-z0-9_-]+) -->/gm)) {
    const o = dec(m[1]);
    if (o?.url && o.do) out.push(o);
  }
  return out;
}

/**
 * Commands in a reply. Forgiving about wording; looks for "undo N", "ignore N", "accept N"
 * and "N <is|=|->|to|…> <episode>".
 * @returns {{ commands: object[], unknown: string[] }}
 */
export function parseReply(text) {
  const commands = [];
  const unknown = [];
  for (const raw of String(text).split(/\r?\n|;/)) {
    const line = raw.replace(/[`*_]/g, '').trim();
    if (!line || line.startsWith('>')) continue;
    let m;
    if ((m = line.match(/\bundo\s+(?:item\s*)?#?(\d+)\b/i))) commands.push({ do: 'undo', n: Number(m[1]) });
    else if ((m = line.match(/\bignore\s+(?:item\s*)?#?(\d+)\b/i))) commands.push({ do: 'ignore', n: Number(m[1]) });
    else if ((m = line.match(/\b(?:accept|keep|yes)\s+(?:item\s*)?#?(\d+)\b/i))) commands.push({ do: 'accept', n: Number(m[1]) });
    else if ((m = line.match(/^(?:match\s+)?(?:item\s*)?#?(\d+)\s*(?:is|=|:|->|→|to|as|with|belongs to)\s*(?:episode|ep\.?)?\s*#?([A-Za-z]{0,2}\d+[a-z]?)\b/i))) {
      commands.push({ do: 'match', n: Number(m[1]), code: m[2] });
    } else unknown.push(line);
  }
  return { commands, unknown };
}

/** "467", "#467", "aio-467", "FP5", "446a" -> catalog id (or null). */
export function episodeIdFrom(ref, byId) {
  const r = String(ref).trim();
  if (byId.has(r)) return r;
  const code = normCode(r.replace(/^aio-/i, '').replace(/^#/, ''));
  const id = code && codeToId(code);
  return id && byId.has(id) ? id : null;
}

/**
 * Apply one decision to overrides (returns a new object) and a human description.
 * Actions: match (url -> episode), ignore (url -> null), keep (mark reviewed), undo.
 */
export function applyDecision(overrides, { url, do: action, ep = null }, byId) {
  const next = { ...overrides, links: { ...(overrides.links ?? {}) }, reviewed: [...(overrides.reviewed ?? [])] };
  const unreview = () => { next.reviewed = next.reviewed.filter((u) => u !== url); };
  switch (action) {
    case 'match': delete next.links[url]; unreview(); next.links[url] = ep; return { next, text: `linked to ${epLabel(byId.get(ep)) || ep}` };
    case 'ignore': unreview(); next.links[url] = null; return { next, text: 'ignored' };
    case 'keep': delete next.links[url]; if (!next.reviewed.includes(url)) next.reviewed.push(url); return { next, text: 'kept as it is' };
    case 'undo': delete next.links[url]; unreview(); return { next, text: 'decision removed (it will be reviewed again)' };
    default: return { next: overrides, text: `unknown action "${action}"` };
  }
}
