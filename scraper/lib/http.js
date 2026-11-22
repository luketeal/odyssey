// Small fetch helpers shared by every source module and the link checker.

// Wikimedia and others ask automated clients to identify themselves.
// Set SCRAPER_CONTACT (e.g. a repo URL) in the workflow to include contact info.
const contact = process.env.SCRAPER_CONTACT ? ` (+${process.env.SCRAPER_CONTACT})` : '';
export const USER_AGENT = `aio-episode-player-scraper/1.0${contact}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithTimeout(url, { timeout = 30000, headers = {}, method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: ctrl.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a text document, retrying network errors and 5xx responses. */
export async function fetchText(url, { retries = 2, timeout = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { timeout });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastErr = err;
    }
    await sleep(2000 * (attempt + 1));
  }
  throw lastErr;
}

/** Run async fn over items with at most `limit` in flight. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
