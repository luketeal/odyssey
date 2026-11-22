// Reads the fan-curated link list at dev.dantan.net. Each <li> is one episode:
// the first link's text is "NUM: Title" and any further links are alternate copies
// ("broadcast version", "2020 airing", ...). We keep the links, not the page's prose.

import * as cheerio from 'cheerio';
import { fetchText } from '../lib/http.js';
import { classify, isAudioUrl, toHttps } from '../lib/classify.js';
import { cleanTitle, normCode } from '../lib/normalize.js';

export const DANTAN_URL = 'https://www.dev.dantan.net/aioEpisodes';

/** "Family Portraits Episode 5: X" -> {code:'FP05', title:'X'}; "446a: X" -> {code:'446a'} */
export function parseHeading(text) {
  const t = cleanTitle(text);
  let m = t.match(/^Family Portraits Episode\s*(\d+)\s*:\s*(.+)$/i);
  if (m) return { code: normCode(`FP${m[1]}`), title: m[2].trim() };
  m = t.match(/^The Truth Chronicles Episode\s*(\d+)\s*:\s*(.+)$/i);
  if (m) return { code: normCode(`TC${m[1]}`), title: m[2].trim() };
  m = t.match(/^#?\s*(\d+[a-z]?)\s*[:.\-]\s*(.+)$/i);
  if (m) return { code: normCode(m[1]), title: m[2].trim() };
  return { code: null, title: t };
}

export function parseDantan(html, { excludedHosts = [] } = {}) {
  const $ = cheerio.load(html);
  const links = [];
  const skipped = { excluded: 0, unknownHost: [] };

  $('li').each((_, li) => {
    if ($(li).closest('#links').length) return; // the page's own "related links" list
    const anchors = $(li).find('a').toArray();
    if (!anchors.length) return;
    const head = parseHeading($(anchors[0]).text());
    const year = Number($(li).prevAll('p.parinlist[id]').first().attr('id')) || null;

    anchors.forEach((a, idx) => {
      const href = $(a).attr('href');
      if (!href || !isAudioUrl(href)) return;
      // Old OnePlace/Salem broadcast links on this page have all expired.
      if (/swncdn\.com|salemweb\.net/i.test(href) && !/web\.archive\.org/i.test(href)) { skipped.excluded++; return; }
      const source = classify(href, excludedHosts);
      if (!source) {
        if (!excludedHosts.some((h) => href.includes(h))) skipped.unknownHost.push(href);
        else skipped.excluded++;
        return;
      }
      const label = idx === 0 ? null : cleanTitle($(a).text()) || null;
      links.push({ source, url: toHttps(href), code: head.code, title: head.title, label, year, via: 'dantan' });
    });
  });

  return { links, skipped };
}

export async function collect(config) {
  const html = await fetchText(DANTAN_URL);
  const result = parseDantan(html, config);
  if (result.links.length < 300) throw new Error(`dantan parse looks wrong: only ${result.links.length} links`);
  return result;
}
