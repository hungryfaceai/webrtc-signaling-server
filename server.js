// server.js — Express + WebSocket signaling with rooms + targeted routing
// Adds fingerprint relay for roomless pairing/signaling.
// Emits: hello(id), roster(peers[{id,role}]), peer-joined/peer-left
// Forwards (rooms): offer/answer/candidate/bye/need-offer (adds {from}; honors {to})
// Forwards (roomless): register(fp, instance), relay({to:fp,...}), pair-init/pair-ack/pair-done

import express from 'express';
import { randomUUID } from 'crypto';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';

const PORT    = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || '/ws';

const app = express();

const ALLOWED_ORIGINS = ['https://hungryfaceai.github.io', 'http://localhost:3000'];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400,
  credentials: false
}));

app.get('/', (_req, res) => res.send(`OK (WS at ${WS_PATH})`));
app.get('/health', (_req, res) => res.send('ok'));

// in-memory rooms
const rooms = new Map(); // roomId -> Set<ws>

// ===== New: fingerprint routing supports MANY sockets per fingerprint =====
/**
 * fpClients: Map<fingerprint, Map<instanceId, ws>>
 * mailbox:   Map<fingerprint, Map<instanceKey, Array<msg>>>
 *   - instanceKey is either a concrete instanceId (targeted) or "__broadcast__" (fanout)
 */
const fpClients = new Map();
const mailbox   = new Map();

function clientsFor(fp) {
  let m = fpClients.get(fp);
  if (!m) { m = new Map(); fpClients.set(fp, m); }
  return m;
}
function mboxFor(fp) {
  let m = mailbox.get(fp);
  if (!m) { m = new Map(); mailbox.set(fp, m); }
  return m;
}

/**
 * Deliver to a fingerprint.
 * Options:
 *  - toInstance: only deliver to that instance (targeting)
 *  - skipInstance: avoid delivering back to the sender instance (echo guard)
 * If no live targets, enqueue into mailbox (per instance if targeted, else broadcast queue).
 */
function deliverFp(toFp, obj, { toInstance = null, skipInstance = null } = {}) {
  const cmap = fpClients.get(toFp);
  let delivered = false;

  if (cmap && cmap.size) {
    for (const [inst, socket] of cmap) {
      if (toInstance && inst !== toInstance) continue;
      if (skipInstance && inst === skipInstance) continue;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(obj));
        console.log(
          `[RELAY][fp] toFp=${toFp} inst=${inst} skip=${skipInstance || '-'} ` +
          `kind=${obj.kind || obj.type || obj.op || 'n/a'}`
        );
        delivered = true;
      }
    }
  }

  if (!delivered) {
    const box = mboxFor(toFp);
    const key = toInstance || '__broadcast__';
    const q = box.get(key) || [];
    q.push(obj);
    box.set(key, q);
    // (Optional) simple cap to avoid unbounded queues:
    if (q.length > 500) {
      q.splice(0, q.length - 500);
    }
  } else {
    console.log(`[DELIVER] fan-out toFp=${toFp} delivered to >=1`);
  }

  return delivered;
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
  ws.instanceId = null;  // NEW

  console.log(`[WS] CONNECT id=${ws.id} ip=${req.socket.remoteAddress} url=${req.url}`);

  // say hello with our id
  ws.send(JSON.stringify({ type: 'hello', id: ws.id }));

  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const t = msg?.type || msg?.op;

    // ===== ROOMLESS FLOW (no join needed) =====

    // 1) Register fingerprint + instance
    if (t === 'register' && typeof msg.fp === 'string') {
      ws.fingerprint = msg.fp;
      ws.instanceId  = (typeof msg.instance === 'string' && msg.instance) ? msg.instance : `inst-${ws.id}`;

      const cmap = clientsFor(ws.fingerprint);
      cmap.set(ws.instanceId, ws);

      // Flush targeted + broadcast mailboxes for this (fp, instance)
      const mbox = mailbox.get(ws.fingerprint);
      if (mbox) {
        const targeted = mbox.get(ws.instanceId) || [];
        const broadcastQ = mbox.get('__broadcast__') || [];
        // Send pending messages to THIS instance (targeted + broadcast)
        for (const mm of targeted)    { try { ws.send(JSON.stringify(mm)); } catch {} }
        for (const mm of broadcastQ)  { try { ws.send(JSON.stringify(mm)); } catch {} }
        // Clear the queues we just consumed to prevent unbounded growth
        mbox.delete(ws.instanceId);
        mbox.delete('__broadcast__');
        if (mbox.size === 0) mailbox.delete(ws.fingerprint);
      }

      console.log(`[REGISTER] fp=${ws.fingerprint} inst=${ws.instanceId} id=${ws.id}`);
      return;
    }

    // 2) Pairing messages (fan-out to all instances of target fp)
    if ((t === 'pair-init' || t === 'pair-ack' || t === 'pair-done') && typeof msg.to === 'string') {
      deliverFp(msg.to, msg); // broadcast to all instances on that fingerprint
      return;
    }

    // 3) Encrypted signaling relay (by fingerprint)
    if (t === 'relay' && typeof msg.to === 'string') {
      // Optional targeting: msg.toInstance
      // Optional echo-avoid: msg.fromInstance
      deliverFp(msg.to, msg, {
        toInstance: msg.toInstance || null,
        skipInstance: msg.fromInstance || null
      });
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
    // clean up fingerprint mapping (per-instance)
    if (ws.fingerprint) {
      const cmap = fpClients.get(ws.fingerprint);
      if (cmap) {
        if (ws.instanceId && cmap.get(ws.instanceId) === ws) {
          cmap.delete(ws.instanceId);
        } else {
          // fallback scan: remove any mapping that equals this ws
          for (const [inst, sock] of cmap) {
            if (sock === ws) cmap.delete(inst);
          }
        }
        if (cmap.size === 0) fpClients.delete(ws.fingerprint);
      }
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
