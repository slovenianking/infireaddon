# Infire Stremio/Nuvio dodatek (Cloudflare Workers)

Addon deluje kot **vir (provider) v slogu Torrentio**: nima lastnega kataloga. Ko v Stremio/Nuvio odprete
kateri koli film ali serijo (IMDb/Cinemeta), addon na vašem **infire.si** računu poišče izdaje in jih ponudi
kot torrent vire, z oznako kakovosti, velikosti, seederjev in 🇸🇮 (SLOSubs / slovenska sinhronizacija).

Uporablja vedno vaše lastne infire.si poverilnice. Gre za zasebni tracker, zato mora biti račun veljaven.

## Kako deluje
1. IMDb id -> naslov + leto (Cinemeta).
2. **Samodejna prijava** na infire.si (`takelogin.php`, z avtomatskim prepisom skritih polj/CSRF žetona iz obrazca) - piškotek seje se zapomni v Workerju in se sam obnovi, ko poteče. Ročnega vnosa piškotka ni treba, razen če avtomatska prijava odpove (npr. captcha).
3. Iskanje (`torrents.php?search=`, s fallbackom na `search.php?search=`), infohash se prebere iz `details.php?id=<40 hex>`.
4. Filtriranje po naslovu/letu/SxxEyy, razvrščanje po ločljivosti in seederjih.
5. Sezonski paketi: naloži se `.torrent`, izbere se `fileIdx` prave epizode (največ 3 paketi na zahtevo).
6. **Samodejna zaznava passkeya (PID)**: addon po prijavi sam preišče znane strani (usercp/profil/RSS) za passkey; če ga ne najde tam, ga prebere iz prvega naloženega `.torrent` trackerja. Ročni vnos passkeya v nastavitvah ni potreben, je pa še vedno na voljo kot ročni override.
7. Vsak tracker URL se v `sources` pošlje v **obeh oblikah**, `https://` in `http://` (glej spodaj *"Android/TV obtiči na 'Fetching torrent metadata'"*).

Predvajanje je **direktni torrent** (Stremio streaming server / Nuvio torrent podpora), ne debrid.

## Namestitev na Cloudflare
Ime v `wrangler.jsonc` (`"name": "infireaddon"`) se mora ujemati z imenom projekta v Cloudflare.

**GitHub (Workers Builds):** Workers & Pages -> Create -> Import a repository -> ime `infireaddon`,
deploy command `npx wrangler deploy`.

**Ukazna vrstica:**
```bash
npm install
npx wrangler login
npx wrangler deploy
```
Lokalno: `npm run dev` -> http://localhost:8787/configure. Preizkus z lažnim strežnikom: `npm test`.

Nato odprite `https://infireaddon.<poddomena>.workers.dev/configure`, vnesite podatke in kliknite **NAMESTI**.

## Nastavitve (stran /configure)
- uporabniško ime + geslo (obvezno, razen če podate piškotek) - addon se z njima prijavi sam
- **piškotek seje** (neobvezno): samo za primer, da samodejna prijava ne deluje (npr. captcha); v brskalniku se prijavite na infire.si in prekopirajte vrednost `Cookie` (npr. `uid=..; pass=..`)
- **passkey / PID** (neobvezno): addon ga najde sam po prijavi; polje pustite prazno, razen če ga želite ročno prepisati
- največ virov, najmanj seederjev, samo slovenske izdaje

## Deluje na vseh napravah (Android, PC, TV)
Addon je brezstanjski HTTP endpoint (Cloudflare Worker), zato deluje enako na vseh Stremio/Nuvio odjemalcih:
- **Android / Android TV**: namestite prek manifest URL-ja v Nuvio ali Stremio (Settings -> Addons -> paste manifest URL), ali kliknite NAMESTI na `/configure`, če naprava podpira `stremio://` povezave.
- **PC/Mac (Stremio)**: klik na NAMESTI na strani `/configure` odpre Stremio neposredno.
- **TV brez tipkovnice / brez `stremio://` podpore**: stran `/configure` po ~2 sekundah brez zaznane menjave aplikacije sama pokaže gumb "Kopiraj povezavo addona" - povezavo prenesete na TV (npr. prek beležke v telefonu ali ročnega vnosa) in jo prilepite v Nuvio/Stremio "Add addon by URL".
- Odgovori imajo eksplicitne `Cache-Control` glave, da TV odjemalci (ki pogosteje agresivno cachajo) ne obtičijo na starih rezultatih po spremembi nastavitev.

### Android/TV obtiči na "Fetching torrent metadata", na PC naloži hitro
Vzrok: addon je announce (tracker) URL v `sources` pošiljal samo v obliki `tracker:https://...`.
Po [uradni Stremio specifikaciji](https://stremio.github.io/stremio-addon-sdk/api/responses/stream.html)
je veljaven protokol v `sources` samo `http` ali `udp` - `https` ni del specifikacije. Stremio-core
na PC je pri tem prizanesljiv in `https://` vseeno sprejme, medtem ko ga strožji torrent engine na
nekaterih Android/TV izvedbah Nuvio tiho zavrže - tak odjemalec zato nikoli ne dobi veljavnega
trackerja, ne najde peerjev (zasebni tracker nima DHT) in obtiči na "Fetching torrent metadata".

Od v1.2.0 addon za vsak `https://` tracker doda tudi `http://` različico istega URL-ja, da ima
vsak odjemalec - tudi strožji - vsaj eno obliko, ki jo sprejme kot veljaven vir.

### Veliki filmi (>10 GB) se niso naložili, majhni so (popravljeno v v1.3.0)
Vzrok: addon je `.torrent` datoteko (in s tem pravi announce/tracker URL) prej nalagal
samo za sezonske pakete in filme z več datotekami znotraj torrenta. Navaden film z eno
datoteko sploh ni dobil lastnega trackerja - v `sources` je pristal kar prvi tracker, ki
ga je addon naključno odkril pri katerem koli drugem torrentu v tisti zahtevi (ali splošen
passkey-predlog). Ker infire.si nima DHT (zaseben tracker), to pri manj razširjenih/večjih
torrentih pogosto pomeni napačen ali nedelujoč tracker - torrent engine ne najde nobenega
peera in obtiči, medtem ko manjši/priljubljeni torrenti po naključju dobijo pravi tracker.

Od v1.3.0 addon za **vsak** film naloži njegov lastni `.torrent` in uporabi natančno njegov
announce URL v `sources`; splošni passkey ostane le fallback, če lastnega `.torrenta` ni
mogoče naložiti.

### Nekatere serije: "infire.si je vrnil 404 za /browse.php" (popravljeno v v1.3.0)
Vzrok: ko je ena od poti v `INFIRE_SEARCH_PATHS` enkrat uspešno vrnila rezultate, se je
addon je zapomnil kot edino pot za vsa nadaljnja iskanja v tej seji (6 ur predpomnjenja na
istem Workerju). Če ta ista pot za drugo kombinacijo iskanja (npr. drugo sezono/epizodo)
na strani vrne 404, iskanje ni imelo kam pasti nazaj, zato se je napaka pokazala kot vir.

Od v1.3.0 napaka na zapomnjeni poti sprosti izbiro in poišče med vsemi nastavljenimi potmi
naprej, namesto da trajno obtiči na eni, ki je ravno za to poizvedbo vrnila napako.

### Nuvio na TV obtiči na "Fetching torrent metadata" za VSE filme/serije (popravljeno v v1.3.1)
Vzrok: `/debug` je pokazal `NAPAKA: Prijava v infire.si ni uspela (POST /takelogin.php -> 404;
POST /login.php -> 200)`. Uporabnik je imel v nastavitvah izpolnjeno TAKO uporabniško ime in
geslo KOT ročni piškotek seje (najverjetneje ker je piškotek dodal, ko samodejna prijava sprva
ni delovala, nato pa ni izbrisal gesla). Addon je piškotek upošteval samo, če gesla sploh ni
bilo nastavljenega - ker je bilo geslo izpolnjeno, je addon piškotek povsem prezrl in poskušal
samodejno prijavo z uporabniškim imenom/geslom, ki na tej namestitvi trackerja ne deluje
(`takelogin.php` vrne 404). Posledica: VSAKA zahteva za vir je vrnila napako prijave namesto
pravega torrent vira, kar se je v Nuvio na TV kazalo kot obtičanje brez delujočega vira.

Od v1.3.1 ročno vnesen piškotek vedno prevlada, če je (še) veljaven, ne glede na to, ali je
geslo tudi izpolnjeno. Če ročni piškotek ni (več) veljaven, addon pade nazaj na prijavo z
uporabniškim imenom/geslom namesto da takoj odneha.

**Če ste imeli to težavo:** v nastavitvah (`/configure`) lahko pustite piškotek, kot je, ali pa
raje izbrišite polje piškotka, če želite, da se addon prijavlja samodejno z geslom (preverite
najprej, ali `takelogin.php` na vaši namestitvi sploh deluje - glejte `/debug/<iskanje>`).

## Prilagoditev strani (`wrangler.jsonc` -> `vars`)
Strukture infire.si ob pisanju ni bilo mogoče preveriti neposredno, zato so poti nastavljive:
- `INFIRE_SEARCH_PATHS`: poti za iskanje, ločene z `|`, `{q}` je iskalni niz. Poskusijo se po vrsti.
- `INFIRE_LOGIN_PATH`: privzeto `/takelogin.php` (polja `username`, `password`).
- `INFIRE_ANNOUNCE`: npr. `https://infire.si/announce.php?passkey={passkey}`.

Če kaj ne deluje, v `src/lib/infireClient.js` poglejte `parseResults()` (razčlenjevanje rezultatov) in `login()`.
Seederji/leecherji se vzamejo iz izrecnih oznak, sicer iz zadnjih dveh števil v vrstici.

## Omejitve
- Nuvio "Local Scraper" format ne podpira torrentov, zato je to samo addon (Settings -> Addons -> manifest URL).
- Brezplačni Cloudflare plan: 50 podzahtevkov na zahtevo; koda ostane pod mejo.
- Zasebni torrenti nimajo DHT: seederje najde le prek trackerja s passkeyem.
- Geslo je del namestitvene povezave (kot pri prejšnjem addonu): povezave ne delite.
