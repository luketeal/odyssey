#!/usr/bin/env node
// Keeps one "Match review" GitHub issue in step with reports/review.json (run by the nightly workflow).
//   - items and no open issue      -> open one
//   - items and an open issue      -> refresh its list; comment only when new items appear
//   - no items and an open issue   -> say so and close it
// Needs GH_TOKEN and the gh CLI.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderIssueBody, itemsFromBody } from './review.js';

const LABEL = 'match-review';
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;

async function withFile(text, fn) {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'review-')), 'body.md');
  await fs.writeFile(file, text);
  return fn(file);
}

const { items } = JSON.parse(await fs.readFile('reports/review.json', 'utf8'));
try { gh('label', 'create', LABEL, '--color', '0E8A16', '--description', 'Links waiting for a decision (tick a box to answer)', '--force'); } catch {}
const open = JSON.parse(gh('issue', 'list', '--label', LABEL, '--state', 'open', '--json', 'number,body', '--limit', '1'))[0];
const title = `Match review: ${items.length} link${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} a decision`;

if (!items.length) {
  if (open) {
    await withFile('✅ Everything has been reviewed. Closing until something new needs a decision.\n', (f) => gh('issue', 'comment', String(open.number), '--body-file', f));
    gh('issue', 'close', String(open.number));
    console.log(`Nothing to review: closed #${open.number}.`);
  } else console.log('Nothing to review.');
  process.exit(0);
}

const body = renderIssueBody(items, { runUrl });
if (!open) {
  const url = await withFile(body, (f) => gh('issue', 'create', '--title', title, '--label', LABEL, '--body-file', f));
  console.log(`Opened ${url}`);
} else {
  const before = new Set([...itemsFromBody(open.body).values()].map((i) => i.url));
  const fresh = items.filter((i) => !before.has(i.url));
  const strip = (b) => b.replace(/<sub>Last updated by .*<\/sub>\n?/, '');
  if (strip(open.body ?? '') !== strip(body)) {
    await withFile(body, (f) => gh('issue', 'edit', String(open.number), '--title', title, '--body-file', f));
    console.log(`Refreshed #${open.number}.`);
  } else console.log(`#${open.number} is up to date.`);
  if (fresh.length) {
    const note = `🆕 ${fresh.length} new item${fresh.length === 1 ? '' : 's'} to review: ${fresh.map((i) => `**${i.n}.** ${i.title ? `"${i.title}"` : i.url}`).join(', ')}\n`;
    await withFile(note, (f) => gh('issue', 'comment', String(open.number), '--body-file', f));
  }
}
