// server.js — Express + WebSocket signaling with rooms + targeted routing
// Emits: hello(id), roster(peers[{id,role}]), peer-joined/peer-left
// Forwards: offer/answer/candidate/bye/need-offer (adds {from}; honors {to})

import express from 'express';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import cors from 'cors';

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

app.options('/rooms', cors()); // handle preflight (safe even if not strictly needed)
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
    if (s !== exclude && s.readyState === s.OPEN) { s.send(raw); sent++; }
  }
  console.log(`[RELAY][broadcast] room=${roomId} type=${obj.type} from=${obj.from || '-'} sent=${sent}`);
  return sent;
}
function sendTo(roomId, peerId, obj) {
  const set = rooms.get(roomId);
  if (!set) return false;
  for (const s of set) {
    if (s.id === peerId && s.readyState === s.OPEN) { 
      s.send(JSON.stringify(obj)); 
      console.log(`[RELAY][direct] room=${roomId} type=${obj.type} from=${obj.from || '-'} to=${peerId}`);
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

  console.log(`[WS] CONNECT id=${ws.id} ip=${req.socket.remoteAddress} url=${req.url}`);

  // say hello with our id
  ws.send(JSON.stringify({ type: 'hello', id: ws.id }));

  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const t = msg?.type;
    /*
    if (t === 'join' && typeof msg.room === 'string') {
      const roomId = msg.room.trim();
      ws.roomId = roomId;
      ws.role = (msg.role === 'sender') ? 'sender' : 'receiver';

      getRoomSet(roomId).add(ws);
      console.log(`[JOIN] id=${ws.id} role=${ws.role} room=${roomId} peers=${rooms.get(roomId).size}`);

      // notify everyone + send rosters
      broadcast(roomId, { type: 'peer-joined', id: ws.id, role: ws.role }, ws);
      const r = roster(roomId);
      broadcast(roomId, { type: 'roster', peers: r });
      ws.send(JSON.stringify({ type: 'roster', peers: r }));
      return;
    }
    */
    if (t === 'join' && typeof msg.room === 'string') {
      const nextRoom = msg.room.trim();
      const prevRoom = ws.roomId;
    
      // If switching rooms, leave the previous one cleanly
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
    
      // Tell others in the new room, and send the roster once to the joiner
      broadcast(nextRoom, { type: 'peer-joined', id: ws.id, role: ws.role }, ws);
      const r = roster(nextRoom);
      broadcast(nextRoom, { type: 'roster', peers: r }, ws);   // exclude joiner to avoid duplicate
      ws.send(JSON.stringify({ type: 'roster', peers: r }));
      return;
    }

    if (!ws.roomId) {
      console.log(`[DROP] id=${ws.id} type=${t} (no room yet)`);
      return;
    }

    // forward messages; add "from"
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
