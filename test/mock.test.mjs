// Preizkus z lažnim infire.si strežnikom (prijava -> iskanje -> .torrent -> stream odgovor).
import http from 'node:http';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const HASH_MOVIE = 'a'.repeat(40);
const HASH_MOVIE_OTHER = 'b'.repeat(40);
const HASH_EP = 'c'.repeat(40);
const HASH_PACK = 'd'.repeat(40);
const PASSKEY = 'secret123';

function bstr(s) { return `${Buffer.byteLength(s)}:${s}`; }
function torrent(files, name) {
  const fl = files.map((f) => `d6:lengthi${f.size}e4:pathl${f.path.map(bstr).join('')}ee`).join('');
  return Buffer.from(`d8:announce${bstr('https://infire.si/announce.php?passkey=' + PASSKEY)}4:infod5:filesl${fl}e4:name${bstr(name)}12:piece lengthi16384e7:privatei1eee`);
}

const row = (hash, name, size, s, l) => `<tr><td><img src="x.jpg"></td><td><a href="details.php?id=${hash}" title="${name}">${name}</a><br><a href="download.php?id=${hash}">DL</a></td><td>Size: ${size}</td><td><b>12</b></td><td><b>${s}</b></td><td><b>${l}</b></td></tr>`;

let lastLoginBody = '';
let noPasskeyPage = false;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const authed = (req.headers.cookie || '').includes('uid=1');
  if (u.pathname === '/login.php') {
    res.setHeader('Set-Cookie', 'PHPSESSID=abc; path=/');
    // CSRF žeton kot skrito polje - preveri, da ga odjemalec prebere in pošlje nazaj.
    return res.end('<form><input type="hidden" name="csrf_token" value="tok-xyz"><input type=password></form>');
  }
  if (u.pathname === '/takelogin.php' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastLoginBody = body;
      if (!body.includes('csrf_token=tok-xyz')) { res.statusCode = 403; return res.end('missing csrf'); }
      res.setHeader('Set-Cookie', ['uid=1; path=/', 'pass=zzz; path=/']);
      res.statusCode = 302; res.setHeader('Location', '/index.php'); res.end();
    });
    return;
  }
  if (!authed) { res.statusCode = 302; res.setHeader('Location', '/login.php'); return res.end(); }
  if (u.pathname === '/index.php') return res.end('<a href="logout.php">x</a>');
  if (u.pathname === '/usercp.php') {
    // Ko je noPasskeyPage=true, simuliramo postavitev trackerja, kjer passkey ni
    // izpisan na nobeni znani strani: addon se mora tiho zateči k .torrent datoteki.
    if (noPasskeyPage) return res.end('<html>ni passkeyja tukaj</html>');
    return res.end('<a href="rss.php?passkey=deadbeef00deadbeef00deadbeef00deadbeef0">RSS</a>');
  }
  if (u.pathname === '/browse.php' || u.pathname === '/torrents.php') {
    const q = (u.searchParams.get('search') || '').toLowerCase();
    let html = '<html><body><table>';
    if (q.startsWith('the matrix')) {
      html += row(HASH_MOVIE, 'The.Matrix.1999.1080p.BluRay.x264.SLOSubs', '12.40 GiB', 55, 3);
      html += row(HASH_MOVIE_OTHER, 'The.Matrix.Reloaded.2003.1080p.BluRay.x264', '10.00 GiB', 20, 1);
    }
    if (q.startsWith('severance s01e02')) html += row(HASH_EP, 'Severance.S01E02.1080p.WEB.H264-GRP', '2.10 GiB', 9, 0);
    if (q.startsWith('severance s01') && !q.includes('e02')) html += row(HASH_PACK, 'Severance.S01.1080p.WEB.H264-GRP', '20 GiB', 4, 0);
    return res.end(html + '</table></body></html>');
  }
  if (u.pathname === '/download.php') {
    const id = u.searchParams.get('id');
    res.setHeader('Content-Type', 'application/x-bittorrent');
    if (id === HASH_PACK) return res.end(torrent([
      { size: 1000, path: ['Severance.S01', 'Severance.S01E01.mkv'] },
      { size: 1200, path: ['Severance.S01', 'Severance.S01E02.mkv'] },
      { size: 5, path: ['Severance.S01', 'Sample', 'sample.mkv'] }], 'Severance.S01'));
    return res.end(torrent([{ size: 1000, path: ['x.mkv'] }], 'x.mkv'));
  }
  res.statusCode = 404; res.end();
});

// Lažni Cinemeta
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const s = String(url);
  if (s.includes('cinemeta')) {
    const meta = s.includes('tt0133093') ? { name: 'The Matrix', year: '1999' } : { name: 'Severance', year: '2022' };
    return Promise.resolve(new Response(JSON.stringify({ meta }), { headers: { 'content-type': 'application/json' } }));
  }
  return realFetch(url, init);
};

await new Promise((r) => server.listen(0, r));
const env = { INFIRE_URL: `http://127.0.0.1:${server.address().port}`, INFIRE_SEARCH_PATHS: '/torrents.php?search={q}' };
const cfg = encodeURIComponent(JSON.stringify({ username: 'u', password: 'p' }));
const get = async (p) => (await worker.fetch(new Request(`https://w.example/${cfg}/${p}`), env)).json();

const manifest = await (await worker.fetch(new Request('https://w.example/manifest.json'), env)).json();
assert.equal(manifest.resources[0].name, 'stream');

const movie = await get('stream/movie/tt0133093.json');
console.log(JSON.stringify(movie, null, 1));
assert.equal(movie.streams.length, 1, 'Reloaded mora biti izločen');
assert.equal(movie.streams[0].infoHash, HASH_MOVIE);
// Vsak film zdaj naloži svoj .torrent in uporabi NJEGOV pravi announce tracker (ne
// splošni usercp/rss passkey), da tudi veliki/manj razširjeni filmi dobijo delujoč
// tracker namesto naključnega/skupnega, ki je bil vzrok, da so veliki filmi (>10GB)
// obtičali brez peerjev, majhni pa so naključno dobili pravega.
assert.ok(movie.streams[0].sources[0].includes('secret123'), 'uporabljen pravi tracker iz lastnega .torrent filma');
assert.match(movie.streams[0].title, /55/);
assert.match(movie.streams[0].title, /SLO/);

const ep = await get('stream/series/tt1111111:1:2.json');
console.log(JSON.stringify(ep, null, 1));
assert.equal(ep.streams[0].infoHash, HASH_EP);
const pack = ep.streams.find((s) => s.infoHash === HASH_PACK);
assert.equal(pack.fileIdx, 1, 'fileIdx epizode v paketu');
// Za vsak https:// tracker mora addon ponuditi tudi http:// različico, ker nekateri
// torrent engine-i na Android/TV strogo upoštevajo specifikacijo (tracker:http:// ali
// tracker:udp://) in https:// vir tiho zavržejo - to je bilo vzrok, da je predvajanje
// na telefonu/TV obtičalo na "Fetching torrent metadata" kljub hitremu delovanju na PC.
assert.ok(pack.sources.includes('tracker:https://infire.si/announce.php?passkey=secret123'));
assert.ok(pack.sources.includes('tracker:http://infire.si/announce.php?passkey=secret123'), 'http:// dvojnik mora biti dodan za strožje torrent engine-e');

const bad = await (await worker.fetch(new Request('https://w.example/stream/movie/tt1.json'), env)).json();
assert.match(bad.streams[0].title, /uporabni/);
const dbg = await (await worker.fetch(new Request(`https://w.example/${cfg}/debug/the%20matrix`), env)).json();
assert.equal(dbg.searches[0].status, 200);
assert.ok(dbg.searches[0].parsed.length);

// Preveri, da je CSRF skrito polje iz /login.php res šlo nazaj v POST /takelogin.php
// (brez tega bi zgornji klici že spodleteli, a preverimo eksplicitno).
assert.ok(lastLoginBody.includes('csrf_token=tok-xyz'), 'CSRF žeton mora biti poslan nazaj ob prijavi');

// Nova identiteta (drug username), da se ne uporabi cache prejšnjega odjemalca:
// film vedno naloži svoj .torrent in uporabi njegov pravi announce tracker, usercp/rss
// passkey ostane le fallback za primere, ko lastnega .torrenta ni mogoče dobiti.
const cfg2 = encodeURIComponent(JSON.stringify({ username: 'u2', password: 'p' }));
const movie2 = await (await worker.fetch(new Request(`https://w.example/${cfg2}/stream/movie/tt0133093.json`), env)).json();
assert.ok(movie2.streams[0].sources[0].includes(PASSKEY), 'tracker iz lastnega .torrent ima prednost pred splošnim usercp/rss passkeyem');

// Tretja identiteta: usercp/rss ne izda passkeya na nobeni strani, a film vseeno dobi
// delujoč tracker neposredno iz svojega .torrenta (ta pot zdaj ni več odvisna od usercp).
noPasskeyPage = true;
const cfg3 = encodeURIComponent(JSON.stringify({ username: 'u3', password: 'p' }));
const movie3 = await (await worker.fetch(new Request(`https://w.example/${cfg3}/stream/movie/tt0133093.json`), env)).json();
assert.ok(movie3.streams[0].sources[0].includes(PASSKEY), 'brez usercp/rss passkeya tracker vseeno pride iz .torrenta');

// Scenarij s slike iz prijave: ena iskalna pot (npr. /browse.php) vrne 404 za
// nekatere serije/kombinacije parametrov, potem ko je bila predhodno zapomnjena kot
// "delujoča" za drug naslov. Addon se mora vrniti na ostale nastavljene poti namesto
// da trajno obtiči z napako "infire.si je vrnil 404 za /browse.php".
const envMultiPath = {
  INFIRE_URL: env.INFIRE_URL,
  INFIRE_SEARCH_PATHS: '/browse.php?search={q}|/torrents.php?search={q}'
};
const cfg4 = encodeURIComponent(JSON.stringify({ username: 'u4', password: 'p' }));
const get4 = async (p) => (await worker.fetch(new Request(`https://w.example/${cfg4}/${p}`), envMultiPath)).json();
// Prvo iskanje: /browse.php ne obstaja na mock strežniku (404) -> mora pasti na /torrents.php.
const movie4 = await get4('stream/movie/tt0133093.json');
assert.ok(!/404/.test(movie4.streams[0]?.title || ''), 'ne sme obtičati na 404 iskalni poti, mora pasti na naslednjo');
assert.equal(movie4.streams[0].infoHash, HASH_MOVIE);
// Drugo, drugačno iskanje (serija) z istim clientom: /torrents.php je bil zapomnjen kot
// delujoč, mora delovati tudi zanj, ne samo za film.
const ep4 = await get4('stream/series/tt1111111:1:2.json');
assert.equal(ep4.streams[0].infoHash, HASH_EP);

console.log('OK');
server.close();
