#!/usr/bin/env node
// One-off discovery: search the Internet Archive's index (CDX API) for audio files in folders
// Focus on the Family has used, find ones we don't already link to, identify each one from its
// file name and embedded ID3 tags, and report which catalog episodes they would fill.
//
// It only writes reports (reports/wayback-discovery.json and .md); it never changes the site.
// Run by hand: node scraper/discover-wayback.js   (needs access to web.archive.org)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchWithTimeout, mapLimit, sleep } from './lib/http.js';
import { readId3 } from './lib/id3.js';
import { cleanTitle, normCode } from './lib/normalize.js';
import { matchAll } from './match.js';
import { parseHeading, parseDantan } from './sources/dantan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'site/data/episodes.json');
const OUT_JSON = path.join(ROOT, 'reports/wayback-discovery.json');
const OUT_MD = path.join(ROOT, 'reports/wayback-discovery.md');

// Folders worth searching. `keep` filters the results to likely Odyssey audio.
const PREFIXES = [
  { prefix: 'media.focusonthefamily.com/aio/', keep: /\.(mp3|m4a)$/i },
  { prefix: 'media.focusonthefamily.com/fotf/mp3/aio/', keep: /\.(mp3|m4a)$/i },
  { prefix: 'cdn.subsplash.com/audios/FMDDCD/', keep: /audio\.mp3$/i },
  { prefix: 'focusonthefamily.mc.tritondigital.com/OFF_ADVENT_ODYSS_P/', keep: /\.(mp3|m4a)$/i },
  { prefix: 'www.focusonthefamily.com/wp-content/uploads/', keep: /(ody|aio|odyssey)[^/]*\.(mp3|m4a)$/i },
  { prefix: 'cdn.adventuresinodyssey.com/', keep: /\.(mp3|m4a)$/i },
  { prefix: 'www.adventuresinodyssey.com/wp-content/uploads/', keep: /\.(mp3|m4a)$/i },
  { prefix: 'ht.salemweb.net/zcast/adventures-in-odyssey/', keep: /\.(mp3|m4a)$/i },
];

const CDX = 'https://web.archive.org/cdx/search/cdx';

/** Strip scheme, "www." and query so the same file is recognised however it was linked. */
export function fileKey(url) {
  return String(url)
    .replace(/^https?:\/\/web\.archive\.org\/web\/[^/]+\//i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/_source\//, '/')
    .toLowerCase();
}

async function cdxQuery(prefix) {
  const params = new URLSearchParams({
    url: prefix, matchType: 'prefix', output: 'json', collapse: 'urlkey',
    fl: 'original,timestamp,mimetype,statuscode,length', filter: 'statuscode:200', limit: '20000',
  });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetchWithTimeout(`${CDX}?${params}`, { timeout: 120000 });
      if (res.ok) {
        const rows = await res.json();
        return rows.slice(1).map(([original, timestamp, mimetype, statuscode, length]) => ({ original, timestamp, mimetype, length: Number(length) || null }));
      }
      console.warn(`  CDX ${prefix}: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`  CDX ${prefix}: ${err.message}`);
    }
    await sleep(10000 * (attempt + 1));
  }
  throw new Error(`CDX query failed for ${prefix}`);
}

/** Read the first `bytes` of a file (Range request; stream is cut if the server ignores Range). */
async function head(url, bytes = 131072, timeout = 45000) {
  const res = await fetchWithTimeout(url, { timeout, headers: { Range: `bytes=0-${bytes - 1}` } });
  if (res.status !== 200 && res.status !== 206) {
    res.body?.cancel().catch(() => {});
    return { ok: false, status: res.status };
  }
  const type = res.headers.get('content-type') ?? '';
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  while (got < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  reader.cancel().catch(() => {});
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return { ok: true, status: res.status, type, buf };
}

/** Guess code/title from a file name like AIO_625_Something_Significant.mp3 or 001-039-The-Case-of-....mp3 */
export function guessFromFilename(original) {
  const name = decodeURIComponent(original.split('/').pop().replace(/\.(mp3|m4a)$/i, ''));
  let m = name.match(/^AIO[_-](\d{1,4}[a-z]?)[_-](.+)$/i);
  if (m) return { code: normCode(m[1]), title: m[2].replace(/[_-]+/g, ' ') };
  m = name.match(/^\d{3}-(\d{3,4})-(.+)$/);
  if (m) return { code: normCode(m[1]), title: m[2].replace(/-+/g, ' ') };
  m = name.match(/^ody\d*_\d{4}-\d{2}-\d{2}-(.+)$/i);
  if (m) return { code: null, title: m[1].replace(/-+/g, ' ') };
  m = name.match(/adventures-in-odyssey_\d{4}-\d{2}-\d{2}_(.+?)_\d+$/i); // old OnePlace/Salem names (title truncated)
  if (m) return { code: null, title: m[1].replace(/-+/g, ' '), truncated: true };
  if (/^(aio|aiow|aiopodcast)[_-]?\d+$/i.test(name) || /^audio$/i.test(name) || /^[0-9a-f-]{30,}$/i.test(name)) return null; // no info in name
  return { code: null, title: name.replace(/[_-]+/g, ' ') };
}

/** Turn ID3 tags into code/title. Titles often look like "625: Something Significant" or "#625 Something". */
export function guessFromId3(tags) {
  if (!tags?.title) return null;
  // Subsplash and OnePlace files all carry the same generic title, which says nothing.
  if (/^adventures in odyssey( daily| podcast)?$/i.test(tags.title.trim())) return null;
  const t = cleanTitle(tags.title).replace(/^Adventures in Odyssey\s*[-:#]*\s*/i, '');
  const h = parseHeading(t.replace(/^#\s*/, ''));
  if (h.code) return { code: h.code, title: h.title };
  const track = tags.track && /^\d{1,4}$/.test(tags.track.split('/')[0]) && Number(tags.track.split('/')[0]) > 30 ? normCode(tags.track.split('/')[0]) : null;
  return { code: track, title: t };
}

async function main() {
  const data = JSON.parse(await fs.readFile(DATA, 'utf8'));
  const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config/sources.json'), 'utf8'));
  const known = new Set();
  for (const ep of data.episodes) for (const s of ep.sources) known.add(fileKey(s.url));
  for (const x of data.extras ?? []) known.add(fileKey(x.url));
  console.log(`Known audio files: ${known.size}`);

  // 1. Search the archive index
  const found = new Map();
  for (const { prefix, keep } of PREFIXES) {
    console.log(`Searching archive index: ${prefix}`);
    try {
      const rows = (await cdxQuery(prefix)).filter((r) => keep.test(r.original.replace(/[?#].*$/, '')));
      let fresh = 0;
      for (const r of rows) {
        const key = fileKey(r.original);
        if (known.has(key) || found.has(key)) continue;
        found.set(key, { ...r, prefix });
        fresh++;
      }
      console.log(`  ${rows.length} archived audio files, ${fresh} not already linked`);
    } catch (err) {
      console.warn(`  skipped: ${err.message}`);
    }
    await sleep(3000);
  }

  // 1b. Older copies of the dantan.net page: links it once listed (with titles) may since have gone.
  const fromPages = [];
  try {
    console.log('Searching archived copies of dantan.net/aioEpisodes…');
    const params = new URLSearchParams({ url: 'dev.dantan.net/aioEpisodes', output: 'json', fl: 'timestamp,digest', filter: 'statuscode:200', collapse: 'digest' });
    const res = await fetchWithTimeout(`${CDX}?${params}`, { timeout: 120000 });
    const snaps = res.ok ? (await res.json()).slice(1).map(([timestamp]) => timestamp) : [];
    // Spread out: at most 40 distinct versions.
    const pick = snaps.length <= 40 ? snaps : snaps.filter((_, i) => i % Math.ceil(snaps.length / 40) === 0);
    console.log(`  ${snaps.length} distinct versions archived; reading ${pick.length}`);
    const seen = new Set();
    for (const ts of pick) {
      try {
        const r = await fetchWithTimeout(`https://web.archive.org/web/${ts}id_/https://www.dev.dantan.net/aioEpisodes`, { timeout: 90000 });
        if (!r.ok) continue;
        const { links } = parseDantan(await r.text(), { excludedHosts: config.excludedHosts });
        for (const l of links) {
          const key = fileKey(l.url);
          if (known.has(key) || seen.has(key)) continue;
          seen.add(key);
          fromPages.push({ ...l, snapshot: ts });
        }
      } catch (err) { console.warn(`  version ${ts}: ${err.message}`); }
      await sleep(2000);
    }
    console.log(`  ${fromPages.length} links on older versions that the current page no longer has`);
  } catch (err) {
    console.warn(`  skipped: ${err.message}`);
  }
  // Their files are identified by the page's own titles; drop them from the anonymous-file pass.
  for (const l of fromPages) found.delete(fileKey(l.url));

  // 2. For each new file: is the original still live? What do its name and tags say?
  const items = [...found.values()];
  console.log(`Inspecting ${items.length} new files…`);
  let doneCount = 0;
  const results = await mapLimit(items, 4, async (r) => {
    const original = r.original.replace(/^http:/i, 'https:').replace(/:80\//, '/');
    const archived = `https://web.archive.org/web/${r.timestamp}id_/${r.original}`;
    const out = { original, archived, timestamp: r.timestamp, prefix: r.prefix, live: false, tags: null };
    try {
      const live = await head(original, 131072, 25000);
      if (live.ok && /audio|octet|mpeg/i.test(live.type)) { out.live = true; out.tags = readId3(live.buf); }
    } catch {}
    if (!out.tags) {
      try {
        const arc = await head(archived, 131072, 60000);
        if (arc.ok) { out.archiveOk = true; out.tags = readId3(arc.buf); }
        else out.archiveStatus = arc.status;
      } catch (err) { out.archiveError = err.message; }
      await sleep(800);
    }
    out.fromName = guessFromFilename(r.original);
    out.fromTags = guessFromId3(out.tags);
    if (++doneCount % 50 === 0) console.log(`  ${doneCount}/${items.length}`);
    return out;
  });

  // 3. Match to catalog episodes (tags first, then file name)
  const catalog = data.episodes.map(({ sources, ...e }) => e);
  // Links from older dantan versions: check the live file, else an archived copy.
  const pageLinks = await mapLimit(fromPages, 4, async (l) => {
    const original = l.url.replace(/^https?:\/\/web\.archive\.org\/web\/[^/]+\//i, 'https://');
    let live = false;
    try { const h = await head(original, 4096, 25000); live = h.ok && /audio|octet|mpeg/i.test(h.type); } catch {}
    return { source: live ? 'live' : 'wayback', url: live ? original : (l.url.includes('web.archive.org') ? l.url : `https://web.archive.org/web/2id_/${original}`),
      code: l.code, title: l.title, via: `old dantan page ${l.snapshot}`, r: { live, original, tags: null } };
  });

  const links = results.flatMap((r) => {
    const g = r.fromTags ?? r.fromName;
    if (!g?.title) return [];
    return [{ source: r.live ? 'live' : 'wayback', url: r.live ? r.original : r.archived, code: g.code, title: g.title, via: r.fromTags ? 'id3' : 'filename', r }];
  });
  const { episodes, report } = matchAll(catalog, [...pageLinks, ...links], {});
  const playableBefore = new Set(data.episodes.filter((e) => e.sources.some((s) => s.status !== 'broken')).map((e) => e.id));
  const defaultBefore = new Set(data.episodes.filter((e) => e.sources.some((s) => s.status !== 'broken' && s.source !== 'wayback')).map((e) => e.id));

  const matched = [];
  for (const ep of episodes) for (const l of ep.links) matched.push({ id: ep.id, title: ep.title, season: ep.season, ...l, r: undefined, live: l.r.live, tags: l.r.tags, original: l.r.original });
  const newly = matched.filter((m) => !playableBefore.has(m.id));
  const newlyLive = matched.filter((m) => m.live && !defaultBefore.has(m.id));

  const summary = {
    generatedAt: new Date().toISOString(),
    archivedFilesNotLinked: items.length,
    stillLiveAtOriginal: results.filter((r) => r.live).length,
    readableInArchive: results.filter((r) => r.archiveOk).length,
    withId3Title: results.filter((r) => r.tags?.title).length,
    linksOnOlderDantanVersions: fromPages.length,
    olderDantanLinksStillLive: pageLinks.filter((l) => l.r.live).length,
    identified: links.length + pageLinks.length,
    matchedToEpisodes: matched.length,
    unmatched: report.unmatched.length,
    episodesNewlyCovered: new Set(newly.map((m) => m.id)).size,
    episodesNewlyCoveredByLiveOfficialFiles: new Set(newlyLive.map((m) => m.id)).size,
  };
  console.log(JSON.stringify(summary, null, 2));

  const strip = (m) => ({ id: m.id, title: m.title, season: m.season, url: m.url, original: m.original, live: m.live, via: m.via, guessed: { code: m.code, title: m.title }, tags: m.tags });
  await fs.mkdir(path.dirname(OUT_JSON), { recursive: true });
  await fs.writeFile(OUT_JSON, JSON.stringify({
    summary,
    matched: matched.map(strip),
    unmatched: report.unmatched.map((u) => ({ url: u.url, guessed: { code: u.code, title: u.title }, via: u.via, reason: u.reason, tags: u.r?.tags })),
    unidentified: results.filter((r) => !(r.fromTags ?? r.fromName)?.title).map((r) => ({ original: r.original, live: r.live, archiveOk: r.archiveOk ?? false, tags: r.tags })),
    flagged: report.flagged,
  }, null, 1));

  const md = [
    '# Internet Archive discovery', '',
    `Generated ${summary.generatedAt}. Report only; nothing on the site changed.`, '',
    ...Object.entries(summary).filter(([k]) => k !== 'generatedAt').map(([k, v]) => `- ${k}: **${v}**`), '',
    '## Episodes that would become playable', '',
    ...[...new Map(newly.map((m) => [m.id, m])).values()].map((m) => `- ${m.id} "${m.title}" via ${m.via}${m.live ? ' (LIVE official file)' : ' (archive copy)'}`), '',
    '## Unmatched (identified but no catalog match)', '',
    ...report.unmatched.slice(0, 200).map((u) => `- "${u.title}" (${u.via}) ${u.url}`), '',
  ].join('\n');
  await fs.writeFile(OUT_MD, md);
  console.log(`Wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
