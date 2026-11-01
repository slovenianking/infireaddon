
/** Very small in-memory TTL cache, keyed by string. */
class TTLCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.store = new Map();
    this.inFlight = new Map(); // key -> Promise, da vzporedni klici za isti ključ ne podvojijo zahteve
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  // Ko se npr. iskanje in nalaganje .torrent datotek za več itemov zažene vzporedno
  // (Promise.all), bi brez tega dve sočasni zahtevi za isti ključ (preden se prva
  // shrani v cache) obe sprožili svoj loader - podvojena omrežna zahteva, podvojen
  // subrequest. Z deljenjem "in-flight" promisa dobi drugi klicatelj kar rezultat prvega.
  async getOrLoad(key, loader) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const value = await loader();
        this.set(key, value);
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }
}

export { TTLCache };
