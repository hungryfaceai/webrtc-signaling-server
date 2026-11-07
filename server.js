// server.js — Express + WebSocket signaling with rooms + targeted routing
// Adds fingerprint relay for roomless pairing/signaling.
// Emits: hello(id), roster(peers[{id,role}]), peer-joined/peer-left
// Forwards (rooms): offer/answer/candidate/bye/need-offer (adds {from}; honors {to})
// Forwards (roomless): register(fp), relay({to:fp,...}), pair-init/pair-ack

import express from 'express';
import { WebSocketServer,  WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import cors from 'cors';
import { createAdminAuth } from './admin-auth.js';
import { createActivityLog, clientIp } from './activity-log.js';
import { createGeoIp } from './geo-ip.js';

const PORT    = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || '/ws';

// Admin sign-in for /rooms (see admin-auth.js): ADMIN_PASSWORD_HASH on Render enables password
// sign-in; the older ADMIN_KEY still works until it is removed. With neither, /rooms is disabled.
const adminAuth = createAdminAuth(process.env);

// Abuse limits (overridable via env)
const MAX_MSG_BYTES       = Number(process.env.MAX_MSG_BYTES)       || 64 * 1024; // SDP offers are ~2–10 KB
const MAX_MAILBOX_PER_FP  = Number(process.env.MAX_MAILBOX_PER_FP)  || 50;
const MAX_MAILBOX_FPS     = Number(process.env.MAX_MAILBOX_FPS)     || 1000;
const MAILBOX_TTL_MS      = Number(process.env.MAILBOX_TTL_MS)      || 10 * 60 * 1000;
const MAX_ROOM_PEERS      = Number(process.env.MAX_ROOM_PEERS)      || 16;
const MAX_ID_LEN          = 256;   // room names, fingerprints, peer ids

const app = express();
app.disable('x-powered-by');

// ── Machine checks ─────────────────────────────────────────────────────────────
// /keepalive is for an external uptime service (e.g. UptimeRobot) that requests it about
// every 10 minutes, so Render's free plan doesn't spin the service down after 15 minutes
// without traffic (the next visit would then wait ~1 minute while it starts).
// /health is the platform health check. Both are registered before CORS and every other
// middleware, answer only "ok", touch no rooms or sockets, set no cookies, log nothing,
// and are never cached, so each request really reaches the server.
function probe(_req, res) {
  res.set('Cache-Control', 'no-store');
  res.type('text/plain').send('ok');
}
const PROBE_PATHS = ['/keepalive', '/health'];
for (const p of PROBE_PATHS) app.get(p, probe); // Express answers HEAD from GET routes
app.set('etag', false); // no ETag → no 304 "not modified" short-cut for monitors

// Browser origins allowed to use this server (HTTP CORS and WebSocket handshake).
// Native/non-browser clients send no Origin header and are still allowed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://hungryfaceai.github.io,http://localhost:3000,http://localhost:8000,capacitor://localhost')
  .split(',').map(s => s.trim()).filter(Boolean);
const originAllowed = (origin) => !origin || ALLOWED_ORIGINS.includes(origin);

// Render puts exactly one proxy in front of the app. Trusting only that hop means req.ip is the
// real client address and can't be spoofed with a forged X-Forwarded-For (matters for the
// sign-in attempt limits). Override with TRUST_PROXY_HOPS if the hosting changes.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
const TRUST_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 1);
// Room activity history (Supabase/Postgres). Off unless ACTIVITY_DATABASE_URL is set; never blocks signalling.
const activity = createActivityLog();
// Approximate location of an IP (DB-IP City Lite, looked up locally; only if activity history is on).
const geo = activity.enabled ? createGeoIp() : null;
app.use(cors({
  origin: (origin, cb) => cb(null, originAllowed(origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
  credentials: false
}));

app.get('/', (_req, res) => res.send(`OK (WS at ${WS_PATH})`));

// The old self-hosted analytics (/a/*) has been removed: it stored full visitor IPs and
// exposed them via an unauthenticated stream. Traffic is measured with Umami instead.
app.all(['/a', '/a/*'], (_req, res) => res.sendStatus(410)); // Gone — old clients stop cleanly

// in-memory rooms
const rooms = new Map(); // roomId -> Set<ws>

// NEW: fingerprint routing + mailbox (roomless)
const fpClients = new Map();      // fingerprint -> ws
const mailbox   = new Map();      // fingerprint -> [pending messages]

function deliverFp(toFp, obj) {
  const ws = fpClients.get(toFp);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  // Bounded mailbox: cap per recipient and total recipients, so offline/unknown
  // fingerprints can't be used to fill server memory.
  let q = mailbox.get(toFp);
  if (!q) {
    if (mailbox.size >= MAX_MAILBOX_FPS) {
      const oldest = mailbox.keys().next().value; // Map keeps insertion order
      mailbox.delete(oldest);
    }
    q = [];
    mailbox.set(toFp, q);
  }
  q.push({ at: Date.now(), msg: obj });
  if (q.length > MAX_MAILBOX_PER_FP) q.splice(0, q.length - MAX_MAILBOX_PER_FP);
  return false;
}

// Expire undelivered mailbox entries
setInterval(() => {
  const cutoff = Date.now() - MAILBOX_TTL_MS;
  for (const [fp, q] of mailbox) {
    while (q.length && q[0].at < cutoff) q.shift();
    if (!q.length) mailbox.delete(fp);
  }
}, 60 * 1000).unref();

// Admin sign-in: exchange the password for a short-lived session token.
// Body is tiny JSON; anything larger is refused before the (deliberately slow) password check.
app.post('/admin/login', express.json({ limit: '2kb' }), (req, res) => adminAuth.login(req, res));
app.get('/admin/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ password: adminAuth.passwordEnabled });   // whether the old static key is on is not public
});

// Admin-only roster of active rooms (used by utils/rooms and utils/roster).
app.get('/rooms', (req, res) => {
  if (!adminAuth.enabled) return res.status(404).send('Not found');
  if (!adminAuth.authorized(req)) return res.status(401).send('Unauthorized');
  res.set('Cache-Control', 'no-store');
  const json = Object.create(null);   // a room named "__proto__" must still be listed
  for (const [room, set] of rooms) json[room] = [...set].map(ws => ({ id: ws.id, role: ws.role }));
  res.json(json);
});

// Admin-only room analytics: per room, time with a Camera AND a Viewer connected (from the activity history).
//   GET /admin/analytics/rooms?from=ISO&to=ISO   (default: last 7 days; ?all=1 for all time)
//   GET /admin/analytics/map?from=ISO&to=ISO     approximate locations of Cameras/Viewers (never IPs)
function analyticsRange(q) {
  const to = q.to ? new Date(String(q.to)) : new Date();
  if (q.all === '1') return isNaN(to) ? null : { from: null, to };
  const from = q.from ? new Date(String(q.from)) : new Date(to.getTime() - 7 * 86400_000);
  if (isNaN(from) || isNaN(to) || from >= to || to - from > 400 * 86400_000) return null;
  return { from, to };
}
function analyticsRoute(handler) {
  return async (req, res) => {
    if (!adminAuth.enabled) return res.status(404).send('Not found');
    if (!adminAuth.authorized(req)) return res.status(401).send('Unauthorized');
    res.set('Cache-Control', 'no-store');
    if (!activity.enabled) return res.status(503).json({ error: 'Activity history is not configured on the server.' });
    const range = analyticsRange(req.query);
    if (!range) return res.status(400).json({ error: 'Invalid date range.' });
    try { res.json(await handler(range)); }
    catch (e) { console.log('[activity] analytics failed:', e.message); res.status(503).json({ error: 'Activity history is temporarily unavailable.' }); }
  };
}
app.get('/admin/analytics/rooms', analyticsRoute(range => activity.roomAnalytics(range)));
app.get('/admin/analytics/map', analyticsRoute(async range => ({
  ...(await activity.connectionMap({ ...range, geo })),
  geoReady: !!geo?.ready,
  geoEnabled: !!geo?.enabled,
  attribution: 'IP Geolocation by DB-IP (https://db-ip.com)',
})));

const server = app.listen(PORT, () => {
  console.log(`HTTP :${PORT}  | WS path: ${WS_PATH}`);
});

const wss = new WebSocketServer({
  server,
  path: WS_PATH,
  maxPayload: MAX_MSG_BYTES, // ws default is 100 MB
  // Reject browser connections from other websites (non-browser clients send no Origin)
  verifyClient: ({ origin }) => {
    const ok = originAllowed(origin);
    if (!ok) console.log(`[WS] REJECT origin=${origin}`);
    return ok;
  },
});

function getRoomSet(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}
function roster(roomId) {
  const set = rooms.get(roomId);
  if (!set) return [];
  return [...set].map(s => ({ id: s.id, role: s.role || 'receiver' }));
}
function broadcast(roomId, obj, exclude) {
  const raw = JSON.stringify(obj);
  const set = rooms.get(roomId);
  if (!set) return 0;
  let sent = 0;
  for (const s of set) {
    if (s !== exclude && s.readyState === WebSocket.OPEN) { s.send(raw); sent++; }
  }
  console.log(`[RELAY][broadcast] room=${roomId} type=${obj.type || obj.op} from=${obj.from || '-'} sent=${sent}`);
  return sent;
}
function sendTo(roomId, peerId, obj) {
  const set = rooms.get(roomId);
  if (!set) return false;
  for (const s of set) {
    if (s.id === peerId && s.readyState === WebSocket.OPEN) {
      s.send(JSON.stringify(obj)); 
      console.log(`[RELAY][direct] room=${roomId} type=${obj.type || obj.op} from=${obj.from || '-'} to=${peerId}`);
      return true; 
    }
  }
  return false;
}

wss.on('connection', (ws, req) => {
  ws.id = randomUUID();
  ws.roomId = null;
  ws.role = 'receiver';
  ws.isAlive = true;
  ws.fingerprint = null; // NEW

  ws.ip = clientIp(req, TRUST_HOPS);
  console.log(`[WS] CONNECT id=${ws.id} ip=${req.socket.remoteAddress} url=${req.url}`);

  // say hello with our id
  ws.send(JSON.stringify({ type: 'hello', id: ws.id }));

  ws.on('pong', () => (ws.isAlive = true));
  // e.g. "Max payload size exceeded" — ws closes the socket itself; just log it
  ws.on('error', (e) => console.log(`[WS] ERROR id=${ws.id} ${e?.message || e}`));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
	  
    // Accept both {type: "..."} and {op: "..."} messages
    const t = msg?.type || msg?.op;

    // ===== ROOMLESS FLOW (no join needed) =====
    // 1) Register fingerprint
    if (t === 'register' && typeof msg.fp === 'string' && msg.fp && msg.fp.length <= MAX_ID_LEN) {
      // A fingerprint already held by another live connection can't be taken over (it would steal its messages).
      const holder = fpClients.get(msg.fp);
      if (holder && holder !== ws && holder.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'error', reason: 'fp-in-use' })); } catch {}
        return;
      }
      // One fingerprint per connection: drop the previous one so the map can't grow without bound.
      if (ws.fingerprint && ws.fingerprint !== msg.fp && fpClients.get(ws.fingerprint) === ws) fpClients.delete(ws.fingerprint);
      ws.fingerprint = msg.fp;
      fpClients.set(ws.fingerprint, ws);
      // flush mailbox
      const q = mailbox.get(ws.fingerprint) || [];
      mailbox.delete(ws.fingerprint);
      for (const mm of q) try { ws.send(JSON.stringify(mm.msg)); } catch {}
      console.log(`[REGISTER] fp=${ws.fingerprint} id=${ws.id}`);
      return;
    }
    // 2) Pairing messages (relay by fingerprint)
    //if ((t === 'pair-init' || t === 'pair-ack') && typeof msg.to === 'string') {
	if ((t === 'pair-init' || t === 'pair-ack' || t === 'pair-done') && typeof msg.to === 'string' && msg.to.length <= MAX_ID_LEN) {
      deliverFp(msg.to, msg);
      return;
    }
    // 3) Encrypted signaling relay (by fingerprint)
    if (t === 'relay' && typeof msg.to === 'string' && msg.to.length <= MAX_ID_LEN) {
      deliverFp(msg.to, msg);
      return;
    }
    // (Optional keepalive passthrough)
    if (t === 'keepalive' || t === 'ping' || t === 'pong') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
      return;
    }

    // ===== ROOMED FLOW (legacy / current) =====
    if (t === 'join' && typeof msg.room === 'string') {
      const nextRoom = msg.room.trim();
      const prevRoom = ws.roomId;
      // Control characters (e.g. NUL) are never valid in a room name, and the history database rejects them.
      if (!nextRoom || nextRoom.length > MAX_ID_LEN || /[\u0000-\u001f\u007f]/.test(nextRoom)) return;
      if (nextRoom !== prevRoom && (rooms.get(nextRoom)?.size || 0) >= MAX_ROOM_PEERS) {
        console.log(`[JOIN] REJECT id=${ws.id} room=${nextRoom} (full)`);
        try { ws.send(JSON.stringify({ type: 'error', reason: 'room-full' })); } catch {}
        return;
      }
    
														   
      if (prevRoom && prevRoom !== nextRoom && rooms.has(prevRoom)) {
        activity.leave({ connId: ws.id });
        const prevSet = rooms.get(prevRoom);
        prevSet.delete(ws);
        if (prevSet.size === 0) {
          rooms.delete(prevRoom);
        } else {
          broadcast(prevRoom, { type: 'peer-left', id: ws.id });
          broadcast(prevRoom, { type: 'roster', peers: roster(prevRoom) });
        }
      }
    
      ws.roomId = nextRoom;
      ws.role = (msg.role === 'sender') ? 'sender' : 'receiver';
    
      const alreadyIn = rooms.get(nextRoom)?.has(ws);
      getRoomSet(nextRoom).add(ws);
      if (!alreadyIn) activity.join({ connId: ws.id, room: nextRoom, role: ws.role, ip: ws.ip });
      console.log(`[JOIN] id=${ws.id} role=${ws.role} room=${nextRoom} peers=${rooms.get(nextRoom).size}`);
    
																			
      broadcast(nextRoom, { type: 'peer-joined', id: ws.id, role: ws.role }, ws);
      const r = roster(nextRoom);
      broadcast(nextRoom, { type: 'roster', peers: r }, ws);
      ws.send(JSON.stringify({ type: 'roster', peers: r }));
      return;
    }

    // If a message requires a room and we're not in one, drop it
    if (!ws.roomId) {
      console.log(`[DROP] id=${ws.id} type=${t} (no room; not a roomless op)`);
      return;
    }

    // forward messages; add "from" within a room
    if (['offer','answer','candidate','bye','need-offer','keepalive'].includes(t)) {
      const payload = { ...msg, from: ws.id };
      let sent = 0;
      if (msg.to) sent = sendTo(ws.roomId, msg.to, payload) ? 1 : 0;
      else        sent = broadcast(ws.roomId, payload, ws);
      console.log(`[RELAY] room=${ws.roomId} type=${t} from=${ws.id} to=${msg.to || 'room'} sent=${sent}`);
      return;
    }
  });

  ws.on('close', () => {
    // clean up fingerprint mapping
    if (ws.fingerprint && fpClients.get(ws.fingerprint) === ws) {
      fpClients.delete(ws.fingerprint);
    }

    const { roomId } = ws;
    if (roomId) activity.leave({ connId: ws.id });
    if (roomId && rooms.has(roomId)) {
      const set = rooms.get(roomId);
      set.delete(ws);
      if (set.size === 0) rooms.delete(roomId);
      else {
        broadcast(roomId, { type: 'peer-left', id: ws.id });
        broadcast(roomId, { type: 'roster', peers: roster(roomId) });
      }
      console.log(`[LEAVE] id=${ws.id} room=${roomId} peers=${set.size || 0}`);
    } else {
      console.log(`[LEAVE] id=${ws.id} no-room`);
    }
  });
});

// heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

// Render stops the old instance on every deploy (SIGTERM): close open activity rows with the right time.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`[${sig}] closing activity rows`);
  const t = setTimeout(() => process.exit(0), 8000); t.unref?.();   // never hang a deploy
  try { await activity.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]', e));
