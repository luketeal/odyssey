import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewItems, renderIssueBody, itemsFromBody, checkedActions, allActions, parseReply, episodeIdFrom, applyDecision } from '../scraper/review.js';

const byId = new Map([
  ['aio-215', { id: 'aio-215', code: '215', title: 'Caroling, Caroling' }],
  ['aio-467', { id: 'aio-467', code: '467', title: 'Broken Window' }],
  ['aio-fp05', { id: 'aio-fp05', code: 'FP05', title: "You're Not Gonna Believe This..." }],
  ['aio-428', { id: 'aio-428', code: '428', title: 'Combined', unlisted: true }],
]);
const report = {
  unmatched: [{ url: 'u1', title: 'Mystery', source: 'subsplash', closest: 'aio-467' }, { url: 'u2', title: 'Nothing like it', source: 'subsplash', closest: null }],
  flagged: [{ id: 'aio-215', url: 'u3', title: 'Here We Come a-Caroling', source: 'subsplash', reason: 'code 215 title mismatch' }],
  added: [{ id: 'aio-428', title: 'Combined', url: 'u4', source: 'subsplash' }],
};

test('items, choices and numbering; decided links are left out', () => {
  const items = buildReviewItems(report, ['u5'], { links: { u2: null }, reviewed: ['u5'] }, byId);
  assert.deepEqual(items.map((i) => [i.n, i.url, i.kind]), [[1, 'u1', 'unmatched'], [2, 'u3', 'guess'], [3, 'u4', 'added']]);
  assert.deepEqual(items[0].choices.map((c) => c.do), ['match', 'ignore']);
  assert.match(items[0].choices[0].label, /#467 Broken Window/);
});

test('rendered body round-trips: items and ticked boxes are read back exactly', () => {
  const items = buildReviewItems(report, [], { links: {} }, byId);
  const body = renderIssueBody(items);
  assert.equal(itemsFromBody(body).get(2).url, 'u2');
  assert.equal(allActions(body).length, 7);
  assert.deepEqual(checkedActions(body), []);
  // Tick "✅ Yes, it's #215…" on item 3, the way GitHub does when you tap the box.
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.startsWith('- [ ] ✅ Yes, it') && l.includes('Caroling'));
  lines[i] = lines[i].replace('- [ ]', '- [x]');
  assert.deepEqual(checkedActions(lines.join('\n')).map(({ n, url, do: d, ep }) => ({ n, url, do: d, ep })), [{ n: 3, url: 'u3', do: 'match', ep: 'aio-215' }]);
});

test('replies are read forgivingly', () => {
  const { commands, unknown } = parseReply('3 is 467\n#2 → #FP5\nmatch 1 to episode 467\nignore 4\naccept 5\nundo 6\n`7 = 215`\nthanks!');
  assert.deepEqual(commands, [
    { do: 'match', n: 3, code: '467' }, { do: 'match', n: 2, code: 'FP5' }, { do: 'match', n: 1, code: '467' },
    { do: 'ignore', n: 4 }, { do: 'accept', n: 5 }, { do: 'undo', n: 6 }, { do: 'match', n: 7, code: '215' },
  ]);
  assert.deepEqual(unknown, ['thanks!']);
});

test('episode references', () => {
  assert.equal(episodeIdFrom('467', byId), 'aio-467');
  assert.equal(episodeIdFrom('#467', byId), 'aio-467');
  assert.equal(episodeIdFrom('aio-467', byId), 'aio-467');
  assert.equal(episodeIdFrom('fp5', byId), 'aio-fp05');
  assert.equal(episodeIdFrom('9999', byId), null);
});

test('decisions edit overrides and can be undone', () => {
  let o = { links: { keep: ['aio-1'] } };
  o = applyDecision(o, { url: 'u1', do: 'match', ep: 'aio-467' }, byId).next;
  o = applyDecision(o, { url: 'u2', do: 'ignore' }, byId).next;
  o = applyDecision(o, { url: 'u4', do: 'keep' }, byId).next;
  assert.deepEqual(o, { links: { keep: ['aio-1'], u1: 'aio-467', u2: null }, reviewed: ['u4'] });
  o = applyDecision(o, { url: 'u2', do: 'undo' }, byId).next;
  o = applyDecision(o, { url: 'u4', do: 'undo' }, byId).next;
  assert.deepEqual(o, { links: { keep: ['aio-1'], u1: 'aio-467' }, reviewed: [] });
});
