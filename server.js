// server.js — Express + WebSocket signaling with rooms + targeted routing
// Adds fingerprint relay for roomless pairing/signaling.
// Emits: hello(id), roster(peers[{id,role}]), peer-joined/peer-left
// Forwards (rooms): offer/answer/candidate/bye/need-offer (adds {from}; honors {to})
// Forwards (roomless): register(fp), relay({to:fp,...}), pair-init/pair-ack

import express from 'express';
import { WebSocketServer,  WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import cors from 'cors';
import { mountAnalytics } from './analytics-server.js'; //https://chatgpt.com/c/68e3afbe-a900-8331-9fd1-d728cdd8a2aa

const PORT    = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || '/ws';

const app = express();

const ALLOWED_ORIGINS = ['https://hungryfaceai.github.io', 'http://localhost:3000'];
app.set('trust proxy', true);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
  // allow POST for /a/evt analytics ingest (safe to allow globally)
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400,
  credentials: false
}));

app.get('/', (_req, res) => res.send(`OK (WS at ${WS_PATH})`));
app.get('/health', (_req, res) => res.send('ok'));

// ── Analytics (anonymous usage + active time + IP trunc/hash) ────────────────
// Exposes:
//   POST /a/evt          (ingest)
//   GET  /a              (mini dashboard)
//   GET  /a/summary.json (JSON stats)
//   POST /a/prune        (retention)
mountAnalytics(app, {
  base: '/a',
  ipSalt: process.env.ANALYTICS_IP_SALT,           // set this in env
  keepFullDays: 3650,                                 // exact IP retention - should change to 7 (GDPR)
  keepAllDays: 3650,                                // row retention - should change to 180
  // allow your front-end origin(s) to call /a/* if cross-origin (e.g. GitHub Pages)
  allowedOrigins: ['https://hungryfaceai.github.io', 'http://localhost:3000']
});

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
  const q = mailbox.get(toFp) || [];
  q.push(obj);
  mailbox.set(toFp, q);
  return false;
}

app.options('/rooms', cors());
app.get('/rooms', (_req, res) => {
  const json = {};
  for (const [room, set] of rooms) json[room] = [...set].map(ws => ({ id: ws.id, role: ws.role }));
  res.json(json);
});

const server = app.listen(PORT, () => {
  console.log(`HTTP :${PORT}  | WS path: ${WS_PATH}`);
});

const wss = new WebSocketServer({ server, path: WS_PATH });

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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
	  
    // Accept both {type: "..."} and {op: "..."} messages
    const t = msg?.type || msg?.op;

    // ===== ROOMLESS FLOW (no join needed) =====
    // 1) Register fingerprint
    if (t === 'register' && typeof msg.fp === 'string') {
      ws.fingerprint = msg.fp;
      fpClients.set(ws.fingerprint, ws);
      // flush mailbox
      const q = mailbox.get(ws.fingerprint) || [];
      mailbox.delete(ws.fingerprint);
      for (const mm of q) try { ws.send(JSON.stringify(mm)); } catch {}
      console.log(`[REGISTER] fp=${ws.fingerprint} id=${ws.id}`);
      return;
    }
    // 2) Pairing messages (relay by fingerprint)
    //if ((t === 'pair-init' || t === 'pair-ack') && typeof msg.to === 'string') {
	if ((t === 'pair-init' || t === 'pair-ack' || t === 'pair-done') && typeof msg.to === 'string') {
      deliverFp(msg.to, msg);
      return;
    }
    // 3) Encrypted signaling relay (by fingerprint)
    if (t === 'relay' && typeof msg.to === 'string') {
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
