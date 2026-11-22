import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcilePrefs, candidates, pickSource, resumePoint, recordPosition, fraction, matchesQuery } from '../site/js/logic.js';

const sources = [
  { id: 'subsplash', defaultEnabled: true },
  { id: 'omny', defaultEnabled: true },
  { id: 'wayback', defaultEnabled: false },
];
const ep = {
  id: 'aio-1', code: '1', title: "Whit's Flop", albums: ['#1 The Adventure Begins'],
  sources: [
    { source: 'wayback', url: 'w', status: 'unchecked' },
    { source: 'subsplash', url: 's', status: 'ok' },
    { source: 'omny', url: 'o', status: 'broken' },
  ],
};

test('archive is off by default; broken links are skipped', () => {
  const prefs = reconcilePrefs(null, sources);
  assert.deepEqual(candidates(ep, prefs).map((s) => s.url), ['s']);
  prefs.enabled.wayback = true;
  assert.deepEqual(candidates(ep, prefs).map((s) => s.url), ['s', 'w']);
  assert.deepEqual(candidates(ep, prefs, { s: Date.now() }).map((s) => s.url), ['w']);
});

test('listener order wins, and saved prefs pick up new sources', () => {
  const prefs = reconcilePrefs({ order: ['wayback', 'subsplash'], enabled: { wayback: true } }, sources);
  assert.deepEqual(prefs.order, ['wayback', 'subsplash', 'omny']);
  assert.equal(pickSource(ep, prefs, null).url, 'w');
  assert.equal(pickSource(ep, prefs, { last: 's' }).url, 's');
});

test('positions are per source and converted when switching copies', () => {
  let p = recordPosition(null, 's', 600, 1500, 1);
  assert.equal(resumePoint(p, 's', 1500).time, 600);
  const other = resumePoint(p, 'w', 1800);
  assert.ok(other.approximate);
  assert.equal(Math.round(other.time), 715); // 40% of 1800, minus a 5s rewind
  assert.ok(fraction(p) > 0.39 && fraction(p) < 0.41);
  p = recordPosition(p, 's', 1490, 1500, 2);
  assert.equal(p.done, true);
  assert.equal(resumePoint(p, 's', 1500).time, 0);
});

test('search matches number, title and album', () => {
  assert.ok(matchesQuery(ep, '#1'));
  assert.ok(matchesQuery(ep, 'whits flop'));
  assert.ok(matchesQuery(ep, 'adventure begins'));
  assert.ok(!matchesQuery(ep, 'green ring'));
});
