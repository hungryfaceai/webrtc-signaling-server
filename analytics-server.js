// server/analytics-server.js
// Lightweight analytics ingest + tiny dashboard (Postgres edition).
// - Stores anonymous usage + active time + IP (full/truncated/hashed) + UA
// - Prunes exact IPs after a short retention window

import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import pg from 'pg';

const { Pool } = pg;

export function mountAnalytics(app, opts = {}) {
  const base = opts.base ?? '/a';
  const ipSalt = opts.ipSalt ?? process.env.ANALYTICS_IP_SALT ?? 'rotate-me';
  const keepFullDays = opts.keepFullDays ?? 7;   // keep exact IP this long
  const keepAllDays  = opts.keepAllDays  ?? 180; // keep rows this long

  // If your server sits behind a proxy (Render/Cloudflare/NGINX):
  app.set('trust proxy', true);

  // Optional CORS if your front-end is on a different origin (e.g., GitHub Pages)
  const allowed = (opts.allowedOrigins ?? []).map(s => s.toLowerCase());
  if (allowed.length) {
    app.use(base, (req, res, next) => {
      const o = (req.headers.origin || '').toLowerCase();
      if (allowed.includes(o)) res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });
  }

  // ---- Postgres pool ----
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.PG_CONNECTION_STRING,
    ssl: { rejectUnauthorized: false }, // Render PG requires SSL
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: 30_000,
  });

  // Create schema on boot (fire-and-forget)
  ensureSchema(pool).catch(err =>
    console.error('[analytics] failed to ensure schema:', err)
  );

  // ---- Ingest endpoint ----
  app.post(`${base}/evt`, express.json(), async (req, res) => {
    const b = req.body || {};
    if (!b.ts || !b.installId || !b.sessionId) return res.sendStatus(400);

    const ip = getClientIp(req);

    const row = {
      ts:   new Date(+b.ts || Date.now()),
      app:  b.app || 'app',
      feature: b.feature || '',
      page: b.page || '',
      installId: String(b.installId).slice(0,128),
      sessionId: String(b.sessionId).slice(0,128),
      activeMs: Math.max(0, +b.activeMs|0),
      kind: b.t === 'ev' ? 'ev' : 'hb',
      ev:   b.ev || null,
      // keep TEXT for props to avoid driver/json casting edge cases
      props: b.props ? safeJsonString(b.props, 2000) : null,
      ip_full: ip || null,
      ip_trunc: ip ? truncateIp(ip) : null,
      ip_hash: ip ? hashIp(ip, ipSalt) : null,
      ua: req.headers['user-agent']?.toString().slice(0,256) || null,
    };

    try {
      await pool.query(
        `INSERT INTO events
          (ts, app, feature, page, installId, sessionId, activeMs, kind, ev, props, ip_full, ip_trunc, ip_hash, ua)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          row.ts, row.app, row.feature, row.page,
          row.installId, row.sessionId, row.activeMs,
          row.kind, row.ev, row.props,
          row.ip_full, row.ip_trunc, row.ip_hash, row.ua
        ]
      );
      res.sendStatus(204);
    } catch (e) {
      console.warn('[analytics] insert failed:', e);
      res.sendStatus(204); // don't break clients
    }
  });

  // ---- Summary JSON ----
  app.get(`${base}/summary.json`, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(180, +(req.query.days || 30)));
      const since = new Date(Date.now() - days*86400*1000);

      const [{ n: dau }] = (await pool.query(
        `SELECT COUNT(DISTINCT installId) AS n
         FROM events WHERE ts >= NOW() - INTERVAL '1 day'`
      )).rows;

      const [{ n: wau }] = (await pool.query(
        `SELECT COUNT(DISTINCT installId) AS n
         FROM events WHERE ts >= NOW() - INTERVAL '7 days'`
      )).rows;

      const [{ n: mau }] = (await pool.query(
        `SELECT COUNT(DISTINCT installId) AS n
         FROM events WHERE ts >= NOW() - INTERVAL '30 days'`
      )).rows;

      const daily = (await pool.query(
        `SELECT to_char(date_trunc('day', ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                COUNT(DISTINCT installId) AS uniques
           FROM events
          WHERE ts >= $1
          GROUP BY 1
          ORDER BY 1 DESC`,
        [since]
      )).rows;

      const [{ avgms }] = (await pool.query(
        `WITH per_session AS (
           SELECT sessionId, MAX(activeMs) AS mx
             FROM events
            WHERE ts >= $1
            GROUP BY sessionId
         )
         SELECT AVG(mx)::float AS avgms FROM per_session`,
        [since]
      )).rows;

      res.json({
        days,
        dau: Number(dau) || 0,
        wau: Number(wau) || 0,
        mau: Number(mau) || 0,
        avgSessionSeconds: Math.round((avgms || 0) / 1000),
        daily
      });
    } catch (e) {
      console.error('[analytics] summary failed:', e);
      res.status(500).json({ error: 'summary_failed' });
    }
  });

  // ---- Minimal HTML dashboard ----
  app.get(`${base}`, (req, res) => {
    res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>Analytics</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;color:#eee;background:#000}
h1{margin:0 0 12px} table{border-collapse:collapse} td,th{padding:6px 10px;border-bottom:1px solid #222}</style>
<h1>Naptio Analytics</h1>
<p><em>Anonymous uniques + active session time</em></p>
<div id="cards">Loading…</div>
<table id="daily"></table>
<script type="module">
  async function run(){
    const data = await fetch('./summary.json?days=30').then(r=>r.json());
    document.getElementById('cards').innerHTML =
      '<p>DAU: <b>'+data.dau+'</b> | WAU: <b>'+data.wau+
      '</b> | MAU: <b>'+data.mau+'</b> | Avg session: <b>'+data.avgSessionSeconds+'s</b></p>';
    const rows = (data.daily||[]).map(d => '<tr><td>'+d.day+'</td><td>'+d.uniques+'</td></tr>').join('');
    document.getElementById('daily').innerHTML = '<tr><th>Day</th><th>Uniques</th></tr>'+rows;
  }
  run();
</script>`);
  });

  // ---- Prune: clear ip_full after keepFullDays, drop very old rows after keepAllDays ----
  app.post(`${base}/prune`, async (req, res) => {
    try {
      const cleared = await pool.query(
        `UPDATE events
            SET ip_full = NULL
          WHERE ts < NOW() - ($1 || ' days')::interval
            AND ip_full IS NOT NULL`,
        [String(keepFullDays)]
      );
      const deleted = await pool.query(
        `DELETE FROM events
          WHERE ts < NOW() - ($1 || ' days')::interval`,
        [String(keepAllDays)]
      );
      res.json({ ip_full_cleared: cleared.rowCount, rows_deleted: deleted.rowCount, keepAllDays });
    } catch (e) {
      console.error('[analytics] prune failed:', e);
      res.status(500).json({ error: 'prune_failed' });
    }
  });
}

// ---- Schema bootstrap ----
async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app TEXT,
      feature TEXT,
      page TEXT,
      installId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      activeMs INTEGER NOT NULL,
      kind TEXT DEFAULT 'hb',
      ev TEXT,
      props TEXT,              -- keep as TEXT to avoid driver casting issues
      ip_full TEXT,
      ip_trunc TEXT,
      ip_hash TEXT,
      ua TEXT
    );
    CREATE INDEX IF NOT EXISTS events_ts_idx       ON events(ts);
    CREATE INDEX IF NOT EXISTS events_install_idx  ON events(installId);
    CREATE INDEX IF NOT EXISTS events_session_idx  ON events(sessionId);
    CREATE INDEX IF NOT EXISTS events_iphash_idx   ON events(ip_hash);
    CREATE INDEX IF NOT EXISTS events_iptrunc_idx  ON events(ip_trunc);
  `);
}

// ---- Helpers ----
function safeJsonString(val, maxLen = 2000) {
  try {
    const s = typeof val === 'string' ? val : JSON.stringify(val);
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  } catch { return null; }
}

function getClientIp(req) {
  const cf  = req.headers['cf-connecting-ip'];
  const xr  = req.headers['x-real-ip'];
  const xff = (req.headers['x-forwarded-for'] || '').toString().split(',')[0]?.trim();
  return (cf || xr || xff || req.ip || '').trim();
}

function truncateIp(ip) {
  const ver = net.isIP(ip);
  if (ver === 4) {
    const p = ip.split('.'); p[3] = '0'; return p.join('.') + '/24';
  }
  if (ver === 6) {
    const full = expandIPv6(ip);
    const parts = full.split(':'); // 8 hextets
    return parts.slice(0,4).join(':') + '::/64';
  }
  return '';
}

function expandIPv6(ip) {
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const zeros = new Array(8 - headParts.length - tailParts.length).fill('0');
    return [...headParts, ...zeros, ...tailParts].map(h=>h.padStart(4,'0')).join(':');
  }
  return ip.split(':').map(h=>h.padStart(4,'0')).join(':');
}

function hashIp(ip, salt) {
  return crypto.createHash('sha256').update(`${salt}|${ip}`).digest('base64url');
}
