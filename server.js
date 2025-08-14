// server.js — tiny Express + WS relay with logs
import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT    = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || '/ws';

const app = express();

// optional index for sanity
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8">
  <style>body{font:14px system-ui;background:#000;color:#ddd;padding:24px}</style>
  <h1>Signaling up</h1>
  <p>WS: <code>${WS_PATH}?room=&lt;name&gt;</code></p>`);
});

// health for Render
app.get('/health', (_req, res) => res.status(200).send('ok'));

// start http
const server = app.listen(PORT, () => console.log(`HTTP :${PORT}`));

// ---- WS ----
const rooms = new Map(); // roomId -> Set<ws>
const wss = new WebSocketServer({ server, path: WS_PATH });

const uid = () => Math.random().toString(36).slice(2, 9);

wss.on('connection', (ws, req) => {
  ws.id = uid();
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  console.log(`[WS] connect id=${ws.id} ip=${req.socket.remoteAddress}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const t = msg?.type;

    if (t === 'join' && typeof msg.room === 'string') {
      const roomId = msg.room.trim();
      ws.roomId = roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);
      const peers = rooms.get(roomId).size;
      console.log(`[JOIN] id=${ws.id} room=${roomId} peers=${peers}`);

      // notify others (helps clients know someone arrived)
      broadcast(ws, { type: 'peer-joined', room: roomId, ts: Date.now() });
      return;
    }

    if (!ws.roomId) {
      console.log(`[DROP] id=${ws.id} type=${t} (no room yet)`);
      return;
    }

    // relay to others in same room
    const peers = rooms.get(ws.roomId) || new Set();
    let sent = 0;
    for (const peer of peers) {
      if (peer !== ws && peer.readyState === peer.OPEN) {
        peer.send(raw);
        sent++;
      }
    }
    // msg.type may be "offer" / "answer" / "candidate" / "need-offer" etc.
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

// heartbeat (keeps connections tidy)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

function broadcast(sender, obj) {
  const roomId = sender.roomId;
  if (!roomId || !rooms.has(roomId)) return;
  const raw = JSON.stringify(obj);
  let sent = 0;
  for (const peer of rooms.get(roomId)) {
    if (peer !== sender && peer.readyState === peer.OPEN) { peer.send(raw); sent++; }
  }
  console.log(`[BCAST] room=${roomId} type=${obj.type} from=${sender.id} to=${sent}`);
}
