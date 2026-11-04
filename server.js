// server.js — Express + WebSocket signaling with rooms + targeted routing
// Adds fingerprint relay for roomless pairing/signaling.
// Emits: hello(id), roster(peers[{id,role}]), peer-joined/peer-left
// Forwards (rooms): offer/answer/candidate/bye/need-offer (adds {from}; honors {to})
// Forwards (roomless): register(fp), relay({to:fp,...}), pair-init/pair-ack

import express from 'express';
import { WebSocketServer,  WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import cors from 'cors';
import { timingSafeEqual } from 'crypto';

const PORT    = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || '/ws';

// Admin key for /rooms (set ADMIN_KEY in the Render environment). If unset, /rooms is disabled.
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// Abuse limits (overridable via env)
const MAX_MSG_BYTES       = Number(process.env.MAX_MSG_BYTES)       || 64 * 1024; // SDP offers are ~2–10 KB
const MAX_MAILBOX_PER_FP  = Number(process.env.MAX_MAILBOX_PER_FP)  || 50;
const MAX_MAILBOX_FPS     = Number(process.env.MAX_MAILBOX_FPS)     || 1000;
const MAILBOX_TTL_MS      = Number(process.env.MAILBOX_TTL_MS)      || 10 * 60 * 1000;
const MAX_ROOM_PEERS      = Number(process.env.MAX_ROOM_PEERS)      || 16;
const MAX_ID_LEN          = 256;   // room names, fingerprints, peer ids

const app = express();

// Browser origins allowed to use this server (HTTP CORS and WebSocket handshake).
// Native/non-browser clients send no Origin header and are still allowed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://hungryfaceai.github.io,http://localhost:3000,http://localhost:8000,capacitor://localhost')
  .split(',').map(s => s.trim()).filter(Boolean);
const originAllowed = (origin) => !origin || ALLOWED_ORIGINS.includes(origin);

app.set('trust proxy', true);
app.use(cors({
  origin: (origin, cb) => cb(null, originAllowed(origin)),
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
  credentials: false
}));

app.get('/', (_req, res) => res.send(`OK (WS at ${WS_PATH})`));
app.get('/health', (_req, res) => res.send('ok'));

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

function adminAuthorized(req) {
  if (!ADMIN_KEY) return false;
  const h = String(req.headers.authorization || '');
  const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const want = Buffer.from(ADMIN_KEY);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Admin-only roster of active rooms (used by utils/rooms and utils/roster).
app.get('/rooms', (req, res) => {
  if (!ADMIN_KEY) return res.status(404).send('Not found');
  if (!adminAuthorized(req)) return res.status(401).send('Unauthorized');
  res.set('Cache-Control', 'no-store');
  const json = {};
  for (const [room, set] of rooms) json[room] = [...set].map(ws => ({ id: ws.id, role: ws.role }));
  res.json(json);
});

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
    if (t === 'register' && typeof msg.fp === 'string' && msg.fp.length <= MAX_ID_LEN) {
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
      if (!nextRoom || nextRoom.length > MAX_ID_LEN) return;
      if (nextRoom !== prevRoom && (rooms.get(nextRoom)?.size || 0) >= MAX_ROOM_PEERS) {
        console.log(`[JOIN] REJECT id=${ws.id} room=${nextRoom} (full)`);
        try { ws.send(JSON.stringify({ type: 'error', reason: 'room-full' })); } catch {}
        return;
      }
    
														   
      if (prevRoom && prevRoom !== nextRoom && rooms.has(prevRoom)) {
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
    
      getRoomSet(nextRoom).add(ws);
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

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException',  (e) => console.error('[uncaughtException]', e));
