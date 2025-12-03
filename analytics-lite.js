// server/analytics-lite.js
import express from 'express';
import crypto from 'node:crypto';
import net from 'node:net';

export function mountAnalyticsLite(app, opts = {}) {
  const base   = opts.base   ?? '/a';
  const ipSalt = opts.ipSalt ?? 'rotate-me';
  const MAX_EVENTS = opts.maxEvents ?? 20000;

  // If behind proxy (Render/Cloudflare/etc.)
  app.set('trust proxy', true);

  // Optional CORS (same idea as your existing code)
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

  app.use(base, (_req, res, next) => { 
    res.set('Cache-Control', 'no-store'); 
    next(); 
  });

  // In-memory buffer of recent events
  const events = [];
  const sseClients = new Set();  // Set<ServerResponse>

  function pushEvent(row) {
    events.push(row);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

    const payload = `data:${JSON.stringify(row)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch {}
    }
  }

  // ---- Ingest endpoint: POST /a/evt ----
  app.post(`${base}/evt`, express.json(), (req, res) => {
    const b = req.body || {};
    if (!b.installId || !b.sessionId) return res.sendStatus(400);

    const ip = getClientIp(req);
    const ts = new Date(+b.ts || Date.now());

    const row = {
      ts: ts.toISOString(),
      app:      b.app      || 'app',
      feature:  b.feature  || '',
      page:     b.page     || '',
      installId: String(b.installId).slice(0,128),
      sessionId: String(b.sessionId).slice(0,128),
      activeMs: Math.max(0, b.activeMs | 0),
      kind:     b.t === 'ev' ? 'ev' : 'hb',
      ev:       b.ev || null,
      props:    b.props ?? null,
      ip_full:  ip || null,
      ip_trunc: ip ? truncateIp(ip) : null,
      ip_hash:  ip ? hashIp(ip, ipSalt) : null,
      ua: req.headers['user-agent']?.toString().slice(0,256) || null,
    };

    pushEvent(row);
    return res.sendStatus(204);
  });

  // ---- Streaming endpoint: GET /a/stream ----
  app.get(`${base}/stream`, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Optional: send a comment to open the stream
    res.write(':\n\n');

    // Optional: send existing buffer so you see history when you open the page
    for (const ev of events) {
      res.write(`data:${JSON.stringify(ev)}\n\n`);
    }

    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  // Simple “it’s up” health check
  app.get(`${base}/health`, (_req, res) => {
    res.json({ ok: true, events: events.length });
  });

  // Tiny HTML stub if you hit /a in a browser
  app.get(`${base}`, (_req, res) => {
    res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>Naptio Analytics (stream)</title>
<body style="background:#000;color:#eee;font-family:system-ui">
  <h1>Naptio Analytics stream</h1>
  <p>Use <code>${base}/stream</code> from your admin page via EventSource.</p>
</body>`);
  });

  app.get(`${base}/`, (_req, res) => res.redirect(base));
}

// ---- Helpers copied from your existing file, but without PG ----
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
    const parts = full.split(':');
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
