// Builds the master episode catalog from Wikipedia's "List of Adventures in Odyssey episodes".
// We read the page's wikitext (one request) rather than rendered HTML: it is far easier to parse.
// Only facts (numbers, titles, dates, albums) are kept; no article prose is copied.

import { fetchText } from '../lib/http.js';
import { cleanTitle, normCode, codeToId, slug } from '../lib/normalize.js';

export const WIKI_URL = 'https://en.wikipedia.org/w/index.php?title=List_of_Adventures_in_Odyssey_episodes&action=raw';
export const WIKI_PAGE = 'https://en.wikipedia.org/wiki/List_of_Adventures_in_Odyssey_episodes';

function section(text, startRe, endRe) {
  const start = text.search(startRe);
  if (start < 0) return '';
  const rest = text.slice(start);
  const end = rest.slice(1).search(endRe);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** Split "{{Episode list | a = b | c = {{start date|1987|11|21}} }}" into fields. */
function parseTemplate(body) {
  const fields = {};
  let depth = 0, cur = '';
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
    if (two === '}}' || two === ']]') { depth--; cur += two; i++; continue; }
    if (body[i] === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  parts.push(cur);
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) fields[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  return fields;
}

function parseStartDate(s) {
  const m = s && s.match(/\{\{\s*start date\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

/** "*446b: "Sticks and Stones" (This episode was pulled...)" -> { code, title, note } */
function parseBullet(line) {
  const m = line.match(/^\*\s*([A-Za-z]*\d+[a-z]?|\?\?\?)\s*:\s*(.+)$/);
  if (!m) return null;
  let rest = m[2].trim();
  let title, note = null;
  const q = rest.match(/^"([^"]*)"?\s*(.*)$/);
  if (q && rest.startsWith('"')) {
    title = q[1];
    note = q[2].replace(/^"+/, '').trim() || null;
  } else {
    const p = rest.match(/^(.*?)\s*(\(.*\))?$/);
    title = p[1];
    note = p[2] ?? null;
  }
  // A note in parentheses sometimes sits inside the quotes: "Missing Person (Remake of ...)"
  const paren = title.match(/^(.*?)\s+\((.*?)\)?[\s,]*$/);
  if (paren) { title = paren[1]; note = [paren[2], note].filter(Boolean).join(' ').replace(/[\s,]+$/, ''); }
  if (note) note = cleanTitle(note.replace(/^\(|\)$/g, ''));
  return { rawCode: m[1], title: cleanTitle(title), note };
}

export function parseWikitext(text) {
  const episodes = new Map();
  const order = [];

  const add = (ep) => {
    if (episodes.has(ep.id)) return episodes.get(ep.id);
    episodes.set(ep.id, ep);
    order.push(ep.id);
    return ep;
  };

  // --- Seasons ---
  const seasonsText = section(text, /^==\s*Episodes\s*==\s*$/m, /^==[^=]/m);
  const lines = seasonsText.split('\n');
  let season = null, year = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^===\s*Season\s+(\d+)\s*\((\d{4})\)\s*===/i);
    if (h) { season = Number(h[1]); year = Number(h[2]); continue; }

    if (/^\{\{\s*Episode list/i.test(line)) {
      let body = line, depth = (line.match(/\{\{/g) || []).length - (line.match(/\}\}/g) || []).length;
      while (depth > 0 && i + 1 < lines.length) {
        const l = lines[++i];
        body += '\n' + l;
        depth += (l.match(/\{\{/g) || []).length - (l.match(/\}\}/g) || []).length;
      }
      const f = parseTemplate(body.replace(/^\{\{|\}\}\s*$/g, ''));
      const code = normCode(f.EpisodeNumber);
      if (!code) continue;
      add({ id: codeToId(code), code, title: cleanTitle(f.Title ?? ''), season, year,
        airDate: parseStartDate(f.OriginalAirDate), note: null, albums: [] });
      continue;
    }

    const b = line.startsWith('*') && parseBullet(line);
    if (b) {
      const code = normCode(b.rawCode);
      const id = code ? codeToId(code) : `aio-x-${slug(b.title)}`;
      add({ id, code: code ?? null, title: b.title, season, year, airDate: null, note: b.note, albums: [] });
    }
  }

  // --- Episodes by album (adds album names; album-only episodes such as "Family Portraits") ---
  const albumText = section(text, /^==\s*Episodes by Album\s*==\s*$/mi, /^==[^=]/m);
  let album = null;
  for (const line of albumText.split('\n')) {
    if (line.startsWith("'''")) {
      const name = cleanTitle(line.replace(/'{2,}/g, '').replace(/\(\d{4}\)\s*"?\s*$/, '').replace(/"\s*$/, ''))
        .replace(/\s*\(\d{4}\)$/, '')
        .replace(/^(\d+)\s*-\s*/, '#$1 ');
      album = name || null;
      continue;
    }
    const b = line.startsWith('*') && parseBullet(line);
    if (!b || !album) continue;
    const code = normCode(b.rawCode);
    if (!code) continue;
    let ep = episodes.get(codeToId(code));
    if (!ep && /^[A-Z]/.test(code)) {
      ep = add({ id: codeToId(code), code, title: b.title, season: null, year: null, airDate: null, note: null, albums: [] });
    }
    if (ep && !ep.albums.includes(album)) ep.albums.push(album);
  }

  return order.map((id) => episodes.get(id));
}

export async function collect() {
  const text = await fetchText(WIKI_URL);
  const episodes = parseWikitext(text);
  if (episodes.length < 500) throw new Error(`Wikipedia parse looks wrong: only ${episodes.length} episodes`);
  return episodes;
}
