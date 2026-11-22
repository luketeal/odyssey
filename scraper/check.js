// Link checker. Requests only the first byte of each file and confirms the server answers
// with audio. A link is only marked "broken" after failing on two separate runs, so a brief
// outage (or a host that is slow with cloud servers) does not hide an episode.

import { fetchWithTimeout, mapLimit, sleep } from './lib/http.js';

const AUDIO_TYPES = /^(audio\/|video\/mp4|application\/octet-stream|binary\/octet-stream)/i;
export const FAILS_BEFORE_BROKEN = 2;

export async function probe(url, { timeout = 25000 } = {}) {
  try {
    const res = await fetchWithTimeout(url, { timeout, headers: { Range: 'bytes=0-0' } });
    const type = res.headers.get('content-type') ?? '';
    // Total size from "Content-Range: bytes 0-0/12345" helps spot a file silently replaced.
    const range = res.headers.get('content-range');
    const size = range?.match(/\/(\d+)$/)?.[1] ?? res.headers.get('content-length');
    res.body?.cancel().catch(() => {});
    if (res.status !== 200 && res.status !== 206) return { ok: false, why: `HTTP ${res.status}` };
    if (!AUDIO_TYPES.test(type)) return { ok: false, why: `not audio (${type || 'no type'})` };
    return { ok: true, size: size ? Number(size) : null };
  } catch (err) {
    return { ok: false, why: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

/** Combine a probe result with the previous state of the same link. */
export function nextState(prev, result, today) {
  const before = prev ?? { status: 'unchecked', fails: 0, since: today };
  if (result.ok) {
    const sizeChanged = before.size && result.size && before.size !== result.size;
    return {
      status: 'ok', fails: 0,
      since: before.status === 'ok' ? before.since : today,
      size: result.size ?? before.size ?? null,
      ...(sizeChanged ? { note: `file size changed from ${before.size} to ${result.size}` } : {}),
    };
  }
  const fails = (before.fails ?? 0) + 1;
  const broken = fails >= FAILS_BEFORE_BROKEN;
  return {
    status: broken ? 'broken' : before.status,
    fails,
    since: broken && before.status !== 'broken' ? today : before.since,
    size: before.size ?? null,
    why: result.why,
  };
}

/**
 * @param links   [{ url, source }]
 * @param prevState Map(url -> state)
 * @param opts.shouldCheck (link) => boolean  links not checked keep their previous state
 */
export async function checkLinks(links, prevState, { shouldCheck = () => true, today, log = console.log } = {}) {
  const state = new Map();
  const toCheck = [];
  for (const l of links) {
    if (shouldCheck(l)) toCheck.push(l);
    else state.set(l.url, prevState.get(l.url) ?? { status: 'unchecked', fails: 0, since: today });
  }
  // Wayback is slow and rate limited: run it separately with low concurrency.
  const slow = toCheck.filter((l) => l.source === 'wayback');
  const fast = toCheck.filter((l) => l.source !== 'wayback');
  log(`  checking ${fast.length} links (+${slow.length} archive links slowly)`);

  await mapLimit(fast, 8, async (l) => {
    state.set(l.url, nextState(prevState.get(l.url), await probe(l.url), today));
  });
  await mapLimit(slow, 3, async (l) => {
    state.set(l.url, nextState(prevState.get(l.url), await probe(l.url, { timeout: 30000 }), today));
    await sleep(1000);
  });
  return state;
}
