// OnePlace.com daily broadcasts. The RSS feed lists the last week of airings; each item's
// player page holds the actual MP3 address. These links expire, so they are "ephemeral":
// kept while they work and pruned once the checker confirms they are gone.

import * as cheerio from 'cheerio';
import { fetchText, sleep } from '../lib/http.js';
import { cleanTitle } from '../lib/normalize.js';

export const ONEPLACE_RSS = 'https://www.oneplace.com/ministries/adventures-in-odyssey/rss';

export function parseRss(xml) {
  const $ = cheerio.load(xml, { xml: true });
  return $('item').toArray().map((item) => {
    const $i = $(item);
    const date = new Date($i.children('pubDate').text());
    return {
      title: cleanTitle($i.children('title').text()),
      page: $i.children('link').text().trim(),
      date: Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10),
    };
  }).filter((i) => i.page);
}

export function parsePlayerPage(html) {
  const $ = cheerio.load(html);
  return $('audio[src]').attr('src') || $('audio source[src]').attr('src') || null;
}

export async function collect() {
  const items = parseRss(await fetchText(ONEPLACE_RSS));
  const links = [];
  for (const item of items) {
    const playerPage = item.page.replace('/listen/', '/player/');
    try {
      const url = parsePlayerPage(await fetchText(playerPage, { retries: 1 }));
      if (url) links.push({ source: 'oneplace', url, code: null, title: item.title, label: `Aired ${item.date}`, date: item.date, via: 'oneplace' });
    } catch (err) {
      console.warn(`  oneplace: could not read ${playerPage}: ${err.message}`);
    }
    await sleep(1500); // be gentle
  }
  return { links };
}
