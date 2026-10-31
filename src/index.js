import { InfireClient, DEFAULT_BASE_URL } from './lib/infireClient.js';
import { TTLCache } from './lib/cache.js';
import renderConfigurePage from './lib/configurePage.js';
import { matchRelease, parseQuality, formatSize, pickFileIdx } from './lib/release.js';

const STREAM_TTL_MS = 10 * 60 * 1000;
const TITLE_TTL_MS = 24 * 60 * 60 * 1000;
const TORRENT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_PACK_LOOKUPS = 3; // omejitev podzahtevkov (brezplačni plan: 50 na zahtevo)

const streamCache = new TTLCache(STREAM_TTL_MS);
const titleCache = new TTLCache(TITLE_TTL_MS);
const torrentCache = new TTLCache(TORRENT_TTL_MS);
const clientCache = new Map(); // identiteta -> InfireClient (obdrži piškotek seje)

const manifest = {
  id: 'com.infire.stremio',
  version: '1.1.0',
  name: 'Infire',
  description:
    'Torrent viri iz infire.si (kot Torrentio): za vsak film ali serijo, ki jo odprete, poišče izdaje na vašem infire.si računu in jih ponudi kot vire. Z oznako slovenskih podnapisov (SLOSubs).',
  logo: '/icon.png',
  // Samo stream vir, brez lastnega kataloga: deluje za vsak IMDb (tt) naslov.
  resources: [{ name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  catalogs: [],
  config: [
    { key: 'username', type: 'text', title: 'infire.si uporabniško ime' },
    { key: 'password', type: 'password', title: 'infire.si geslo' },
    { key: 'cookie', type: 'password', title: 'Piškotek seje (neobvezno - addon se prijavi sam; vnesite le, če samodejna prijava ne deluje, npr. zaradi captche)' },
    { key: 'passkey', type: 'password', title: 'Passkey / PID (neobvezno - addon ga najde sam po prijavi)' },
    { key: 'maxResults', type: 'number', title: 'Največ virov (privzeto 12)', default: '12' },
    { key: 'minSeeders', type: 'number', title: 'Najmanj seederjev (privzeto 0)', default: '0' },
    { key: 'onlySlo', type: 'checkbox', title: 'Samo izdaje s slovenskimi podnapisi / sinhronizacijo' }
  ],
  behaviorHints: { configurable: true, configurationRequired: true }
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
};

function json(data, status = 200, cacheControl) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS };
  // Nekatere naprave (zlasti Android TV klienti) agresivno cachajo brez eksplicitnega
  // Cache-Control, kar na starejših TV napravah po spremembi nastavitev pusti stare
  // rezultate. Kratek, izrecen max-age poskrbi za svežino na vseh napravah hkrati
  // razbremeni Worker pri ponovnem predvajanju istega naslova.
  if (cacheControl) headers['Cache-Control'] = cacheControl;
  return new Response(JSON.stringify(data), { status, headers });
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS } });
}

function listFromEnv(v) {
  return v ? String(v).split('|').map((s) => s.trim()).filter(Boolean) : [];
}

function getClient(config, env) {
  const username = config && config.username;
  const password = config && config.password;
  const cookie = config && config.cookie;
  if (!(username && password) && !cookie) {
    throw new Error('Addon zahteva infire.si uporabniško ime in geslo (ali piškotek).');
  }
  const baseUrl = (env && env.INFIRE_URL) || DEFAULT_BASE_URL;
  const id = `${baseUrl}|${username || ''}|${cookie ? cookie.slice(0, 16) : ''}`;
  let client = clientCache.get(id);
  if (!client || client.password !== (password || '') || client.passkey !== (config.passkey || '')) {
    client = new InfireClient({
      baseUrl,
      username,
      password,
      cookie,
      passkey: config.passkey,
      announce: env && env.INFIRE_ANNOUNCE,
      searchPaths: listFromEnv(env && env.INFIRE_SEARCH_PATHS),
      loginPath: env && env.INFIRE_LOGIN_PATH
    });
    clientCache.set(id, client);
  }
  return client;
}

async function fetchCinemetaTitle(type, imdbId) {
  const res = await fetch(`https://v3-cinemeta.strem.io/meta/${type === 'series' ? 'series' : 'movie'}/${imdbId}.json`);
  const data = await res.json().catch(() => null);
  const meta = data && data.meta;
  if (!meta || !meta.name) return { title: null, year: null };
  return { title: meta.name, year: ((meta.year || meta.released || '') + '').slice(0, 4) };
}

function searchTerm(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
}

function buildQueries({ type, title, year, season, episode }) {
  const t = searchTerm(title);
  if (type === 'movie') return [year ? `${t} ${year}` : t];
  const s2 = String(season).padStart(2, '0');
  const e2 = String(episode).padStart(2, '0');
  return [`${t} S${s2}E${e2}`, `${t} S${s2}`];
}

function parseId(type, id) {
  const [imdbId, seasonStr, episodeStr] = String(id).split(':');
  return {
    imdbId,
    season: seasonStr ? parseInt(seasonStr, 10) : null,
    episode: episodeStr ? parseInt(episodeStr, 10) : null
  };
}

function cfgInt(v, d) {
  const n = parseInt(v, 10);
  return isNaN(n) ? d : n;
}

function magnetSources(hash, trackers) {
  return trackers.map((t) => `tracker:${t}`);
}

async function collect(client, req, config) {
  const queries = buildQueries(req);
  const found = new Map();
  for (const q of queries) {
    let results = [];
    try {
      results = await client.search(q);
    } catch (err) {
      if (!found.size && q === queries[queries.length - 1]) throw err;
      continue;
    }
    for (const r of results) {
      if (found.has(r.hash)) continue;
      const m = matchRelease(r.name, req);
      if (m) found.set(r.hash, { ...r, kind: m.kind, q: parseQuality(r.name) });
    }
    // Film: ena poizvedba zadošča; serija: nadaljuj na sezonske pakete, če epizod ni dovolj.
    if (req.type === 'movie' && found.size) break;
  }

  let items = [...found.values()];
  const minSeeders = cfgInt(config.minSeeders, 0);
  if (minSeeders > 0) items = items.filter((i) => i.seeders >= minSeeders);
  if (config.onlySlo === 'on' || config.onlySlo === true || config.onlySlo === 'true') items = items.filter((i) => i.q.slo);

  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'episode' ? -1 : b.kind === 'episode' ? 1 : 0;
    if (b.q.res !== a.q.res) return b.q.res - a.q.res;
    return b.seeders - a.seeders;
  });
  return items.slice(0, cfgInt(config.maxResults, 12));
}

// Napaka (prijava, iskanje) se pokaže kot vir "Infire", da je provider viden in je razvidno, kaj ne dela.
function errorStream(ctx, message) {
  return {
    name: 'Infire',
    title: `⚠️ ${message}`,
    externalUrl: `${ctx.baseUrl}/configure`,
    behaviorHints: { notWebReady: true }
  };
}

async function handleStream(ctx, type, id) {
  let client;
  try {
    client = getClient(ctx.config, ctx.env);
  } catch (err) {
    return { streams: [errorStream(ctx, err.message)] };
  }

  const { imdbId, season, episode } = parseId(type, id);
  if (!imdbId) return { streams: [] };
  if (type === 'series' && !(season && episode)) return { streams: [] };

  const { title, year } = await titleCache.getOrLoad(`${type}:${imdbId}`, () => fetchCinemetaTitle(type, imdbId));
  if (!title) return { streams: [] };

  const req = { type, title, year, season, episode };
  let items;
  try {
    items = await streamCache.getOrLoad(`${client.identity}:${id}`, () => collect(client, req, ctx.config));
  } catch (err) {
    return { streams: [errorStream(ctx, err.message)] };
  }
  if (!items.length) return { streams: [] };

  // Trackerji (passkey) - iz nastavitev ali iz prvega .torrent. Za pakete potrebujemo .torrent tako ali tako.
  let packLookups = 0;
  const streams = [];
  await client.ensureTrackers(items, torrentCache);
  for (const item of items) {
    let fileIdx;
    let torrentName = item.name;
    const needsTorrent = item.kind === 'pack' && packLookups < MAX_PACK_LOOKUPS;
    if (needsTorrent) {
      try {
        if (needsTorrent) packLookups++;
        const parsed = await torrentCache.getOrLoad(`${client.identity}:${item.hash}`, () => client.fetchTorrent(item));
        if (item.kind === 'pack') fileIdx = pickFileIdx(parsed.files, req);
        else if (item.kind === 'movie' && parsed.files.length > 1) fileIdx = pickFileIdx(parsed.files, req);
      } catch (_) {
        // Brez .torrent ostane nastavljen magnet; paketa brez fileIdx ne ponudimo (bi predvajal napačno datoteko).
        if (item.kind === 'pack') continue;
      }
    } else if (item.kind === 'pack') {
      continue; // presežena omejitev podzahtevkov
    }

    const trackers = client.getTrackers();
    const bits = [item.q.label, ...item.q.tags].join(' ');
    const lines = [torrentName, `👤 ${item.seeders}  💾 ${formatSize(item.size)}  ⚙️ infire.si${item.kind === 'pack' ? '  📦 paket' : ''}`];
    if (item.q.slo) lines.push('🇸🇮 SLO');
    if (!trackers.length) lines.push('⚠️ brez trackerja: vnesite passkey v nastavitvah' + (client.trackerDiag ? ` (${client.trackerDiag})` : ''));

    streams.push({
      name: `Infire\n${bits}`,
      title: lines.join('\n'),
      infoHash: item.hash,
      ...(fileIdx !== undefined ? { fileIdx } : {}),
      sources: magnetSources(item.hash, trackers),
      behaviorHints: {
        bingeGroup: `infire-${item.q.label}-${item.q.tags[0] || ''}`,
        filename: torrentName
      }
    });
  }
  return { streams };
}

// ==========================================
// Usmerjevalnik
// ==========================================
const RESERVED = new Set(['manifest.json', 'configure', 'stream', 'debug']);

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

function stripJson(s) {
  return (s || '').replace(/\.json$/i, '');
}

function parseConfig(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(safeDecode(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function buildManifest(baseUrl, hasConfig) {
  const m = JSON.parse(JSON.stringify(manifest));
  m.logo = `${baseUrl}/icon.png`;
  if (hasConfig && m.behaviorHints) {
    delete m.behaviorHints.configurationRequired;
    delete m.behaviorHints.configurable;
  }
  return m;
}

async function route(request, env) {
  const url = new URL(request.url);
  const baseUrl = url.origin;
  const raw = url.pathname.split('/').filter(Boolean);

  if (raw.length === 0) return Response.redirect(`${baseUrl}/configure`, 302);

  let rawConfig = null;
  if (!RESERVED.has(raw[0])) rawConfig = raw.shift();
  const config = parseConfig(rawConfig);
  const segs = raw.map(safeDecode);
  const ctx = { config: config || {}, env, baseUrl };
  const resource = segs[0];

  if (resource === 'manifest.json') return json(buildManifest(baseUrl, !!rawConfig), 200, 'public, max-age=3600');

  if (resource === 'configure' || (resource === undefined && rawConfig)) {
    return new Response(renderConfigurePage(buildManifest(baseUrl, false)), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  try {
    if (resource === 'debug') {
      const client = getClient(ctx.config, ctx.env);
      return json(await client.debug(segs[1] || 'matrix'));
    }
    if (resource === 'stream') return json(await handleStream(ctx, segs[1], stripJson(segs[2])), 200, 'public, max-age=60, stale-while-revalidate=120');
    return text('Not found', 404);
  } catch (err) {
    return json({ streams: [errorStream(ctx, err.message)] });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405);
    return route(request, env);
  }
};
