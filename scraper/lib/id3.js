// Minimal ID3v2 reader: pulls the text tags (title, album, track, artist, year) from the
// first bytes of an MP3. Used to identify files whose names say nothing about the episode.

const TEXT_FRAMES = { TIT2: 'title', TALB: 'album', TRCK: 'track', TPE1: 'artist', TYER: 'year', TDRC: 'year', TIT1: 'group' };

function synchsafe(b, i) {
  return (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];
}

function decodeText(bytes) {
  if (!bytes.length) return '';
  const enc = bytes[0];
  const body = bytes.subarray(1);
  let s;
  if (enc === 0) s = new TextDecoder('latin1').decode(body);
  else if (enc === 1) s = new TextDecoder('utf-16').decode(body); // has BOM
  else if (enc === 2) s = new TextDecoder('utf-16be').decode(body);
  else s = new TextDecoder('utf-8').decode(body);
  return s.replace(/\u0000+$/g, '').replace(/\u0000/g, ' / ').trim();
}

/** @param {Uint8Array} b first bytes of the file  @returns {object|null} */
export function readId3(b) {
  if (!b || b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null; // "ID3"
  const major = b[3];
  const tagSize = synchsafe(b, 6);
  const end = Math.min(b.length, 10 + tagSize);
  const out = {};
  let i = 10;
  if (b[5] & 0x40 && major >= 3) i += (major === 4 ? synchsafe(b, i) : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) + 4); // extended header
  while (i + 10 <= end) {
    if (major === 2) break; // ID3v2.2 (3-char frames) is rare for these files; skip
    const id = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = major === 4 ? synchsafe(b, i + 4) : (b[i + 4] << 24) | (b[i + 5] << 16) | (b[i + 6] << 8) | b[i + 7];
    if (size <= 0 || i + 10 + size > b.length) break;
    const key = TEXT_FRAMES[id];
    if (key && !out[key]) out[key] = decodeText(b.subarray(i + 10, i + 10 + size));
    i += 10 + size;
  }
  return Object.keys(out).length ? out : null;
}
