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

test('source impact: totals, only-here, would-add follow the current switches', async () => {
  const { sourceImpact } = await import('../site/js/logic.js');
  const ids = ['subsplash', 'omny', 'wayback'];
  const eps = [
    { sources: [{ source: 'subsplash', url: 'a', status: 'ok' }] },                                            // only Subsplash
    { sources: [{ source: 'subsplash', url: 'b', status: 'ok' }, { source: 'omny', url: 'c', status: 'ok' }] }, // both
    { sources: [{ source: 'wayback', url: 'd', status: 'unchecked' }] },                                      // archive only
    { sources: [{ source: 'omny', url: 'e', status: 'broken' }, { source: 'wayback', url: 'f', status: 'ok' }] }, // podcast copy broken
  ];
  const prefs = { enabled: { subsplash: true, omny: true, wayback: false } };
  let r = sourceImpact(eps, prefs, ids);
  assert.equal(r.playable, 2);
  assert.deepEqual(r.bySource.subsplash, { total: 2, onlyHere: 1, wouldAdd: 0 });
  assert.deepEqual(r.bySource.omny, { total: 1, onlyHere: 0, wouldAdd: 0 }, 'broken links do not count');
  assert.deepEqual(r.bySource.wayback, { total: 2, onlyHere: 0, wouldAdd: 2 });
  // Turning the archive on changes what counts as "only here" elsewhere.
  r = sourceImpact(eps, { enabled: { subsplash: false, omny: true, wayback: true } }, ids);
  assert.deepEqual(r.bySource.omny, { total: 1, onlyHere: 1, wouldAdd: 0 });
  assert.deepEqual(r.bySource.subsplash, { total: 2, onlyHere: 0, wouldAdd: 1 });
  // A link that failed in this browser doesn't count either.
  assert.equal(sourceImpact(eps, prefs, ids, { a: Date.now() }).bySource.subsplash.onlyHere, 0);
});
