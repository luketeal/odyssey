// Title clean-up and comparison used when matching links to catalog episodes.

const WORD_NUMS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', i: '1', ii: '2', iii: '3', iv: '4' };

export function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, '-').replace(/&hellip;/g, '...')
    .replace(/&amp;/g, '&');
}

/** Tidy a title for display: strip wiki/HTML markup, outer quotes and stray whitespace. */
export function cleanTitle(s) {
  return decodeEntities(String(s))
    .replace(/<[^>]+>/g, '')
    .replace(/'''?/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/""/g, '"')
    .trim();
}

/** Normalise a title into a comparison key. "Part Two of 3" -> "p2". */
export function normTitle(s) {
  let t = cleanTitle(s).toLowerCase();
  t = t.replace(/&/g, ' and ');
  t = t.replace(/\bpart\s+([a-z0-9]+)(\s+of\s+[a-z0-9]+)?/g, (_, n) => ` p${WORD_NUMS[n] ?? n} `);
  t = t.replace(/['’]/g, '');
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();
  return t;
}

function bigrams(s) {
  const t = s.replace(/\s+/g, ' ');
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient on character bigrams of normalised titles (0..1). */
export function similarity(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x), B = bigrams(y);
  let overlap = 0, total = 0;
  for (const [g, n] of A) { overlap += Math.min(n, B.get(g) ?? 0); total += n; }
  for (const n of B.values()) total += n;
  return total ? (2 * overlap) / total : 0;
}

/** Normalise an episode code ("007" -> "7", "fp5" -> "FP05", "446A" -> "446a"). */
export function normCode(code) {
  if (code == null) return null;
  const c = String(code).trim();
  let m = c.match(/^0*(\d+)([a-z]?)$/i);
  if (m) return `${Number(m[1])}${m[2].toLowerCase()}`;
  m = c.match(/^([a-z]+)0*(\d+)$/i);
  if (m) return `${m[1].toUpperCase()}${String(Number(m[2])).padStart(m[1].length >= 2 ? 2 : 1, '0')}`;
  return null;
}

export function codeToId(code) {
  return `aio-${String(code).toLowerCase()}`;
}

export function slug(s) {
  return normTitle(s).replace(/\s+/g, '-').slice(0, 60);
}
