// server.js — minimal WebRTC signaling relay

import express from 'express';
import { WebSocketServer } from 'ws';

const PORT    = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || '/ws';

const app = express();

// Health check
app.get('/health', (_req, res) => res.status(200).send('ok'));

const server = app.listen(PORT, () => {
  console.log(`HTTP :${PORT}  | WS path: ${WS_PATH}`);
});

// ---- WebSocket signaling (room-based broadcast) ----
const wss = new WebSocketServer({ server, path: WS_PATH });
const rooms = new Map(); // roomId -> Set<ws>

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // First message from a client should be: { type: "join", room: "baby1" }
    if (msg?.type === 'join' && typeof msg.room === 'string') {
      const room = msg.room.trim();
      ws.room = room;
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws);

      ws.on('close', () => {
        const set = rooms.get(room);
        if (!set) return;
        set.delete(ws);
        if (set.size === 0) rooms.delete(room);
      });
      return;
    }

    // Relay any other JSON to everyone else in the same room
    const peers = rooms.get(ws.room);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== ws && peer.readyState === peer.OPEN) {
        peer.send(raw);
      }
    }
  });

  // optional: keep connections fresh on some hosts
  ws.on('pong', () => {});
});
setInterval(() => {
  for (const ws of wss.clients) { try { ws.ping(); } catch {} }
}, 30000);
