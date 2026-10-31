// Ujemanje imena izdaje (release name) z naslovom iz Cinemeta in razčlenjevanje kakovosti.

export function normalize(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const TAIL_OK = /^((19|20)\d\d|s\d{1,2}(e\d{1,3})?|\d{1,2}x\d{1,3}|season|sezona|complete|2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr|web|webrip|webdl|bluray|bdrip|brrip|hdtv|dvdrip|remux|hdrip|multi|dual|slosubs|slo|internal|proper|repack|extended|unrated|remastered|directors|imax|hevc|x264|x265|h264|h265)$/;

function sxeVariants(season, episode) {
  const s2 = String(season).padStart(2, '0');
  const e2 = String(episode).padStart(2, '0');
  return {
    episode: new RegExp(`(?:^|[^a-z0-9])(?:s0?${season}\\s?e0?${episode}(?!\\d)|${season}x${e2}(?!\\d))`, 'i'),
    episodeRange: new RegExp(`s0?${season}\\s?e(\\d{1,3})\\s?-?\\s?e?(\\d{1,3})`, 'i'),
    seasonOnly: new RegExp(`(?:^|[^a-z0-9])(?:s${s2}|s${season}|season\\s?0?${season}|sezona\\s?0?${season})(?![a-z0-9]*e\\d)(?![0-9])`, 'i'),
    seasonRange: /s(\d{1,2})\s?-\s?s?(\d{1,2})(?!\d)/i,
    complete: /complete|collection|all seasons|vse sezone/i
  };
}

/**
 * Ali ime izdaje ustreza zahtevanemu naslovu?
 * Vrne null (ne ustreza) ali { kind: 'movie' | 'episode' | 'pack' }.
 */
export function matchRelease(name, { type, title, year, season, episode }) {
  const n = normalize(name);
  const t = normalize(title);
  if (!t) return null;

  const idx = ` ${n} `.indexOf(` ${t} `);
  if (idx === -1) return null;
  // Prvi žeton po naslovu mora biti letnica/oznaka kakovosti/epizoda, ne še ena beseda naslova.
  const after = ` ${n} `.slice(idx + t.length + 2).trim().split(' ')[0] || '';
  if (after && !TAIL_OK.test(after)) return null;

  if (type === 'movie') {
    const years = [...n.matchAll(/(?:^| )((?:19|20)\d\d)(?= |$)/g)].map((m) => m[1]);
    if (year && years.length && !years.includes(String(year))) return null;
    // Nekaj, kar je očitno serija, ne ustreza filmu.
    if (/(?:^| )s\d{1,2}(e\d{1,3})?(?= |$)/.test(n) && !/(?:^| )s\d{1,2}(e\d{1,3})?(?= |$)/.test(t)) return null;
    return { kind: 'movie' };
  }

  const v = sxeVariants(season, episode);
  if (v.episode.test(name)) return { kind: 'episode' };
  const range = v.episodeRange.exec(name);
  if (range && +range[1] <= +episode && +episode <= +range[2]) return { kind: 'episode' };
  if (v.seasonOnly.test(name)) return { kind: 'pack' };
  const sr = v.seasonRange.exec(name);
  if (sr && +sr[1] <= +season && +season <= +sr[2]) return { kind: 'pack' };
  if (v.complete.test(name) && !/s\d{1,2}e\d{1,3}/i.test(name)) return { kind: 'pack' };
  return null;
}

export function parseQuality(name) {
  const s = String(name || '');
  let res = 0;
  let label = 'SD';
  if (/2160p|\b4k\b|\buhd\b/i.test(s)) {
    res = 2160;
    label = '4K';
  } else if (/1080[pi]/i.test(s)) {
    res = 1080;
    label = '1080p';
  } else if (/720p/i.test(s)) {
    res = 720;
    label = '720p';
  } else if (/576p|480p|dvdrip|dvd/i.test(s)) {
    res = 480;
    label = '480p';
  }
  const tags = [];
  if (/remux/i.test(s)) tags.push('REMUX');
  else if (/blu-?ray|bdrip|brrip/i.test(s)) tags.push('BluRay');
  else if (/web-?dl/i.test(s)) tags.push('WEB-DL');
  else if (/webrip/i.test(s)) tags.push('WEBRip');
  else if (/hdtv/i.test(s)) tags.push('HDTV');
  if (/dolby.?vision|\bdv\b/i.test(s)) tags.push('DV');
  if (/hdr10\+?|\bhdr\b/i.test(s)) tags.push('HDR');
  if (/x265|h\.?265|hevc/i.test(s)) tags.push('HEVC');
  else if (/x264|h\.?264|avc/i.test(s)) tags.push('H264');
  if (/atmos/i.test(s)) tags.push('Atmos');
  else if (/dts/i.test(s)) tags.push('DTS');
  else if (/ddp?5\.?1|eac3|ac3/i.test(s)) tags.push('DD5.1');
  const slo = /slo\s?subs?|slovenski|slosub|\bslo\b|sinh|slo\s?audio/i.test(s);
  return { res, label, tags, slo };
}

export function formatSize(bytes) {
  if (!bytes) return '?';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

const VIDEO_RE = /\.(mkv|mp4|avi|m4v|mov|ts|wmv|webm)$/i;

/** Iz seznama datotek v torrentu izbere indeks videa za epizodo (ali največjega, če ni epizode). */
export function pickFileIdx(files, { type, season, episode }) {
  const videos = files.filter((f) => VIDEO_RE.test(f.path) && !/sample/i.test(f.path));
  if (!videos.length) return undefined;
  if (type === 'series') {
    const v = sxeVariants(season, episode);
    const hit = videos.find((f) => v.episode.test(f.path.split('/').pop()) || v.episode.test(f.path));
    if (hit) return hit.idx;
    if (videos.length > 1) return undefined;
  }
  return videos.reduce((a, b) => (b.size > a.size ? b : a)).idx;
}
