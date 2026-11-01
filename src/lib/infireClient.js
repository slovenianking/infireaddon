// Odjemalec za infire.si (zasebni torrent tracker, PHP) - prijava s piškotkom,
// iskanje in razčlenjevanje rezultatov. Ker strukture strani ni bilo mogoče
// preveriti vnaprej, so poti in polja nastavljivi prek spremenljivk okolja
// (glej wrangler.jsonc) in razčlenjevalnik uporablja heuristiko, ki ne
// ni odvisna od točnih razredov CSS: infohash je v `details.php?id=<40 hex>`.

import { parseTorrent } from './bencode.js';

export const DEFAULT_BASE_URL = 'https://infire.si';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Stremio/Nuvio na TV in mobilnih napravah pogosto čakajo na stream odgovor dlje kot
// namizni odjemalci, zato ima vsaka posamezna zahteva proti infire.si razumen rok,
// skupno pa nad vsemi zahtevami v eni prošnji bedi handleStream v index.js.
const TIMEOUT_MS = 12000;
const MAX_FETCH_RETRIES = 1; // en ponovni poskus ob prehodni mrežni napaki (ne ob 4xx/5xx)

const HASH_RE = /details\.php\?id=([0-9a-fA-F]{40})/;
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)\b/i;

const UNITS = { kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

export function parseSize(text) {
  const m = SIZE_RE.exec(text || '');
  if (!m) return 0;
  return Math.round(parseFloat(m[1].replace(',', '.')) * UNITS[m[2].toLowerCase()]);
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Iz HTML-ja strani z rezultati izlušči torrente.
 * Vsak unikaten `details.php?id=<hash>` je en torrent; podatki (velikost,
 * seederji, leecherji) se iščejo v odseku HTML-ja do naslednjega torrenta.
 */
export function parseResults(html) {
  const out = [];
  const seen = new Set();
  const re = /details\.php\?id=([0-9a-fA-F]{40})/g;
  const hits = [];
  let m;
  while ((m = re.exec(html))) hits.push({ hash: m[1].toLowerCase(), index: m.index });

  for (let i = 0; i < hits.length; i++) {
    const { hash, index } = hits[i];
    if (seen.has(hash)) continue;

    // Odsek te vrstice: od začetka <tr>/<div> pred zadetkom do naslednjega zadetka z drugim hashem.
    let end = html.length;
    for (let j = i + 1; j < hits.length; j++) {
      if (hits[j].hash !== hash) {
        end = hits[j].index;
        break;
      }
    }
    const start = Math.max(0, html.lastIndexOf('<tr', index), 0);
    const startFinal = start > index - 1500 ? start : Math.max(0, index - 300);
    const chunk = html.slice(startFinal, end);

    // Ime: najprej title="" ali besedilo sidra, ki vsebuje besedilo (ne le sličico).
    let name = '';
    const anchorRe = new RegExp(`<a[^>]*details\\.php\\?id=${hash}[^>]*>([\\s\\S]*?)</a>`, 'ig');
    let am;
    while ((am = anchorRe.exec(chunk))) {
      const tag = am[0].slice(0, am[0].indexOf('>') + 1);
      const titleAttr = /title=["']([^"']+)["']/i.exec(tag);
      const inner = stripTags(am[1]);
      const candidate = inner || (titleAttr ? decodeEntities(titleAttr[1]) : '');
      if (candidate && candidate.length > name.length) name = candidate;
    }
    if (!name) {
      const t = new RegExp(`details\\.php\\?id=${hash}[^>]*title=["']([^"']+)["']`, 'i').exec(chunk);
      if (t) name = decodeEntities(t[1]);
    }
    if (!name) continue;

    seen.add(hash);

    const text = stripTags(chunk.replace(/<\/(td|div|span|b|strong)>/gi, '$& '));
    const size = parseSize(text);

    // Seederji / leecherji.
    // Infire.si označuje ti dve števili nedvoumno z razredoma `tx-success` (seederji,
    // zeleno) in `tx-danger` (leecherji, rdeče) na <span> znotraj stolpcev S/L - to je
    // zanesljivo, ker vrstica lahko vsebuje ŠE druga gola števila (datum dodajanja,
    // komentarji, "zgodovina torrenta" povezava na koncu vrstice), ki stara "zadnji dve
    // števili v vrstici" hevristika napačno zamenja za (seeders, leechers), če je teh
    // dodatnih števil med velikostjo in pravim S/L stolpcem oz. za njim.
    let seeders = null;
    let leechers = null;
    const successM = /tx-success["'][^>]*>\s*(\d{1,7})\s*</i.exec(chunk);
    const dangerM = /tx-danger["'][^>]*>\s*(\d{1,7})\s*</i.exec(chunk);
    if (successM) seeders = parseInt(successM[1], 10);
    if (dangerM) leechers = parseInt(dangerM[1], 10);

    if (seeders === null || leechers === null) {
      const sm = /(?:seeders?|seeds?|se[ée]d)\s*[:=]?\s*(\d+)/i.exec(text);
      const lm = /(?:leechers?|leech)\s*[:=]?\s*(\d+)/i.exec(text);
      if (seeders === null && sm) seeders = parseInt(sm[1], 10);
      if (leechers === null && lm) leechers = parseInt(lm[1], 10);
    }
    if (seeders === null || leechers === null) {
      // Zadnja možnost, če postavitev strani ne ustreza zgornjemu: vzemi prvi dve celi
      // števili TAKOJ za velikostjo (stolpca S in L si na infire.si sledita neposredno
      // za velikostjo), ne zadnji dve v vrstici - s tem se izognemo poznejšim številom
      // iz datuma/komentarjev/zgodovine, ki pridejo za S/L stolpcema.
      const sizeAt = SIZE_RE.exec(chunk);
      const after = sizeAt ? chunk.slice(sizeAt.index + sizeAt[0].length) : chunk;
      const nums = [...after.matchAll(/>\s*(\d{1,7})\s*</g)].map((x) => parseInt(x[1], 10));
      if (seeders === null && nums.length >= 1) seeders = nums[0];
      if (leechers === null && nums.length >= 2) leechers = nums[1];
    }

    const dl = /href=["']([^"']*download\.php[^"']*)["']/i.exec(chunk);
    out.push({
      hash,
      name,
      size,
      seeders: seeders ?? 0,
      leechers: leechers ?? 0,
      downloadHref: dl ? decodeEntities(dl[1]) : null
    });
  }
  return out;
}

function mergeCookies(existing, setCookies) {
  const jar = new Map();
  for (const part of String(existing || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const sc of setCookies) {
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const k = first.slice(0, i).trim();
    const v = first.slice(i + 1).trim();
    if (!v || v.toLowerCase() === 'deleted') jar.delete(k);
    else jar.set(k, v);
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? raw.split(/,(?=\s*[^;,\s]+=)/) : [];
}

/** Prepiše skrita vnosna polja prijavnega obrazca (npr. CSRF žeton), da jih POST pošlje nazaj. */
function extractHiddenFields(html) {
  const out = {};
  const re = /<input[^>]+type=["']?hidden["']?[^>]*>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const tag = m[0];
    const name = /name=["']([^"']+)["']/i.exec(tag);
    if (!name) continue;
    const value = /value=["']([^"']*)["']/i.exec(tag);
    out[decodeEntities(name[1])] = value ? decodeEntities(value[1]) : '';
  }
  return out;
}

function looksLikeLoginPage(html, url) {
  if (/login\.php/i.test(url || '')) return true;
  return /<input[^>]+type=["']?password/i.test(html) && !/logout\.php/i.test(html);
}

/**
 * Poišče passkey v poljubnem HTML/besedilu: v announce/RSS povezavah
 * (`passkey=...` ali `pid=...`, pogost alias za passkey), v vnosnem polju
 * (`value="..."`) ali za besedo "passkey"/"pid" v navadnem besedilu.
 */
function extractPasskey(html) {
  if (!html) return null;
  const patterns = [
    /[?&](?:passkey|pid)=([0-9a-f]{20,64})/i,
    /name=["']?(?:passkey|pid)["']?[^>]*value=["']([0-9a-f]{20,64})["']/i,
    /(?:passkey|pid)\s*[:=]\s*["']?([0-9a-f]{20,64})["']?/i
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// Strani, kjer passkey pogosto piše naravnost (profil / nastavitve / RSS / usercp),
// preden se zatečemo k branju iz .torrent datoteke.
const PASSKEY_PAGES = ['/usercp.php?action=security', '/usercp.php', '/my.php', '/rss.php', '/getrss.php', '/profile.php'];

export class InfireClient {
  constructor({ baseUrl, username, password, cookie, passkey, announce, searchPaths, loginPath }) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.username = username || '';
    this.password = password || '';
    this.manualCookie = cookie || '';
    this.cookie = cookie || '';
    this.passkey = passkey || '';
    this.announceTemplate = announce || '';
    this.searchPaths = searchPaths && searchPaths.length ? searchPaths : ['/torrents.php?search={q}', '/torrents.php?search={q}&incldead=0', '/search.php?search={q}&incldead=0'];
    this.loginPath = loginPath || '/takelogin.php';
    this.workingSearchPath = null;
    this.loginPromise = null;
    this.passkeyPromise = null;
    this.trackers = null; // zaznano iz prvega .torrent
  }

  get identity() {
    return this.username || this.manualCookie.slice(0, 12);
  }

  async _fetch(url, init = {}, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': UA, 'Accept-Language': 'sl,en;q=0.8', Referer: this.baseUrl + '/', ...(init.headers || {}) }
      });
    } catch (err) {
      // Prehodna mrežna napaka (timeout, reset) - en ponovni poskus, da en spodrsljaj
      // omrežja (pogost na mobilnih/TV povezavah) ne sesuje celotnega iskanja.
      if (attempt < MAX_FETCH_RETRIES && err && err.name !== 'AbortError') {
        return this._fetch(url, init, attempt + 1);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _verify(cookie) {
    const res = await this._fetch(this.baseUrl + '/index.php', { headers: { Cookie: cookie } });
    if (res.status !== 200) return false;
    const html = await res.text();
    return /logout\.php/i.test(html) || !/<input[^>]+type=["']?password/i.test(html);
  }

  async login() {
    // Ročno vnesen piškotek ima vedno prednost, ko je veljaven - ne glede na to, ali je
    // uporabnik poleg njega pustil tudi uporabniško ime/geslo. Prej je piškotek veljal
    // samo, če gesla sploh ni bilo (`!this.password`), zato je uporabnik, ki je imel
    // nastavljeno oboje (npr. ker je samodejna prijava sprva odpovedala in je ročno dodal
    // piškotek, a ni izbrisal gesla), dobil NAPAKO PRIJAVE pri vsaki zahtevi: addon je
    // ročni, delujoč piškotek popolnoma prezrl in poskušal (neuspešno) prijavo z geslom.
    if (this.manualCookie) {
      if (!this.password || (await this._verify(this.manualCookie))) {
        this.cookie = this.manualCookie;
        return;
      }
      // Piškotek je podan, a ni (več) veljaven in imamo tudi geslo - nadaljuj na
      // samodejno prijavo spodaj namesto da takoj vržemo napako.
    }
    if (!this.username || !this.password) {
      if (this.manualCookie) {
        // Piškotek je bil podan, a ni veljaven, gesla pa ni - jasna, uporabna napaka.
        throw new Error('Vnešen piškotek seje za infire.si ni (več) veljaven. Prijavite se v brskalniku in piškotek posodobite, ali pa vnesite uporabniško ime in geslo za samodejno prijavo.');
      }
      throw new Error('Manjka uporabniško ime/geslo (ali piškotek) za infire.si.');
    }
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const log = (this.loginLog = []);
      const paths = [...new Set([this.loginPath, '/takelogin.php', '/login.php'])];
      for (const path of paths) {
        let cookie = '';
        let hidden = {};
        try {
          const pre = await this._fetch(this.baseUrl + '/login.php');
          cookie = mergeCookies(cookie, getSetCookies(pre.headers));
          // Nekatere PHP postavitve (CSRF zaščita) zahtevajo skrito polje iz obrazca
          // (npr. csrf_token, _token). Vsa skrita polja se prepišejo v prijavni POST.
          const preHtml = await pre.text().catch(() => '');
          hidden = extractHiddenFields(preHtml);
        } catch (_) {}
        try {
          const body = new URLSearchParams({ ...hidden, username: this.username, password: this.password, returnto: '/', login: 'Sign In' });
          let cur = await this._fetch(this.baseUrl + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Origin: this.baseUrl },
            body
          });
          log.push(`POST ${path} -> ${cur.status}${cur.headers.get('location') ? ' ->' + cur.headers.get('location') : ''}`);
          cookie = mergeCookies(cookie, getSetCookies(cur.headers));
          let hops = 0;
          while (cur.status >= 300 && cur.status < 400 && hops++ < 4) {
            const loc = cur.headers.get('location');
            if (!loc) break;
            cur = await this._fetch(new URL(loc, this.baseUrl + '/').toString(), { headers: { Cookie: cookie } });
            cookie = mergeCookies(cookie, getSetCookies(cur.headers));
          }
          if (cookie && (await this._verify(cookie))) {
            this.cookie = cookie;
            log.push('prijava OK');
            return;
          }
        } catch (err) {
          log.push(`POST ${path} napaka: ${err.message}`);
        }
      }
      throw new Error('Prijava v infire.si ni uspela (' + log.join('; ') + '). Preverite geslo ali vnesite piškotek ročno.');
    })();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async _get(pathOrUrl, { binary = false, retry = true } = {}) {
    if (!this.cookie) await this.login();
    const url = /^https?:/i.test(pathOrUrl) ? pathOrUrl : new URL(pathOrUrl, this.baseUrl + '/').toString();
    let res = await this._fetch(url, { headers: { Cookie: this.cookie } });
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && hops++ < 4) {
      const loc = res.headers.get('location') || '';
      this.cookie = mergeCookies(this.cookie, getSetCookies(res.headers));
      if (/login\.php/i.test(loc)) {
        if (retry && this.password) {
          this.cookie = '';
          await this.login();
          return this._get(pathOrUrl, { binary, retry: false });
        }
        throw new Error('Seja na infire.si je potekla ali piškotek ni veljaven.');
      }
      res = await this._fetch(new URL(loc, url).toString(), { headers: { Cookie: this.cookie } });
    }
    if (!res.ok) throw new Error(`infire.si je vrnil ${res.status} za ${new URL(url).pathname}`);
    if (binary) return new Uint8Array(await res.arrayBuffer());
    const html = await res.text();
    if (looksLikeLoginPage(html, res.url) && retry && this.password) {
      this.cookie = '';
      await this.login();
      return this._get(pathOrUrl, { binary, retry: false });
    }
    return html;
  }

  /** Poišče torrente po iskalnem nizu; poskusi nastavljene poti, dokler katera ne vrne rezultatov. */
  async search(query) {
    const q = encodeURIComponent(query);
    // Zapomnjena delujoča pot gre vedno prva (hitro), a če za to konkretno poizvedbo
    // odpove (npr. 404 na tej strani za to kombinacijo parametrov - znano pri nekaterih
    // sezona/epizoda iskanjih), se NE sme obtičati: pade nazaj na vse ostale poti, sicer
    // bi ena pokvarjena pot trajno blokirala iskanje za vse naslednje zahteve (glej README
    // #2 - serije z napako "infire.si je vrnil 404 za /search.php").
    const rest = this.searchPaths.filter((p) => p !== this.workingSearchPath);
    const paths = this.workingSearchPath ? [this.workingSearchPath, ...rest] : this.searchPaths;
    let lastError = null;
    for (const p of paths) {
      try {
        const html = await this._get(p.replace('{q}', q));
        const results = parseResults(html);
        if (results.length) {
          this.workingSearchPath = p;
          return results;
        }
        // Prazen rezultat na zapomnjeni poti ni nujno znak, da pot ne dela (iskanje je
        // lahko res brez zadetkov) - a vseeno poskusimo ostale poti, preden obupamo,
        // namesto da takoj vrnemo prazen seznam.
      } catch (err) {
        lastError = err;
        // Pot, ki vrže napako (404 ipd.), ni več zaupanja vredna kot "delujoča" pot.
        if (this.workingSearchPath === p) this.workingSearchPath = null;
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  /** Diagnostika: vrne korake prijave in odgovor vsake iskalne poti (za /debug/<iskanje>). */
  async debug(query, rowMatch) {
    const out = { login: null, searches: [] };
    try {
      await this.login();
      out.login = (this.loginLog || ['piškotek iz nastavitev']).join('; ');
    } catch (err) {
      out.login = 'NAPAKA: ' + err.message;
      return out;
    }
    out.cookieNames = this.cookie.split(/;\s*/).map((c) => c.split('=')[0]);
    for (const p of this.searchPaths) {
      const url = this.baseUrl + p.replace('{q}', encodeURIComponent(query));
      try {
        const res = await this._fetch(url, { headers: { Cookie: this.cookie } });
        const html = res.status === 200 ? await res.text() : '';
        if (html && !out.torrent) {
          const first = parseResults(html)[0];
          if (first) {
            try {
              const t = await this.fetchTorrent(first);
              out.torrent = { ok: true, trackers: t.trackers.map((x) => x.replace(/passkey=[^&]+/i, 'passkey=***')), files: t.files.length };
            } catch (err) {
              out.torrent = { ok: false, error: err.message, downloadHref: first.downloadHref };
            }
          }
        }
        const entry = {
          path: p,
          status: res.status,
          location: res.headers.get('location'),
          title: (/<title>([^<]*)/i.exec(html) || [])[1] || null,
          parsed: html ? parseResults(html) : [],
          detailsLinks: (html.match(/details\.php\?id=[0-9a-f]{40}/gi) || []).length,
          snippet: html.slice(0, 600)
        };
        // Diagnostika za posamezno vrstico (npr. ?row=Kitsune): surov HTML okoli prve
        // pojavitve niza, da je videti natančno zaporedje stolpcev (freeleech ikona,
        // Com. steber ipd.), ki jih parseResults morda napačno prešteje kot S/L.
        if (rowMatch) {
          const idx = html.indexOf(rowMatch);
          if (idx >= 0) {
            const start = Math.max(0, html.lastIndexOf('<tr', idx));
            let end = html.indexOf('<tr', idx + rowMatch.length);
            end = end > 0 ? end : Math.min(html.length, idx + 2000);
            entry.rowHtml = html.slice(start, end);
          } else {
            entry.rowHtml = `(niz "${rowMatch}" ni najden na tej strani)`;
          }
        }
        out.searches.push(entry);
      } catch (err) {
        out.searches.push({ path: p, error: err.message });
      }
    }
    return out;
  }

  /** Naloži .torrent: povezava iz rezultata, download.php?id=, nato povezava s strani podrobnosti. */
  async fetchTorrent(result) {
    const tried = [];
    const attempt = async (href) => {
      try {
        const bytes = await this._get(href, { binary: true });
        if (bytes[0] !== 0x64) throw new Error('ni .torrent (odgovor ni bencode)');
        const parsed = parseTorrent(bytes);
        // Shrani kot "zadnje znane" trackerje (uporabno kot splošni fallback), a NE
        // prepiši nič specifičnega za ta torrent - vsak .torrent ima lahko svoj announce
        // URL in pri velikih/manj priljubljenih torrentih je ravno pravi tracker tisti,
        // ki sploh najde peerje. Klicatelj naj uporabi parsed.trackers neposredno za ta item.
        if (parsed.trackers.length && !this.trackers) this.trackers = parsed.trackers;
        return parsed;
      } catch (err) {
        tried.push(`${String(href).slice(0, 60)}: ${err.message}`);
        return null;
      }
    };

    const direct = [result.downloadHref, `/download.php?id=${result.hash}`].filter(Boolean);
    for (const href of direct) {
      const parsed = await attempt(href);
      if (parsed) return parsed;
    }

    // Stran podrobnosti: poišči download povezavo, passkey in announce URL.
    try {
      const html = await this._get(`/details.php?id=${result.hash}`);
      const pk = extractPasskey(html);
      if (pk && !this.passkey) this.passkey = pk;
      const ann = /(https?:\/\/[^"'\s<>]*announce[^"'\s<>]*)/i.exec(html.replace(/&amp;/g, '&'));
      if (ann && !this.trackers) this.trackers = [ann[1]];
      const links = [...html.matchAll(/href=["']([^"']*download[^"']*)["']/gi)].map((m) => decodeEntities(m[1]));
      for (const href of [...new Set(links)].slice(0, 3)) {
        const parsed = await attempt(href);
        if (parsed) return parsed;
      }
    } catch (err) {
      tried.push(`details: ${err.message}`);
    }
    this.trackerDiag = tried.join(' | ');
    throw new Error('Nalaganje .torrent ni uspelo: ' + this.trackerDiag);
  }

  /** Poskrbi, da imamo tracker (prvih nekaj rezultatov); ne vrže napake. */
  async ensureTrackers(items, cache) {
    if (this.getTrackers().length) return;
    // Najprej poceni poskus: passkey je pogosto izpisan na profilni/nastavitveni strani,
    // kar prihrani nalaganje .torrent datotek samo za ta namen.
    if (!this.passkey) await this.ensurePasskey();
    if (this.getTrackers().length) return;
    // Vzporedno namesto enega za drugim - cache.getOrLoad ima zaščito pred podvojenimi
    // sočasnimi zahtevami za isti hash (deli isti "in-flight" promise z glavno zanko
    // v index.js, ki te iste prve iteme itak nalaga za svoje potrebe), zato to ne naredi
    // dodatnih omrežnih zahtev, le ne čaka nanje eno za drugo.
    await Promise.all(
      items.slice(0, 3).map((item) =>
        cache.getOrLoad(`${this.identity}:${item.hash}`, () => this.fetchTorrent(item)).catch(() => null)
      )
    );
  }

  /**
   * Samodejno poišče passkey, ne da bi ga bilo treba ročno vnesti v nastavitvah:
   * preveri nekaj znanih strani (profil / usercp / RSS), kjer je passkey pogosto
   * izpisan v navadnem besedilu ali v RSS/announce povezavi. Tiho odneha, če ga
   * ne najde - v tem primeru se passkey vseeno prebere iz prvega .torrenta.
   */
  async ensurePasskey() {
    if (this.passkey) return this.passkey;
    if (this.passkeyPromise) return this.passkeyPromise;
    this.passkeyPromise = (async () => {
      for (const page of PASSKEY_PAGES) {
        try {
          const html = await this._get(page);
          const found = extractPasskey(html);
          if (found) {
            this.passkey = found;
            return found;
          }
        } catch (_) {
          // stran morda ne obstaja na tej postavitvi trackerja - poskusi naslednjo
        }
      }
      return null;
    })();
    try {
      return await this.passkeyPromise;
    } finally {
      this.passkeyPromise = null;
    }
  }

  /** Trackerji za sources: zaznani iz .torrent, sicer iz predloge (passkey iz nastavitev). */
  getTrackers() {
    if (this.trackers && this.trackers.length) return this.trackers;
    if (this.passkey) {
      const tpl = this.announceTemplate || `${this.baseUrl}/announce.php?passkey={passkey}`;
      return [tpl.replace('{passkey}', encodeURIComponent(this.passkey))];
    }
    return [];
  }
}
