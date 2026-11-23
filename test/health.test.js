import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHealth, healthMarkdown } from '../scraper/health.js';

const sources = [
  { id: 'subsplash', name: 'Subsplash', scrape: true },
  { id: 'wayback', name: 'Internet Archive', scrape: true, defaultEnabled: false },
  { id: 'oneplace', name: 'OnePlace', scrape: true, ephemeral: true },
];
const ep = (id, links) => ({ id, code: id.slice(4), title: `Episode ${id}`, sources: links.map(([source, status, extra]) => ({ source, url: `${id}-${source}`, status, ...extra })) });
const data = (episodes, extras = [{ guid: 'x' }]) => ({ episodes, extras });

test('an episode that loses every link is reported, with reasons', () => {
  const prev = data([ep('aio-1', [['subsplash', 'ok']])]);
  const next = data([ep('aio-1', [['subsplash', 'broken', { _why: 'HTTP 404', since: '2026-11-24' }]])]);
  const h = assessHealth(prev, next, { sources });
  assert.equal(h.ok, false);
  assert.equal(h.lost.length, 1);
  assert.deepEqual(h.lost[0].links[0], { source: 'subsplash', url: 'aio-1-subsplash', why: 'HTTP 404', since: '2026-11-24' });
  assert.match(healthMarkdown(h), /#1 Episode aio-1[\s\S]*HTTP 404/);
});

test('still loadable from the Internet Archive: not lost', () => {
  const prev = data([ep('aio-2', [['subsplash', 'ok'], ['wayback', 'ok']])]);
  const next = data([ep('aio-2', [['subsplash', 'broken'], ['wayback', 'ok']])]);
  assert.equal(assessHealth(prev, next, { sources }).lost.length, 0);
});

test('losing one of several copies is not an alert', () => {
  const prev = data([ep('aio-3', [['subsplash', 'ok'], ['oneplace', 'ok']])]);
  const next = data([ep('aio-3', [['subsplash', 'ok']])]);
  assert.equal(assessHealth(prev, next, { sources }).ok, true);
});

test('an expiring OnePlace broadcast is expected, not an alert', () => {
  const prev = data([ep('aio-4', [['oneplace', 'ok']])]);
  const next = data([ep('aio-4', [])]);
  assert.equal(assessHealth(prev, next, { sources }).ok, true);
});

test('a link that disappears from its source is explained', () => {
  const prev = data([ep('aio-5', [['subsplash', 'ok']])]);
  const next = data([ep('aio-5', [])]);
  assert.equal(assessHealth(prev, next, { sources }).lost[0].links[0].why, 'no longer listed by the source');
});

test('source failures, big drops and recoveries', () => {
  const many = (n, status) => Array.from({ length: n }, (_, i) => ep(`aio-${100 + i}`, [['subsplash', status]]));
  const prev = data([...many(40, 'ok'), ep('aio-9', [['subsplash', 'broken']])]);
  const next = data([...many(40, 'broken'), ep('aio-9', [['subsplash', 'ok']])]);
  const h = assessHealth(prev, next, { sources, problems: ['dantan.net failed (timeout); reused its links from the previous run.'] });
  assert.equal(h.lost.length, 40);
  assert.ok(h.alerts.some((a) => a.startsWith('dantan.net failed')));
  assert.ok(h.alerts.some((a) => a.startsWith('Playable episodes dropped from 40 to 1')));
  assert.ok(h.alerts.some((a) => a.includes('"Subsplash" dropped from 40 to 1')));
  assert.deepEqual(h.recovered.map((e) => e.id), ['aio-9']);
});

test('first run (no previous data) and simulated alerts', () => {
  const next = data([ep('aio-1', [['subsplash', 'ok']])]);
  assert.equal(assessHealth(null, next, { sources }).ok, true);
  const sim = assessHealth(null, next, { sources, simulate: true });
  assert.equal(sim.ok, false);
  assert.match(healthMarkdown(sim), /Simulated alert/);
});
