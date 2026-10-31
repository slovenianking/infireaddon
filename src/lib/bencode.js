// Minimalen bencode razčlenjevalnik za .torrent datoteke (brez odvisnosti).
// Vrne seznam datotek (za izbiro epizode v sezonskih paketih) in tracker URL-je.

const dec = new TextDecoder('utf-8', { fatal: false });

function decode(buf) {
  let pos = 0;

  function readInt(end) {
    let s = '';
    while (buf[pos] !== end) s += String.fromCharCode(buf[pos++]);
    pos++;
    return s;
  }

  function value() {
    const c = buf[pos];
    if (c === 0x69) {
      // i...e
      pos++;
      return Number(readInt(0x65));
    }
    if (c === 0x6c) {
      // l...e
      pos++;
      const arr = [];
      while (buf[pos] !== 0x65) arr.push(value());
      pos++;
      return arr;
    }
    if (c === 0x64) {
      // d...e
      pos++;
      const obj = {};
      while (buf[pos] !== 0x65) {
        const k = bytes();
        obj[dec.decode(k)] = value();
      }
      pos++;
      return obj;
    }
    return bytes();
  }

  function bytes() {
    const len = Number(readInt(0x3a));
    const out = buf.subarray(pos, pos + len);
    pos += len;
    return out;
  }

  return value();
}

const str = (v) => (v instanceof Uint8Array ? dec.decode(v) : String(v ?? ''));

export function parseTorrent(buf) {
  const t = decode(buf);
  const info = t.info || {};
  const trackers = [];
  if (t.announce) trackers.push(str(t.announce));
  for (const tier of t['announce-list'] || []) {
    for (const a of Array.isArray(tier) ? tier : [tier]) {
      const s = str(a);
      if (s && !trackers.includes(s)) trackers.push(s);
    }
  }

  let files;
  const rootName = str(info['name.utf-8'] || info.name);
  if (Array.isArray(info.files)) {
    files = info.files.map((f, idx) => {
      const parts = (f['path.utf-8'] || f.path || []).map(str);
      return { idx, path: parts.join('/'), size: Number(f.length) || 0 };
    });
  } else {
    files = [{ idx: 0, path: rootName, size: Number(info.length) || 0 }];
  }
  return { name: rootName, trackers, files, isPrivate: info.private === 1 };
}
