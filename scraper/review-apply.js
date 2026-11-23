#!/usr/bin/env node
// Turns the owner's answers in the "Match review" issue into edits of config/overrides.json.
// Run by .github/workflows/review.yml on issue edits (ticked boxes) and new comments (replies).
// Writes reports/review-reply.md (the confirmation to post) and sets step outputs:
//   changed=true  overrides.json was modified (commit it and rerun the scraper)
//   reply=true    there is a reply to post

import fs from 'node:fs/promises';
import { checkedActions, allActions, itemsFromBody, parseReply, episodeIdFrom, applyDecision, epLabel } from './review.js';

const OVERRIDES = 'config/overrides.json';
const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const name = process.env.GITHUB_EVENT_NAME;
const data = JSON.parse(await fs.readFile('site/data/episodes.json', 'utf8'));
const byId = new Map(data.episodes.map((e) => [e.id, e]));
const label = (id) => epLabel(byId.get(id)) || id;

let overrides = JSON.parse(await fs.readFile(OVERRIDES, 'utf8'));
const body = event.issue?.body ?? '';
const items = itemsFromBody(body);
const decisions = []; // { n, url, do, ep, test }
const replies = [];

if (name === 'issues') {
  // Only boxes ticked in this edit (unchanged ticks were handled before).
  const before = new Set(checkedActions(event.changes?.body?.from ?? '').map((a) => JSON.stringify(a)));
  const ticked = checkedActions(body).filter((a) => !before.has(JSON.stringify(a)));
  const perItem = new Map();
  for (const a of ticked) perItem.set(a.url, [...(perItem.get(a.url) ?? []), a]);
  for (const [, list] of perItem) {
    if (list.length > 1) replies.push(`⚠️ Item ${list[0].n}: more than one box is ticked, so nothing was changed. Untick one, or reply e.g. \`ignore ${list[0].n}\`.`);
    else decisions.push(list[0]);
  }
} else if (name === 'issue_comment') {
  const { commands, unknown } = parseReply(event.comment?.body ?? '');
  for (const c of commands) {
    const item = items.get(c.n);
    if (!item) { replies.push(`⚠️ There's no item ${c.n} in this list.`); continue; }
    if (c.do === 'undo') decisions.push({ n: c.n, url: item.url, do: 'undo', test: item.test });
    else if (c.do === 'ignore') decisions.push({ n: c.n, url: item.url, do: 'ignore', test: item.test });
    else if (c.do === 'accept') {
      const first = allActions(body).find((a) => a.n === c.n);
      if (first) decisions.push(first); else replies.push(`⚠️ Item ${c.n} has no suggested answer to accept.`);
    } else if (c.do === 'match') {
      const ep = episodeIdFrom(c.code, byId);
      if (!ep) replies.push(`⚠️ Item ${c.n}: I couldn't find an episode "${c.code}". Nothing was changed. Try the episode number, e.g. \`${c.n} is 467\`.`);
      else decisions.push({ n: c.n, url: item.url, do: 'match', ep, test: item.test });
    }
  }
  if (!commands.length && unknown.length) {
    replies.push("🤔 I couldn't find an instruction in that reply, so nothing was changed. Examples: `3 is 467`, `ignore 3`, `accept 3`, `undo 3`.");
  }
}

let changed = false;
for (const d of decisions) {
  if (d.test) {
    replies.push(`🧪 Item ${d.n} is a test item: it would be ${d.do === 'match' ? `linked to ${label(d.ep)}` : d.do === 'ignore' ? 'ignored' : d.do === 'undo' ? 'reset' : 'kept'}. Nothing was changed.`);
    continue;
  }
  const { next, text } = applyDecision(overrides, d, byId);
  if (JSON.stringify(next) !== JSON.stringify(overrides)) changed = true;
  overrides = next;
  replies.push(`✅ Item ${d.n}: ${text}.`);
}

if (changed) {
  if (!overrides.reviewed?.length) delete overrides.reviewed;
  await fs.writeFile(OVERRIDES, JSON.stringify(overrides, null, 2) + '\n');
  replies.push('', 'Saved. The episode list updates and this issue refreshes in a few minutes.');
}
await fs.mkdir('reports', { recursive: true });
await fs.writeFile('reports/review-reply.md', replies.join('\n') + '\n');
const out = process.env.GITHUB_OUTPUT;
if (out) await fs.appendFile(out, `changed=${changed}\nreply=${replies.length > 0}\nsummary=${decisions.filter((d) => !d.test).map((d) => `item ${d.n} ${d.do}`).join(', ')}\n`);
console.log(replies.join('\n') || 'Nothing to do.');
