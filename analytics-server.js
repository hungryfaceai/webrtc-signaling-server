// server/analytics-server.js
// Lightweight analytics ingest + tiny dashboard (Postgres edition).
// - Anonymous usage + active time + IP (full/truncated/hashed) + UA
// - Prunes exact IPs after a short retention window
// - Adds /a/health and waits for schema readiness to avoid early 500s

import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';
import pg from 'pg';

const { Pool } = pg;

export function mountAnalytics(app, opts = {}) {
  const base = opts.base ?? '/a';
  const ipSalt = opts.ipSalt ?? process.env.ANALYTICS_IP_SALT ?? 'rotate-me';
  const keepFullDays = opts.keepFullDays ?? 7;   // exact IP retention
  const keepAllDays  = opts.keepAllDays  ?? 180; // row retention

  // If your server sits behind a proxy (Render/Cloudflare/NGINX):
  app.set('trust proxy', true);

  // Optional CORS if your front-end is on a different origin (e.g., GitHub Pages)
  const allowed = (opts.allowedOrigins ?? []).map(s => s.toLowerCase());
  if (allowed.length) {
    app.use(base, (req, res, next) => {
      const o = (req.headers.origin || '').toLowerCase();
      if (allowed.includes(o)) res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, accept, authorization');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });
  }

  app.use(base, (_req, res, next) => { res.set('Cache-Control','no-store'); next(); });

  // Simple admin gate: either ?key=... OR Basic Auth using env vars
  function requireAdmin(req, res, next) {
    const qk = process.env.ANALYTICS_ADMIN_KEY;
    if (qk && req.query.key === qk) return next();
  
    const u = process.env.ADMIN_USER;
    const p = process.env.ADMIN_PASS;
    if (u && p) {
      const hdr = req.headers.authorization || '';
      if (hdr.startsWith('Basic ')) {
        const [user, pass] = Buffer.from(hdr.slice(6), 'base64').toString().split(':');
        if (user === u && pass === p) return next();
      }
      res.set('WWW-Authenticate', 'Basic realm="Analytics Admin"');
      return res.status(401).send('Unauthorized');
    }
    // If no secrets configured, block by default
    return res.status(401).send('Admin access not configured');
  }

  // ---- Postgres pool ----
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.PG_CONNECTION_STRING;

  if (!connectionString) {
    console.error('[analytics] No DATABASE_URL/POSTGRES_URL set');
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Render PG requires SSL
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: 30_000,
  });

  // Ensure schema and wait for it in routes
  const ready = ensureSchema(pool).then(() => {
    console.log('[analytics] schema ready');
  }).catch(err => {
    console.error('[analytics] failed to ensure schema:', err);
    throw err;
  });

  // ---- Ingest endpoint ----
  app.post(`${base}/evt`, express.json(), async (req, res) => {
    try {
      await ready;

      const b = req.body || {};
      if (!b.installId || !b.sessionId) return res.sendStatus(400);

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

      // Insert should never break the client flow; log and return 204 on failure.
      try {
        await pool.query(
          `INSERT INTO events
           (ts, app, feature, page, installId, sessionId, activeMs, kind, ev, props, ip_full, ip_trunc, ip_hash, ua)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            row.ts, row.app, row.feature, row.page,
            row.installId, row.sessionId, row.activeMs,
            row.kind, row.ev, row.props,
            row.ip_full, row.ip_trunc, row.ip_hash, row.ua
          ]
        );
      } catch (e) {
        console.warn('[analytics] insert failed:', e);
        return res.sendStatus(204);
      }

      return res.sendStatus(204);
    } catch (e) {
      console.error('[analytics] /evt failed before insert:', e);
      return res.status(500).end();
    }
  });

  // ---- Summary JSON ----
  app.get(`${base}/summary.json`, async (req, res) => {
    try {
      await ready;

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
        `SELECT to_char(date_trunc('day', ts AT TIME ZONE 'Europe/London'), 'YYYY-MM-DD') AS day,
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

      return res.json({
        days,
        dau: Number(dau) || 0,
        wau: Number(wau) || 0,
        mau: Number(mau) || 0,
        avgSessionSeconds: Math.round((avgms || 0) / 1000),
        daily
      });
    } catch (e) {
      console.error('[analytics] summary failed:', e);
      return res.status(500).json({ error: 'summary_failed', message: e.message });
    }
  });

  // ---- Rich metrics (cards + tables) ----
  app.get(`${base}/metrics.json`, async (_req, res) => {
    try {
      await ready;

      const [{ n_live }] = (await pool.query(
        `SELECT COUNT(DISTINCT installId) AS n_live
           FROM events
          WHERE ts >= NOW() - INTERVAL '2 minutes'`
      )).rows;
  
      const topFeatures7d = (await pool.query(
        `SELECT feature, COUNT(DISTINCT installId) AS uniques
           FROM events
          WHERE ts >= NOW() - INTERVAL '7 days'
          GROUP BY feature
          ORDER BY uniques DESC
          LIMIT 10`
      )).rows;
  
      const topEvents7d = (await pool.query(
        `SELECT ev, COUNT(*) AS n
           FROM events
          WHERE kind = 'ev'
            AND ts >= NOW() - INTERVAL '7 days'
          GROUP BY ev
          ORDER BY n DESC
          LIMIT 10`
      )).rows;
  
      const pairing7d = (await pool.query(
        `WITH base AS (
           SELECT installId, sessionId, ev
             FROM events
            WHERE kind='ev'
              AND ts >= NOW() - INTERVAL '7 days'
              AND ev IN ('pair-init','pair-ack','pair-done')
            GROUP BY installId, sessionId, ev
         )
         SELECT
           (SELECT COUNT(*) FROM (SELECT DISTINCT installId, sessionId FROM base WHERE ev='pair-init') x) AS init,
           (SELECT COUNT(*) FROM (SELECT DISTINCT installId, sessionId FROM base WHERE ev='pair-ack') x) AS ack,
           (SELECT COUNT(*) FROM (SELECT DISTINCT installId, sessionId FROM base WHERE ev='pair-done') x) AS done`
      )).rows[0] || { init: 0, ack: 0, done: 0 };
  
      const errors7d = (await pool.query(
        `SELECT ev, COUNT(*) AS n
           FROM events
          WHERE kind='ev'
            AND ts >= NOW() - INTERVAL '7 days'
            AND (ev ILIKE 'error_%' OR ev ILIKE '%_failed' OR ev ILIKE '%_timeout')
          GROUP BY ev
          ORDER BY n DESC
          LIMIT 10`
      )).rows;
  
      const daily30 = (await pool.query(
        `SELECT to_char(date_trunc('day', ts AT TIME ZONE 'Europe/London'), 'YYYY-MM-DD') AS day,
                COUNT(DISTINCT installId) AS uniques
           FROM events
          WHERE ts >= NOW() - INTERVAL '30 days'
          GROUP BY 1
          ORDER BY 1 DESC`
      )).rows;
  
      return res.json({
        live: Number(n_live) || 0,
        topFeatures7d,
        topEvents7d,
        pairing7d,
        errors7d,
        daily30
      });
    } catch (e) {
      console.error('[analytics] metrics failed:', e);
      return res.status(500).json({ error: 'metrics_failed', message: e.message });
    }
  });

  // ---- Minimal HTML dashboard (now shows rich metrics) ----
  app.get(`${base}`, (_req, res) => {
    res.type('html').send(`<!doctype html>
  <meta charset="utf-8">
  <title>Analytics</title>
  <style>
    :root { color-scheme: dark; }
    body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;color:#eee;background:#000;line-height:1.4}
    h1{margin:0 0 12px}
    h2{margin:18px 0 8px;font-size:16px}
    .cards p{margin:0 0 10px}
    table{border-collapse:collapse;margin:8px 0 16px;width:100%;max-width:800px}
    td,th{padding:6px 10px;border-bottom:1px solid #222;text-align:left}
    th{opacity:.8;font-weight:600}
    .muted{opacity:.7}
  </style>
  <h1>Naptio Analytics</h1>
  <p class="muted"><em>Anonymous uniques + active session time</em></p>
  
  <div class="cards" id="cards">Loading…</div>
  
  <h2>Top features (7d)</h2>
  <div id="topFeatures"></div>
  
  <h2>Top events (7d)</h2>
  <div id="topEvents"></div>
  
  <h2>Pairing funnel (7d)</h2>
  <div id="pairing"></div>
  
  <h2>Errors (7d)</h2>
  <div id="errors"></div>
  
  <h2>Daily uniques (30d)</h2>
  <div id="daily"></div>
  
  <script type="module">
    async function run(){
      try {
        const r = await fetch('${base}/metrics.json');
        if (!r.ok) throw new Error('HTTP '+r.status);
        const m = await r.json();
  
        // KPI cards
        document.getElementById('cards').innerHTML =
          '<p>Live (2m): <b>'+m.live+
          '</b> | Top feature: <b>'+(m.topFeatures7d?.[0]?.feature ?? '—')+'</b> ('+(m.topFeatures7d?.[0]?.uniques ?? 0)+' uniques)</p>';
  
        // helpers
        const table = (rows, headers) => {
          const head = '<tr>' + headers.map(h=>'<th>'+h+'</th>').join('') + '</tr>';
          const body = (rows||[]).map(r => '<tr>' + headers.map(h => {
            const k = h; const v = r[k] ?? r[k.toLowerCase()];
            return '<td>'+ (v ?? '') + '</td>';
          }).join('') + '</tr>').join('');
          return '<table>'+head+body+'</table>';
        };
        const pct = (a,b) => { a=+a||0; b=+b||0; return b? Math.round(a*1000/b)/10+'%':'—'; };
  
        // sections
        document.getElementById('topFeatures').innerHTML = table(m.topFeatures7d, ['feature','uniques']);
        document.getElementById('topEvents').innerHTML   = table(m.topEvents7d,   ['ev','n']);
        document.getElementById('errors').innerHTML      = table(m.errors7d,      ['ev','n']);
  
        const pf = m.pairing7d || {init:0,ack:0,done:0};
        document.getElementById('pairing').innerHTML =
          '<table><tr><th>init</th><th>ack</th><th>done</th><th>ack/init</th><th>done/init</th></tr>'+
          '<tr><td>'+pf.init+'</td><td>'+pf.ack+'</td><td>'+pf.done+'</td>'+
          '<td>'+pct(pf.ack,pf.init)+'</td><td>'+pct(pf.done,pf.init)+'</td></tr></table>';
  
        document.getElementById('daily').innerHTML = table(m.daily30, ['day','uniques']);
      } catch (err) {
        document.getElementById('cards').textContent = 'Error: ' + err.message;
      }
    }
    run();
  </script>`);
  });

  app.get(`${base}/`, (_req, res) => res.redirect(base));

  // Recent events with IPs (admin)
  app.get(`${base}/admin/recent.json`, requireAdmin, async (req, res) => {
    try {
      await ready;

      const days  = Math.min(180, Math.max(1, +(req.query.days || 7)));
      const limit = Math.min(2000, Math.max(1, +(req.query.limit || 200)));
      const feature = (req.query.feature || '').toString().trim();
      const allowFull = req.query.full === '1'; // show ip_full only if admin requests it
  
      const params = [days, limit];
      const where  = [`ts >= NOW() - ($1 || ' days')::interval`];
      if (feature) { where.push(`feature = $3`); params.push(feature); }
  
      const sql = `
        SELECT ts, app, feature, page, installId, sessionId, activeMs, kind, ev,
               ip_full, ip_trunc, ip_hash, ua
          FROM events
         WHERE ${where.join(' AND ')}
         ORDER BY ts DESC
         LIMIT $2
      `;
      const rows = (await pool.query(sql, params)).rows;
  
      // Only include ip_full if explicitly requested (and you may still redact)
      if (!allowFull) {
        for (const r of rows) r.ip_full = null;
      }
      return res.json({ days, limit, feature: feature || null, rows });
    } catch (e) {
      console.error('[analytics] admin recent failed:', e);
      return res.status(500).json({ error: 'admin_recent_failed', message: e.message });
    }
  });

  // Per-install aggregates (admin)
  app.get(`${base}/admin/installs.json`, requireAdmin, async (req, res) => {
    try {
      await ready;

      const days  = Math.min(180, Math.max(1, +(req.query.days || 30)));
      const limit = Math.min(1000, Math.max(1, +(req.query.limit || 200)));
      const feature = (req.query.feature || '').toString().trim();
  
      const params = [days, limit];
      const where  = [`ts >= NOW() - ($1 || ' days')::interval`];
      if (feature) { where.push(`feature = $3`); params.push(feature); }
  
      const sql = `
        WITH sess AS (
          SELECT installId, sessionId,
                 MIN(ts) AS first_ts,
                 MAX(ts) AS last_ts,
                 MAX(activeMs) AS active_ms
            FROM events
           WHERE ${where.join(' AND ')}
           GROUP BY installId, sessionId
        ),
        feat AS (
          SELECT installId, COUNT(DISTINCT feature) AS features
            FROM events
           WHERE ${where.join(' AND ')}
           GROUP BY installId
        )
        SELECT s.installId,
               MIN(s.first_ts)  AS first_seen,
               MAX(s.last_ts)   AS last_seen,
               COUNT(*)         AS sessions,
               COALESCE(SUM(s.active_ms),0) AS active_ms,
               COALESCE(f.features,0)       AS features
          FROM sess s
          LEFT JOIN feat f ON f.installId = s.installId
         GROUP BY s.installId, f.features
         ORDER BY last_seen DESC
         LIMIT $2
      `;
      const rows = (await pool.query(sql, params)).rows;
      return res.json({ days, limit, feature: feature || null, rows });
    } catch (e) {
      console.error('[analytics] admin installs failed:', e);
      return res.status(500).json({ error: 'admin_installs_failed', message: e.message });
    }
  });

  // Admin UI (IP view + install aggregates)
  app.get(`${base}/admin`, requireAdmin, (_req, res) => {
    res.type('html').send(`<!doctype html>
  <meta charset="utf-8">
  <title>Analytics Admin</title>
  <style>
    :root { color-scheme: dark }
    body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;background:#000;color:#eee}
    h1{margin:0 0 12px} h2{margin:18px 0 8px;font-size:16px}
    label{margin-right:10px}
    table{border-collapse:collapse;margin:8px 0 16px;width:100%;max-width:1200px}
    td,th{padding:6px 10px;border-bottom:1px solid #222;text-align:left}
    th{opacity:.8}
    input,select{background:#111;border:1px solid #333;color:#eee;padding:6px 8px;border-radius:6px}
    .controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
  </style>
  
  <h1>Naptio Analytics Admin</h1>
  <div class="controls">
    <label>Days <input id="days" type="number" min="1" max="180" value="7"></label>
    <label>Limit <input id="limit" type="number" min="1" max="2000" value="200"></label>
    <label>Feature <input id="feature" placeholder="(any)"></label>
    <label><input id="full" type="checkbox"> Show full IPs</label>
    <button id="load">Load</button>
  </div>
  
  <h2>Recent events</h2>
  <div id="recent"></div>
  
  <h2>Installs (aggregates)</h2>
  <div id="installs"></div>
  
  <script type="module">
    const qs = new URLSearchParams(location.search);
    const key = qs.get('key'); // pass ?key=... if you use ANALYTICS_ADMIN_KEY
  
    const $ = s => document.querySelector(s);
    $('#load').addEventListener('click', run);
    run();
  
    function table(rows, headers){
      const head = '<tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr>';
      const body = (rows||[]).map(r => '<tr>'+headers.map(h=>{
        const k = h.toLowerCase().replace(/\\s+/g,'_');
        return '<td>'+ (r[h] ?? r[k] ?? '') + '</td>';
      }).join('') + '</tr>').join('');
      return '<table>'+head+body+'</table>';
    }
  
    function maskIp(ip){
      if(!ip) return '';
      if(/:\\d+$/.test(ip)) ip = ip.replace(/:\\d+$/,''); // strip port
      if(ip.includes('.')){
        const p = ip.split('.'); p[3] = '*'; return p.join('.');
      }
      if(ip.includes(':')){
        const p = ip.split(':'); return p.slice(0,4).join(':') + ':*:*:*:*';
      }
      return ip;
    }
  
    async function run(){
      const days = +$('#days').value||7;
      const limit = +$('#limit').value||200;
      const feature = $('#feature').value.trim();
      const full = $('#full').checked ? '1' : '0';
      const base = '${base}';
  
      const q = p => Object.entries(p).filter(([,v])=>v!=null && v!=='')
                    .map(([k,v])=>k+'='+encodeURIComponent(v)).join('&');
  
      const urlRecent   = base + '/admin/recent.json?' + q({ days, limit, feature, full, key });
      const urlInstalls = base + '/admin/installs.json?' + q({ days: Math.min(days,30), limit: 500, feature, key });
  
      try{
        const [r1, r2] = await Promise.all([fetch(urlRecent), fetch(urlInstalls)]);
        if(!r1.ok) throw new Error('recent: HTTP '+r1.status);
        if(!r2.ok) throw new Error('installs: HTTP '+r2.status);
        const recent   = await r1.json();
        const installs = await r2.json();
  
        const rows = (recent.rows||[]).map(r => ({
          ts: new Date(r.ts).toISOString().replace('T',' ').slice(0,19),
          app: r.app, feature: r.feature, page: r.page,
          installId: r.installid, sessionId: r.sessionid,
          activeMs: r.activems, kind: r.kind, ev: r.ev,
          ip_full: $('#full').checked ? (r.ip_full || '') : maskIp(r.ip_full) || r.ip_trunc,
          ip_trunc: r.ip_trunc, ip_hash: r.ip_hash,
          ua: r.ua
        }));
  
        $('#recent').innerHTML = table(rows, [
          'ts','app','feature','page',
          'installId','sessionId','activeMs','kind','ev',
          'ip_full','ip_trunc','ip_hash','ua'
        ]);
  
        const rows2 = (installs.rows||[]).map(r => ({
          installId: r.installid,
          first_seen: new Date(r.first_seen).toISOString().slice(0,19).replace('T',' '),
          last_seen:  new Date(r.last_seen).toISOString().slice(0,19).replace('T',' '),
          sessions: r.sessions,
          active_ms: r.active_ms,
          features: r.features
        }));
        $('#installs').innerHTML = table(rows2, [
          'installId','first_seen','last_seen','sessions','active_ms','features'
        ]);
      }catch(e){
        $('#recent').textContent = 'Error: ' + e.message;
        $('#installs').textContent = '';
      }
    }
  </script>`);
  });

  // ---- Prune: clear ip_full after keepFullDays, drop very old rows after keepAllDays ----
  app.post(`${base}/prune`, requireAdmin, async (_req, res) => {
    try {
      await ready;

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
      return res.json({ ip_full_cleared: cleared.rowCount, rows_deleted: deleted.rowCount, keepAllDays });
    } catch (e) {
      console.error('[analytics] prune failed:', e);
      return res.status(500).json({ error: 'prune_failed', message: e.message });
    }
  });

  // ---- Health: verifies DB connectivity quickly ----
  app.get(`${base}/health`, async (_req, res) => {
    try {
      await ready;
      const r = await pool.query('SELECT 1 AS ok');
      return res.json({ ok: r.rows?.[0]?.ok === 1 });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
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
    CREATE INDEX IF NOT EXISTS events_feature_idx  ON events(feature);
    CREATE INDEX IF NOT EXISTS events_kind_ev_idx  ON events(ev) WHERE kind='ev';

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
