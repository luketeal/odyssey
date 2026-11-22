import test from 'node:test';
import assert from 'node:assert/strict';

import { normTitle, similarity, normCode } from '../scraper/lib/normalize.js';
import { classify, isAudioUrl } from '../scraper/lib/classify.js';
import { parseWikitext } from '../scraper/sources/wikipedia.js';
import { parseHeading, parseDantan } from '../scraper/sources/dantan.js';
import { parseOmny, fromApiClip, splitItems } from '../scraper/sources/omny.js';
import { matchAll } from '../scraper/match.js';
import { nextState } from '../scraper/check.js';

test('normTitle unifies part numbering and punctuation', () => {
  assert.equal(normTitle('The Jubilee Singers, Part 3 of 3'), normTitle('The Jubilee Singers, Part Three'));
  assert.equal(normTitle('“Gotcha!”'), 'gotcha');
  assert.ok(similarity('A Different Kind of Peer Presure', 'A Different Kind of Peer Pressure') > 0.9);
});

test('normCode', () => {
  assert.equal(normCode('007'), '7');
  assert.equal(normCode('446A'), '446a');
  assert.equal(normCode('FP5'), 'FP05');
  assert.equal(normCode('???'), null);
});

test('classify sorts hosts into sources', () => {
  const ex = ['amazonaws.com', 'cloudfront.net'];
  assert.equal(classify('https://web.archive.org/web/2014/media.focusonthefamily.com/a.mp3', ex), 'wayback');
  assert.equal(classify('https://cdn.subsplash.com/audios/X/1/audio.mp3', ex), 'subsplash');
  assert.equal(classify('https://media.focusonthefamily.com/aio/mp3/a.mp3', ex), 'focus-legacy');
  assert.equal(classify('https://x.s3.us-east-2.amazonaws.com/a.mp3', ex), null);
  assert.ok(isAudioUrl('https://cdn.subsplash.com/audios/FMDDCD/abc/audio.mp3'));
  assert.ok(!isAudioUrl('https://www.facebook.com/watch/?v=1'));
});

const WIKI = `
==Episodes==
===Season 1 (1987)===
{{Episode list
| EpisodeNumber   = 1
| Title           = Whit's Flop
| OriginalAirDate = {{start date|1987|11|21}}
}}
===Season 2 (1988)===
*7: "Promises, Promises"
*121: "Missing Person (Remake of Episodes #25 and #26, "Harley Takes the Case")
*428a: "The Eternal Birthday"
*428b: "Bethany's Imaginary Friend"
==Albums==
== Episodes by Album==
'''''Family Portraits''''' (1987)

* FP08: "The Letter"

'''''1 -''''' '''''The Adventure Begins''''' (1988)

* 001: "Whit's Flop"
== Gold Audio Series ==
`;

test('parseWikitext reads templates, bullets and albums', () => {
  const eps = parseWikitext(WIKI);
  const byId = Object.fromEntries(eps.map((e) => [e.id, e]));
  assert.equal(byId['aio-1'].title, "Whit's Flop");
  assert.equal(byId['aio-1'].airDate, '1987-11-21');
  assert.deepEqual(byId['aio-1'].albums, ['#1 The Adventure Begins']);
  assert.equal(byId['aio-7'].season, 2);
  assert.equal(byId['aio-121'].title, 'Missing Person');
  assert.equal(byId['aio-fp08'].title, 'The Letter');
});

test('parseHeading handles dantan title formats', () => {
  assert.deepEqual(parseHeading('Family Portraits Episode 8: The Letter'), { code: 'FP08', title: 'The Letter' });
  assert.deepEqual(parseHeading('446a: A Matter of Manners'), { code: '446a', title: 'A Matter of Manners' });
});

test('parseDantan keeps alternates and skips excluded hosts', () => {
  const html = `<ul><p class="parinlist" id="1988"></p>
    <li><a href="http://web.archive.org/web/1/media.focusonthefamily.com/a.mp3">7: Promises, Promises</a> |
        <a href="http://cdn.subsplash.com/audios/FMDDCD/x/audio.mp3">2020 airing</a></li>
    <li><a href="http://bucket.s3.us-east-2.amazonaws.com/b/audioFile.mp3">8: Dental Dilemma</a></li>
  </ul>`;
  const { links, skipped } = parseDantan(html, { excludedHosts: ['amazonaws.com'] });
  assert.equal(links.length, 2);
  assert.equal(links[1].url, 'https://cdn.subsplash.com/audios/FMDDCD/x/audio.mp3');
  assert.equal(links[1].label, '2020 airing');
  assert.equal(links[0].year, 1988);
  assert.equal(skipped.excluded, 1);
});

test('parseOmny separates free episodes from extras', () => {
  const xml = `<rss><channel>
    <item><title>FREE EPISODE: “Value of a Buck, Part 1”</title><enclosure url="https://traffic.omny.fm/1.mp3"/><itunes:duration>27:23</itunes:duration></item>
    <item><title>Meet the cast</title><enclosure url="https://traffic.omny.fm/2.mp3"/></item>
  </channel></rss>`;
  const r = parseOmny(xml);
  assert.equal(r.links[0].title, 'Value of a Buck, Part 1');
  assert.equal(r.links[0].duration, 1643);
  assert.equal(r.extras.length, 1);
});

test('matchAll: code, title, split episodes, overrides', () => {
  const catalog = parseWikitext(WIKI);
  const links = [
    { source: 'subsplash', url: 'u1', code: '7', title: 'Promises, Promises' },
    { source: 'omny', url: 'u2', code: null, title: "Whit's Flop" },
    { source: 'subsplash', url: 'u3', code: '428', title: "The Eternal Birthday & Bethany's Imaginary Friend" },
    { source: 'subsplash', url: 'u4', code: null, title: 'Something odd' },
    { source: 'subsplash', url: 'u5', code: null, title: 'Mislabelled' },
  ];
  const { episodes, report } = matchAll(catalog, links, { links: { u5: 'aio-121' } });
  const get = (id) => episodes.find((e) => e.id === id);
  assert.equal(get('aio-7').links[0].url, 'u1');
  assert.equal(get('aio-1').links[0].url, 'u2');
  assert.equal(get('aio-428a').links[0].url, 'u3');
  assert.equal(get('aio-428b').links[0].url, 'u3');
  assert.equal(get('aio-121').links[0].url, 'u5');
  assert.equal(report.unmatched.length, 1);
});

test('nextState needs two failures before "broken"', () => {
  const today = '2026-11-22';
  let s = nextState(undefined, { ok: true, size: 100 }, today);
  assert.equal(s.status, 'ok');
  s = nextState(s, { ok: false, why: 'timeout' }, today);
  assert.equal(s.status, 'ok');
  assert.equal(s.fails, 1);
  s = nextState(s, { ok: false, why: 'HTTP 404' }, today);
  assert.equal(s.status, 'broken');
  s = nextState(s, { ok: true, size: 100 }, today);
  assert.equal(s.status, 'ok');
  assert.equal(s.fails, 0);
});

test('Omny listing clips keep the RSS guid and split free episodes', () => {
  const imported = fromApiClip({ Id: 'abc', ImportedId: 'https://old/feed/item.mp3', Title: 'Remembering Earl Boen',
    AudioUrl: 'https://traffic.omny.fm/x.mp3', PublishedUtc: '2023-03-08T09:00:00Z', DurationSeconds: 1234.6, Description: '<p>Hi</p>' });
  assert.equal(imported.guid, 'https://old/feed/item.mp3');
  assert.equal(imported.date, '2023-03-08');
  assert.equal(imported.duration, 1235);
  assert.equal(fromApiClip({ Id: 'xyz', Title: 'New', AudioUrl: 'u' }).guid, 'xyz');

  const { links, extras } = splitItems([
    { title: 'FREE EPISODE! "The Sounds of Life" a Focus on the Family drama', url: 'a' },
    { title: 'FREE EPISODE: "House Guest," a drama from 1985.', url: 'b' },
    { title: 'Meet the cast', url: 'c' },
  ]);
  assert.deepEqual(links.map((l) => l.title), ['The Sounds of Life', 'House Guest']);
  assert.ok(links[0].extra, 'free episodes carry their extra entry in case they match no episode');
  assert.equal(extras.length, 1);
});
