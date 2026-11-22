// The Official Adventures in Odyssey Podcast (Focus on the Family, hosted on Omny).
// Most items are behind-the-scenes "extras"; full episodes are marked "FREE EPISODE: <title>".

import * as cheerio from 'cheerio';
import { fetchText } from '../lib/http.js';
import { cleanTitle } from '../lib/normalize.js';

export const OMNY_FEED = 'https://www.omnycontent.com/d/playlist/6b62b447-e557-44a9-ae88-af6300da5440/51f96c51-29f2-40a8-b3e0-af95000ecd1e/13fcc980-8f6c-4071-ab82-af95000ecd35/podcast.rss';

export function parseDuration(s) {
  if (!s) return null;
  const parts = String(s).trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) || null;
}

function stripHtml(s) {
  return cleanTitle(String(s).replace(/<\/p>\s*<p>/g, '\n').replace(/<br\s*\/?>/g, '\n'));
}

export function parseOmny(xml) {
  const $ = cheerio.load(xml, { xml: true });
  const links = [];
  const extras = [];
  $('item').each((_, item) => {
    const $i = $(item);
    const title = cleanTitle($i.children('title').first().text());
    const url = $i.find('enclosure').attr('url') || $i.find('media\\:content').attr('url');
    if (!url) return;
    const date = new Date($i.children('pubDate').text());
    const entry = {
      title,
      url,
      date: Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10),
      duration: parseDuration($i.find('itunes\\:duration').text()),
      description: stripHtml($i.children('description').text()).slice(0, 600),
      image: $i.find('itunes\\:image').attr('href') || null,
      guid: $i.children('guid').text() || url,
    };
    // "FREE EPISODE: “Value of a Buck, Part 1”" or "FREE EPISODE: "500" (plus bonus interviews!)"
    const free = title.match(/^FREE EPISODE\s*[:\-]\s*(?:["“]([^"”]+)["”]?|(.+))/i);
    if (free) {
      links.push({ source: 'omny', url, code: null, title: cleanTitle(free[1] ?? free[2]), label: 'Podcast', duration: entry.duration, date: entry.date, via: 'omny' });
    } else {
      extras.push(entry);
    }
  });
  return { links, extras };
}

export async function collect() {
  return parseOmny(await fetchText(OMNY_FEED));
}
