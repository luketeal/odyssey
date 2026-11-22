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

// Omny's public listing for the whole show (the RSS feed above only holds the latest 100).
export const OMNY_ORG = '6b62b447-e557-44a9-ae88-af6300da5440';
export const OMNY_PROGRAM = '51f96c51-29f2-40a8-b3e0-af95000ecd1e';
export const OMNY_API = `https://omny.fm/api/orgs/${OMNY_ORG}/programs/${OMNY_PROGRAM}/clips`;

// "FREE EPISODE: “Value of a Buck, Part 1”", "FREE EPISODE: "500" (plus bonus interviews!)", "FREE EPISODE! "The Sounds of Life" ..."
const FREE = /^FREE EPISODE\s*[:\-!]\s*(?:["“]([^"”]+)["”]?|(.+))/i;

/** Split podcast items into full-episode links and behind-the-scenes extras. */
export function splitItems(entries) {
  const links = [];
  const extras = [];
  for (const entry of entries) {
    const free = entry.title.match(FREE);
    if (free) {
      // `extra` lets the build put it back among extras if it isn't an Odyssey episode we know.
      links.push({ source: 'omny', url: entry.url, code: null, title: cleanTitle(free[1] ?? free[2]).replace(/,$/, ''),
        label: 'Podcast', duration: entry.duration, date: entry.date, via: 'omny', extra: entry });
    } else {
      extras.push(entry);
    }
  }
  return { links, extras };
}

export function parseOmny(xml) {
  const $ = cheerio.load(xml, { xml: true });
  const entries = [];
  $('item').each((_, item) => {
    const $i = $(item);
    const url = $i.find('enclosure').attr('url') || $i.find('media\\:content').attr('url');
    if (!url) return;
    const date = new Date($i.children('pubDate').text());
    entries.push({
      title: cleanTitle($i.children('title').first().text()),
      url,
      date: Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10),
      duration: parseDuration($i.find('itunes\\:duration').text()),
      description: stripHtml($i.children('description').text()).slice(0, 600),
      image: $i.find('itunes\\:image').attr('href') || null,
      guid: $i.children('guid').text() || url,
    });
  });
  return splitItems(entries);
}

export function fromApiClip(c) {
  return {
    title: cleanTitle(c.Title),
    url: c.AudioUrl,
    date: c.PublishedUtc ? c.PublishedUtc.slice(0, 10) : null,
    duration: c.DurationSeconds ? Math.round(c.DurationSeconds) : null,
    description: stripHtml(c.Description ?? '').slice(0, 600),
    image: c.ImageUrl || null,
    // Match the RSS <guid> exactly (older items were imported and keep their original id), so saved progress carries over.
    guid: c.ImportedId || c.Id,
  };
}

async function fetchAllClips() {
  const clips = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const url = `${OMNY_API}?pageSize=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const j = JSON.parse(await fetchText(url));
    clips.push(...(j.Clips ?? []));
    if (!j.Cursor || !j.Clips?.length) break;
    cursor = j.Cursor;
  }
  return clips.filter((c) => c.AudioUrl && c.Visibility === 'Public' && c.PublishState === 'Published');
}

export async function collect() {
  try {
    const clips = await fetchAllClips();
    if (clips.length < 100) throw new Error(`only ${clips.length} clips`);
    return { ...splitItems(clips.map(fromApiClip)), via: 'full listing' };
  } catch (err) {
    console.warn(`  omny: full listing failed (${err.message}); using the RSS feed (latest 100 only)`);
    return { ...parseOmny(await fetchText(OMNY_FEED)), via: 'RSS feed' };
  }
}
