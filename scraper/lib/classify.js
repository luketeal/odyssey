// Decides which source bucket an audio URL belongs to, based on where it is hosted.
// Returns null for hosts we deliberately skip (dead, expired or unofficial copies).

const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|ogg)$/i;

export function isAudioUrl(url) {
  try {
    const u = new URL(url);
    return AUDIO_EXT.test(u.pathname) || /\/audios?\//.test(u.pathname);
  } catch {
    return false;
  }
}

/** Upgrade http:// to https:// so the player works on an https GitHub Pages site. */
export function toHttps(url) {
  return url.replace(/^http:\/\//i, 'https://');
}

export function classify(url, excludedHosts = []) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const is = (h) => host === h || host.endsWith(`.${h}`);

  if (excludedHosts.some(is)) return null;
  if (is('web.archive.org')) return 'wayback';
  if (is('subsplash.com')) return 'subsplash';
  if (is('omny.fm') || is('omnycontent.com')) return 'omny';
  if (is('swncdn.com') || is('salemweb.net')) return 'oneplace';
  if (is('focusonthefamily.com') || is('adventuresinodyssey.com') || is('tritondigital.com')) return 'focus-legacy';
  return null;
}
