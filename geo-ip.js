// geo-ip.js — approximate location (city, country, lat/lon) for an IP address, looked up on this server.
//
// Uses the free DB-IP "City Lite" database (CC BY 4.0: anything showing these results must credit
// "IP Geolocation by DB-IP" with a link to https://db-ip.com). The file is downloaded from DB-IP at start-up
// and refreshed monthly; IP addresses are never sent to any third-party service.
//
// Env:
//   GEOIP_ENABLED=1     turn ON (default OFF: the full City Lite file needs ~300 MB of memory, more than
//                       Render's free 512 MB plan can spare; only enable on a plan with enough memory)
//   GEOIP_FILE          path to a local .mmdb file instead of downloading (tests / offline)

import fs from 'node:fs';
import zlib from 'node:zlib';
import { Reader } from 'mmdb-lib';

const DAY_MS = 86400_000;   // timers must stay below 2^31 ms (~24.8 days) or Node fires them immediately

function monthUrl(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `https://download.db-ip.com/free/dbip-city-lite-${y}-${m}.mmdb.gz`;
}

export function createGeoIp({ enabled, file = process.env.GEOIP_FILE, fetchImpl = globalThis.fetch } = {}) {
  if (enabled === undefined) enabled = process.env.GEOIP_ENABLED === '1' || !!file;   // a local file means "use it"
  let reader = null, loadedFrom = null, loading = null;

  async function download() {
    const now = new Date();
    // This month's file appears on the 1st; fall back to last month's while it isn't published yet.
    for (const d of [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))]) {
      const url = monthUrl(d);
      try {
        const r = await fetchImpl(url);
        if (!r.ok) continue;
        const buf = zlib.gunzipSync(Buffer.from(await r.arrayBuffer()));
        return { buf, from: url };
      } catch (e) { console.log('[geoip] download failed:', url, e.message); }
    }
    throw new Error('no DB-IP City Lite file available');
  }

  async function load() {
    if (!enabled) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const { buf, from } = file ? { buf: fs.readFileSync(file), from: file } : await download();
        reader = new Reader(buf);          // swap only once the new file is fully ready
        loadedFrom = from;
        console.log(`[geoip] ready (${Math.round(buf.length / 1048576)} MB, ${from})`);
      } catch (e) {
        console.log('[geoip] not available:', e.message, '— map positions will be missing until the next attempt');
      } finally { loading = null; }
    })();
    return loading;
  }

  if (!enabled) console.log('[geoip] off (set GEOIP_ENABLED=1 on a plan with enough memory to show map locations)');
  if (enabled) {
    load();
    // Check once a day; download only when a newer monthly file is out (DB-IP publishes on the 1st).
    if (!file) {
      const t = setInterval(() => { const want = monthUrl(new Date()); if (loadedFrom !== want) load(); }, DAY_MS);
      t.unref?.();
    }
  }

  /** { city, region, country, lat, lon } or null (unknown / private address / database not loaded). */
  function lookup(ip) {
    if (!reader || !ip) return null;
    try {
      const x = reader.get(String(ip));
      const lat = x?.location?.latitude, lon = x?.location?.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') return null;
      return {
        city: x.city?.names?.en || null,
        region: x.subdivisions?.[0]?.names?.en || null,
        country: x.country?.iso_code || null,
        lat: Math.round(lat * 1000) / 1000,          // ~100 m; the data is city-level anyway
        lon: Math.round(lon * 1000) / 1000,
      };
    } catch { return null; }
  }

  return { lookup, get ready() { return !!reader; }, get source() { return loadedFrom; }, load };
}
