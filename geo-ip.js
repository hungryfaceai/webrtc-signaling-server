// geo-ip.js — approximate location (country + lat/lon) for an IP address, looked up on this server.
//
// Data: the free DB-IP "City Lite" database (CC BY 4.0: anything showing these results must credit
// "IP Geolocation by DB-IP" with a link to https://db-ip.com). The CSV is downloaded from DB-IP and
// STREAMED into compact typed arrays (~70 MB), so it fits a small server. IP addresses are never sent to
// any third-party service.
//
// Each table row is one address range: start (uint32), lat/lon (int16, degrees × 180 ≈ 600 m), country.
// IPv4 uses the full address; IPv6 uses its first 32 bits (the network part, enough for a map dot).
//
// Env:
//   GEOIP_ENABLED=1        turn ON (default OFF)
//   GEOIP_FILE             local .csv.gz to load instead of downloading (tests / offline)
//   GEOIP_MEMORY_LIMIT_MB  memory available to the server (default 512, Render's free plan)
//   GEOIP_MIN_FREE_MB      only build when at least this much of the limit is still free (default 220)

import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';

const DAY_MS = 86400_000;      // timers must stay below 2^31 ms (~24.8 days) or Node fires them immediately
const SCALE = 180;             // degrees × 180 fits int16 (±32,400) with ~600 m precision
const MEMORY_LIMIT_MB = Number(process.env.GEOIP_MEMORY_LIMIT_MB ?? 512);
const MIN_FREE_MB = Number(process.env.GEOIP_MIN_FREE_MB ?? 220);

function monthUrl(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `https://download.db-ip.com/free/dbip-city-lite-${y}-${m}.csv.gz`;
}

class Grow {   // growable typed array (no large JS arrays while streaming millions of rows)
  constructor(T, n = 1 << 18) { this.T = T; this.a = new T(n); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  done() { const r = this.a.slice(0, this.n); this.a = null; return r; }
}
const ip4 = s => { const p = s.split('.'); return (((+p[0]) << 24) >>> 0) + ((+p[1]) << 16) + ((+p[2]) << 8) + (+p[3]); };
function ip6top32(s) {
  const head = s.split('::')[0].split(':');
  return (((parseInt(head[0] || '0', 16) & 0xffff) << 16) | (parseInt(head[1] || '0', 16) & 0xffff)) >>> 0;
}
function find(arr, x) { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >>> 1; if (arr[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
const PRIVATE_V4 = /^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const PRIVATE_V6 = /^(f[cd]|fe[89ab]|::1$|::$)/i;

/** Build compact tables from a gzipped DB-IP City Lite CSV stream. */
async function buildTables(gzStream) {
  const mk = () => ({ s: new Grow(Uint32Array), la: new Grow(Int16Array), lo: new Grow(Int16Array), cc: new Grow(Uint8Array), last: '' });
  const v4 = mk(), v6 = mk(), countries = [], cIdx = new Map();
  const rl = readline.createInterface({ input: gzStream.pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    // start,end,continent,country,region,"city",lat,lon
    const c1 = line.indexOf(','), c2 = line.indexOf(',', c1 + 1), c3 = line.indexOf(',', c2 + 1), c4 = line.indexOf(',', c3 + 1);
    if (c4 < 0) continue;
    const cc = line.slice(c3 + 1, c4);
    const e2 = line.lastIndexOf(','), e1 = line.lastIndexOf(',', e2 - 1);
    let la = Math.round(+line.slice(e1 + 1, e2) * SCALE), lo = Math.round(+line.slice(e2 + 1) * SCALE);
    const start = line.slice(0, c1);
    const t = start.includes(':') ? v6 : v4;
    const unknown = cc === 'ZZ' || !Number.isFinite(la) || !Number.isFinite(lo);
    if (unknown) { la = 0; lo = 0; }
    const key = unknown ? 'ZZ' : la + ',' + lo + ',' + cc;
    if (key === t.last) continue;            // same place as the previous range: extend it
    let ci = 255;                            // 255 = unknown (gaps / reserved ranges stay "unknown", not the previous place)
    if (!unknown) { ci = cIdx.get(cc); if (ci === undefined) { ci = countries.length; countries.push(cc); cIdx.set(cc, ci); } if (ci > 254) ci = 255; }
    t.s.push(t === v6 ? ip6top32(start) : ip4(start)); t.la.push(la); t.lo.push(lo); t.cc.push(ci); t.last = key;
  }
  const fin = t => ({ s: t.s.done(), la: t.la.done(), lo: t.lo.done(), cc: t.cc.done() });
  return { v4: fin(v4), v6: fin(v6), countries };
}

export function createGeoIp({ enabled, file = process.env.GEOIP_FILE, fetchImpl = globalThis.fetch, startDelayMs } = {}) {
  if (enabled === undefined) enabled = process.env.GEOIP_ENABLED === '1' || !!file;   // a local file means "use it"
  let tables = null, loadedFrom = null, loading = null;

  async function openSource() {
    if (file) return { stream: fs.createReadStream(file, { highWaterMark: 1 << 16 }), from: file };
    const now = new Date();
    // This month's file appears on the 1st; fall back to last month's while it isn't published yet.
    for (const d of [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))]) {
      const url = monthUrl(d);
      if (url === loadedFrom) return null;   // already have the newest available file
      try {
        const r = await fetchImpl(url);
        if (r.ok && r.body) return { stream: Readable.fromWeb(r.body), from: url };
      } catch (e) { console.log('[geoip] download failed:', url, e.message); }
    }
    throw new Error('no DB-IP City Lite file available');
  }

  async function load() {
    if (!enabled) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        // Safety: only build if there is room; never risk the signalling server.
        const usedMb = process.memoryUsage().rss / 1048576;
        if (usedMb > MEMORY_LIMIT_MB - MIN_FREE_MB) {
          console.log(`[geoip] skipped: the server already uses ${Math.round(usedMb)} MB (needs ${MIN_FREE_MB} MB free of ${MEMORY_LIMIT_MB} MB)`);
          return;
        }
        const src = await openSource();
        if (!src) return;
        const t0 = Date.now();
        const next = await buildTables(src.stream);
        tables = next;                       // swap only once the new tables are complete
        loadedFrom = src.from;
        const mb = Math.round([next.v4, next.v6].reduce((a, t) => a + t.s.byteLength + t.la.byteLength + t.lo.byteLength + t.cc.byteLength, 0) / 1048576);
        console.log(`[geoip] ready (${next.v4.s.length.toLocaleString()} IPv4 + ${next.v6.s.length.toLocaleString()} IPv6 ranges, ${mb} MB, ${Math.round((Date.now() - t0) / 1000)} s, ${src.from}); server now ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
      } catch (e) {
        console.log('[geoip] not available:', e.message, '— map positions will be missing until the next attempt');
      } finally { loading = null; }
    })();
    return loading;
  }

  if (!enabled) console.log('[geoip] off (set GEOIP_ENABLED=1 to show map locations)');
  if (enabled) {
    const delay = startDelayMs ?? (file ? 0 : 15_000);   // let the server start serving first
    const t0 = setTimeout(load, delay); t0.unref?.();
    if (!file) {
      // Check once a day; download only when a newer monthly file is out (DB-IP publishes on the 1st).
      const t = setInterval(() => { if (loadedFrom !== monthUrl(new Date())) load(); }, DAY_MS);
      t.unref?.();
    }
  }

  /** { country, lat, lon } or null (unknown / private address / not loaded). */
  function lookup(ip) {
    if (!tables || !ip) return null;
    try {
      const s = String(ip).replace(/^::ffff:/i, '');
      const v6 = s.includes(':');
      if (v6 ? PRIVATE_V6.test(s) : PRIVATE_V4.test(s)) return null;
      const t = v6 ? tables.v6 : tables.v4;
      const i = find(t.s, v6 ? ip6top32(s) : ip4(s));
      if (i < 0 || t.cc[i] === 255) return null;
      return { city: null, region: null, country: tables.countries[t.cc[i]] || null,
               lat: Math.round(t.la[i] / SCALE * 1000) / 1000, lon: Math.round(t.lo[i] / SCALE * 1000) / 1000 };
    } catch { return null; }
  }

  return { lookup, enabled, get ready() { return !!tables; }, get source() { return loadedFrom; }, load };
}
