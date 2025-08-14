// server.js — ultra-minimal Express + WebSocket relay with verbose logs
import express from 'express';
import { WebSocketServer } from 'ws';

const PORT    = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || '/ws';

const app = express();
app.get('/', (_req, res) => res.send(`OK (WS at ${WS_PATH})`));
app.get('/health', (_req, res) => res.send('ok'));

// in-memory rooms
const rooms = new Map(); // roomId -> Set<ws>

app.get('/rooms', (_req, res) => {
  const json = {};
  for (const [room, set] of rooms) json[room] = [...set].map(ws => ws.id);
  res.json(json);
});

const server = app.listen(PORT, () => {
  console.log(`HTTP :${PORT}  | WS path: ${WS_PATH}`);
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server, path: WS_PATH });
const uid = () => Math.random().toString(36).slice(2, 9);

wss.on('connection', (ws, req) => {
  ws.id = uid();
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  console.log(`[WS] CONNECT id=${ws.id} ip=${req.socket.remoteAddress} url=${req.url}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const t = msg?.type;

    if (t === 'join' && typeof msg.room === 'string') {
      const roomId = msg.room.trim();
      ws.roomId = roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);
      console.log(`[JOIN] id=${ws.id} room=${roomId} peers=${rooms.get(roomId).size}`);

      // tell the other peers someone arrived (helps client-side retries)
      broadcast(ws, { type: 'peer-joined', room: roomId, ts: Date.now() });
      return;
    }

    if (!ws.roomId) {
      console.log(`[DROP] id=${ws.id} type=${t} (no room yet)`);
      return;
    }

    // relay to all other peers in the same room
    const sent = broadcast(ws, msg);
    console.log(`[RELAY] room=${ws.roomId} type=${t} from=${ws.id} to=${sent}`);
  });

  ws.on('close', () => {
    const { roomId } = ws;
    if (roomId && rooms.has(roomId)) {
      const peers = rooms.get(roomId);
      peers.delete(ws);
      if (peers.size === 0) rooms.delete(roomId);
      else broadcast(ws, { type: 'peer-left', room: roomId, ts: Date.now() });
      console.log(`[LEAVE] id=${ws.id} room=${roomId} peers=${peers.size}`);
    } else {
      console.log(`[LEAVE] id=${ws.id} no-room`);
    }
  });
});

// heartbeat to prune dead sockets (keeps logs tidy)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

function broadcast(sender, obj) {
  const { roomId } = sender;
  if (!roomId || !rooms.has(roomId)) return 0;
  const raw = JSON.stringify(obj);
  let sent = 0;
  for (const peer of rooms.get(roomId)) {
    if (peer !== sender && peer.readyState === peer.OPEN) { peer.send(raw); sent++; }
  }
  return sent;
}

// catch unexpected crashes in logs
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e)  => console.error('[uncaughtException]', e));
