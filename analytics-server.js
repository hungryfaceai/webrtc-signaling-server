// server/analytics-server.js
// Lightweight analytics ingest + tiny dashboard.
// - Stores anonymous usage + active time + IP (full/truncated/hashed) + UA
// - Prunes exact IPs after a short retention window

import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import net from 'node:net';

export function mountAnalytics(app, opts = {}) {
  const base = opts.base ?? '/a';
  const dbPath = opts.dbPath ?? 'analytics.db';
  const ipSalt = opts.ipSalt ?? process.env.ANALYTICS_IP_SALT ?? 'rotate-me';
  const keepFullDays = opts.keepFullDays ?? 7;     // keep exact IP this long
  const keepAllDays = opts.keepAllDays ?? 180;     // keep rows this long

  // If your server sits behind a proxy (Render/Cloudflare/NGINX):
  app.set('trust proxy', true);

  // (Optional) CORS if your front-end is on a different origin (e.g., GitHub Pages)
  // Put your allowed origins below or remove this if same-origin.
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

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      app TEXT,
      feature TEXT,
      page TEXT,
      installId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      activeMs INTEGER NOT NULL,
      kind TEXT DEFAULT 'hb',   -- heartbeat or 'ev' for custom events
      ev TEXT,
      props TEXT,
      ip_full TEXT,
      ip_trunc TEXT,
      ip_hash TEXT,
      ua TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_install ON events(installId);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(sessionId);
    CREATE INDEX IF NOT EXISTS idx_events_iphash ON events(ip_hash);
    CREATE INDEX IF NOT EXISTS idx_events_iptrunc ON events(ip_trunc);
  `);

  const insert = db.prepare(`
    INSERT INTO events (ts, app, feature, page, installId, sessionId, activeMs, kind, ev, props, ip_full, ip_trunc, ip_hash, ua)
    VALUES (@ts, @app, @feature, @page, @installId, @sessionId, @activeMs, @kind, @ev, @props, @ip_full, @ip_trunc, @ip_hash, @ua)
  `);

  app.post(`${base}/evt`, express.json(), (req, res) => {
    const b = req.body || {};
    if (!b.ts || !b.installId || !b.sessionId) return res.sendStatus(400);

    const ip = getClientIp(req);
    const row = {
      ts: +b.ts,
      app: b.app || 'app',
      feature: b.feature || '',
      page: b.page || '',
      installId: String(b.installId).slice(0,128),
      sessionId: String(b.sessionId).slice(0,128),
      activeMs: Math.max(0, +b.activeMs|0),
      kind: b.t === 'ev' ? 'ev' : 'hb',
      ev: b.ev || null,
      props: b.props ? JSON.stringify(b.props).slice(0, 2000) : null,
      ip_full: ip || null,
      ip_trunc: ip ? truncateIp(ip) : null,
      ip_hash: ip ? hashIp(ip, ipSalt) : null,
      ua: req.headers['user-agent']?.toString().slice(0,256) || null,
    };

    try { insert.run(row); } catch (e) { console.warn('[analytics] insert failed:', e); }
    res.sendStatus(204);
  });

  // JSON summary (DAU/WAU/MAU + avg session seconds + daily uniques)
  app.get(`${base}/summary.json`, (req, res) => {
    const days = Math.max(1, Math.min(180, +(req.query.days || 30)));
    const since = Date.now() - days*86400*1000;

    const dau = db.prepare(`SELECT COUNT(DISTINCT installId) AS n FROM events WHERE ts >= ?`).get(Date.now()-86400*1000).n;
    const wau = db.prepare(`SELECT COUNT(DISTINCT installId) AS n FROM events WHERE ts >= ?`).get(Date.now()-7*86400*1000).n;
    const mau = db.prepare(`SELECT COUNT(DISTINCT installId) AS n FROM events WHERE ts >= ?`).get(Date.now()-30*86400*1000).n;

    const uniquesByDay = db.prepare(`
      SELECT date(ts/1000,'unixepoch') AS day, COUNT(DISTINCT installId) AS uniques
      FROM events WHERE ts >= ? GROUP BY day ORDER BY day DESC
    `).all(since);

    const avgSec = db.prepare(`
      SELECT AVG(mx) AS avgMs FROM (
        SELECT sessionId, MAX(activeMs) AS mx FROM events WHERE ts >= ? GROUP BY sessionId
      )
    `).get(since).avgMs;

    res.json({
      days,
      dau, wau, mau,
      avgSessionSeconds: Math.round((avgSec || 0) / 1000),
      daily: uniquesByDay,
    });
  });

  // Minimal HTML dashboard
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
    const rows = data.daily.map(d => '<tr><td>'+d.day+'</td><td>'+d.uniques+'</td></tr>').join('');
    document.getElementById('daily').innerHTML = '<tr><th>Day</th><th>Uniques</th></tr>'+rows;
  }
  run();
</script>`);
  });

  // Prune: clear ip_full after keepFullDays, drop very old rows after keepAllDays
  app.post(`${base}/prune`, (req, res) => {
    const now = Date.now();
    const cutoffFull = now - keepFullDays*86400*1000;
    const cutoffAll  = now - keepAllDays*86400*1000;
    const cleared = db.prepare(`UPDATE events SET ip_full=NULL WHERE ts < ? AND ip_full IS NOT NULL`).run(cutoffFull);
    const deleted = db.prepare(`DELETE FROM events WHERE ts < ?`).run(cutoffAll);
    res.json({ ip_full_cleared: cleared.changes, rows_deleted: deleted.changes, keepAllDays });
  });
}

// ---- Helpers ----
function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  const xr = req.headers['x-real-ip'];
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
