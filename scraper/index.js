#!/usr/bin/env node
// Collect -> match -> check -> build. Writes site/data/episodes.json and reports/match-report.md.
//
//   node scraper/index.js                 full run (archive links keep last week's status)
//   node scraper/index.js --check-wayback also re-check Internet Archive links (weekly in CI)
//   node scraper/index.js --no-check      skip link checking (fast, for local testing)
//   node scraper/index.js --skip-wayback  check everything except Internet Archive links

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as wikipedia from './sources/wikipedia.js';
import * as dantan from './sources/dantan.js';
import * as omny from './sources/omny.js';
import * as oneplace from './sources/oneplace.js';
import { matchAll } from './match.js';
import { checkLinks } from './check.js';
import { classify } from './lib/classify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site/data/episodes.json');
const REPORT = path.join(ROOT, 'reports/match-report.md');

const args = new Set(process.argv.slice(2));
const today = new Date().toISOString().slice(0, 10);

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function main() {
  const config = await readJson(path.join(ROOT, 'config/sources.json'));
  const overrides = await readJson(path.join(ROOT, 'config/overrides.json'), { links: {} });
  const prev = await readJson(OUT, null);
  const sourceCfg = new Map(config.sources.map((s) => [s.id, s]));
  const enabled = (id) => sourceCfg.get(id)?.scrape;
  const problems = [];

  // Previous links per source (with the episode they were attached to), for fallbacks and ephemeral sources.
  const prevLinks = [];
  const prevState = new Map();
  for (const ep of prev?.episodes ?? []) {
    for (const s of ep.sources) {
      prevLinks.push({ source: s.source, url: s.url, label: s.label ?? null, title: ep.title, code: null, duration: s.duration ?? null, fixedId: ep.id, via: 'previous run' });
      prevState.set(s.url, { status: s.status, fails: s.fails ?? 0, since: s.since, size: s.size ?? null });
    }
  }
  const carryForward = (source) => prevLinks.filter((l) => l.source === source);

  // 1. Catalog
  console.log('Collecting catalog from Wikipedia…');
  let catalog;
  try {
    catalog = await wikipedia.collect();
    console.log(`  ${catalog.length} episodes`);
  } catch (err) {
    if (!prev) throw err;
    problems.push(`Wikipedia failed (${err.message}); reused previous catalog.`);
    catalog = prev.episodes.filter((e) => !e.unlisted).map(({ sources, ...e }) => ({ ...e }));
  }

  // 2. Audio links. One failing source never empties the catalog: its previous links are reused.
  const links = [];
  let extras = prev?.extras ?? [];
  const unknownHosts = [];
  async function run(name, ids, fn) {
    if (!ids.some(enabled)) return;
    console.log(`Collecting ${name}…`);
    try {
      await fn();
    } catch (err) {
      problems.push(`${name} failed (${err.message}); reused its links from the previous run.`);
      for (const id of ids) links.push(...carryForward(id));
    }
  }

  await run('dantan.net', ['subsplash', 'focus-legacy', 'wayback'], async () => {
    const r = await dantan.collect({ excludedHosts: config.excludedHosts });
    links.push(...r.links);
    unknownHosts.push(...r.skipped.unknownHost);
    console.log(`  ${r.links.length} links (${r.skipped.excluded} skipped from excluded hosts)`);
  });
  await run('Official podcast', ['omny'], async () => {
    const r = await omny.collect();
    links.push(...r.links);
    extras = r.extras;
    console.log(`  ${r.links.length} free episodes, ${r.extras.length} extras`);
  });
  await run('OnePlace', ['oneplace'], async () => {
    const r = await oneplace.collect();
    links.push(...r.links);
    console.log(`  ${r.links.length} recent broadcasts`);
  });
  // Ephemeral sources only list the last few days, so keep what earlier runs found.
  for (const s of config.sources.filter((s) => s.ephemeral && s.scrape)) {
    const have = new Set(links.map((l) => l.url));
    links.push(...carryForward(s.id).filter((l) => !have.has(l.url)));
  }

  const kept = links.filter((l) => enabled(l.source) && classify(l.url, config.excludedHosts) !== null);

  // 3. Match
  const { episodes, report } = matchAll(catalog, kept, overrides);
  console.log(`Matched ${report.matched} links; ${report.unmatched.length} unmatched, ${report.flagged.length} flagged.`);

  // 4. Check
  const allLinks = episodes.flatMap((e) => e.links);
  const unique = [...new Map(allLinks.map((l) => [l.url, l])).values()];
  let state;
  if (args.has('--no-check')) {
    state = new Map(unique.map((l) => [l.url, prevState.get(l.url) ?? { status: 'unchecked', fails: 0, since: today }]));
  } else {
    console.log('Checking links…');
    const checkWayback = args.has('--check-wayback');
    state = await checkLinks(unique, prevState, {
      today,
      shouldCheck: (l) => {
        if (sourceCfg.get(l.source)?.check !== 'weekly') return true;
        if (args.has('--skip-wayback')) return false;
        return checkWayback || !prevState.has(l.url);
      },
    });
  }

  // 5. Build output
  const order = config.sources.map((s) => s.id);
  const out = {
    generatedAt: new Date().toISOString(),
    catalogSource: wikipedia.WIKI_PAGE,
    sources: config.sources.filter((s) => s.scrape).map(({ id, name, description, official, defaultEnabled }) => ({ id, name, description, official, defaultEnabled })),
    episodes: episodes.map((ep) => {
      const sources = ep.links
        .map((l) => {
          const st = state.get(l.url) ?? { status: 'unchecked', fails: 0, since: today };
          return { source: l.source, url: l.url, label: l.label ?? null, duration: l.duration ?? null, status: st.status, fails: st.fails, since: st.since, size: st.size ?? null, _why: st.why, _note: st.note };
        })
        .filter((s) => !(sourceCfg.get(s.source)?.ephemeral && s.status === 'broken'))
        .sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
      const { links: _l, ...rest } = ep;
      return { ...rest, sources };
    }),
    extras,
  };

  // Report (written before the underscore fields are stripped)
  const md = buildReport(out, report, problems, unknownHosts);
  for (const ep of out.episodes) for (const s of ep.sources) { delete s._why; delete s._note; }

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.mkdir(path.dirname(REPORT), { recursive: true });
  const stable = (o) => JSON.stringify({ ...o, generatedAt: null });
  if (prev && stable(prev) === stable(out)) {
    console.log('No changes to episodes.json.');
  } else {
    await fs.writeFile(OUT, JSON.stringify(out) + '\n');
    console.log(`Wrote ${path.relative(ROOT, OUT)}`);
  }
  await fs.writeFile(REPORT, md);
  console.log(`Wrote ${path.relative(ROOT, REPORT)}`);
  if (problems.length) console.warn('Problems:\n  ' + problems.join('\n  '));
}

function buildReport(out, report, problems, unknownHosts) {
  const eps = out.episodes;
  const playable = eps.filter((e) => e.sources.some((s) => s.status !== 'broken'));
  const bySource = {};
  for (const e of eps) for (const s of e.sources) {
    const b = (bySource[s.source] ??= { ok: 0, broken: 0, unchecked: 0 });
    b[s.status] = (b[s.status] ?? 0) + 1;
  }
  const onlyArchive = eps.filter((e) => e.sources.length && e.sources.every((s) => s.source === 'wayback'));
  const lines = [
    '# Match report',
    '',
    `Generated ${out.generatedAt}. Fix anything below once in \`config/overrides.json\`; the fix applies on every future run.`,
    '',
    '## Summary',
    '',
    `- Catalog episodes: **${eps.length}**`,
    `- Episodes with at least one link that is not known to be broken: **${playable.length}**`,
    `- Episodes whose only links are Internet Archive copies (hidden unless a listener turns that source on): **${onlyArchive.length}**`,
    `- Podcast extras: **${out.extras.length}**`,
    '',
    '| Source | OK | Broken | Not yet checked |',
    '|---|---|---|---|',
    ...Object.entries(bySource).map(([k, v]) => `| ${k} | ${v.ok ?? 0} | ${v.broken ?? 0} | ${v.unchecked ?? 0} |`),
    '',
  ];
  if (problems.length) lines.push('## Source problems', '', ...problems.map((p) => `- ${p}`), '');
  const newlyBroken = eps.flatMap((e) => e.sources.filter((s) => s.status === 'broken' && s.since === out.generatedAt.slice(0, 10)).map((s) => ({ e, s })));
  if (newlyBroken.length) lines.push('## Newly broken today', '', ...newlyBroken.map(({ e, s }) => `- ${e.id} "${e.title}" (${s.source}): ${s._why ?? ''} ${s.url}`), '');
  const sizeNotes = eps.flatMap((e) => e.sources.filter((s) => s._note).map((s) => `- ${e.id} (${s.source}): ${s._note} ${s.url}`));
  if (sizeNotes.length) lines.push('## Files that changed size', '', ...sizeNotes, '');
  if (report.unmatched.length) lines.push('## Unmatched links', '', ...report.unmatched.map((u) => `- [${u.source}] "${u.title}" ${u.url}\n  - ${u.reason}`), '');
  if (report.flagged.length) lines.push('## Matched, but worth a look', '', ...report.flagged.map((f) => `- ${f.id}: ${f.reason}`), '');
  if (report.added.length) lines.push('## Episodes added from links (not in the Wikipedia list)', '', ...report.added.map((a) => `- ${a.id} "${a.title}"`), '');
  if (unknownHosts.length) lines.push('## Links on unrecognised hosts (skipped)', '', ...unknownHosts.map((u) => `- ${u}`), '');
  return lines.join('\n') + '\n';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
