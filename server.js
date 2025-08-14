// server.js — Express + WebSocket signaling for Render
// Serves static files and relays SDP/ICE within a "room".
//
// Endpoints:
//   GET  /            (index helper)
//   GET  /webrtc/...  (serves your sender.html / receiver.html)
//   WS   /ws          (JSON messages: {type:'join',room}, SDP/ICE relayed to peers)
//
// Deploy on Render as a **Web Service** (not Static Site).
// Build:  npm install
// Start:  npm start

import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT    = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || '/ws';
const WEBROOT = path.join(__dirname); // repo root; adjust if needed

// ----- HTTP (Express) -----
const app = express();

// Helpful index
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>HungryFace WebRTC</title>
<style>body{font-family:system-ui;line-height:1.4;padding:24px;background:#000;color:#ddd}</style>
</head><body>
<h1>HungryFace WebRTC</h1>
<ul>
  <li><a href="/webrtc/sender.html?room=baby1">/webrtc/sender.html?room=baby1</a></li>
  <li><a href="/webrtc/receiver.html?room=baby1">/webrtc/receiver.html?room=baby1</a></li>
</ul>
<p>WebSocket endpoint: <code>${WS_PATH}?room=&lt;name&gt;</code></p>
</body></html>`);
});

// Serve your repo files (including /webrtc)
app.use(express.static(WEBROOT));

// Health check for Render
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`HTTP up on :${PORT}`);
});

// ----- WebSocket signaling -----
/**
 * Minimal room relay:
 *  - Client sends: { type: "join", room: "baby1" }
 *  - Server stores socket in that room.
 *  - Any other JSON message is broadcast to everyone else in the same room.
 * Expected messages (from your pages):
 *   offer/answer: full RTCSessionDescription
 *   candidate: { type:'candidate', candidate: RTCIceCandidate }
 */
const rooms = new Map(); // roomId -> Set<ws>

const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // join room
    if (msg?.type === 'join' && typeof msg.room === 'string') {
      const roomId = msg.room.trim();
      ws.roomId = roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      rooms.get(roomId).add(ws);
      // optional: notify others
      broadcast(ws, { type: 'peer-joined', room: roomId, ts: Date.now() });
      return;
    }

    // relay to peers in same room
    if (ws.roomId && rooms.has(ws.roomId)) {
      const peers = rooms.get(ws.roomId);
      for (const peer of peers) {
        if (peer !== ws && peer.readyState === peer.OPEN) {
          peer.send(raw);
        }
      }
    }
  });

  ws.on('close', () => {
    const { roomId } = ws;
    if (roomId && rooms.has(roomId)) {
      const peers = rooms.get(roomId);
      peers.delete(ws);
      if (peers.size === 0) rooms.delete(roomId);
      else broadcast(ws, { type: 'peer-left', room: roomId, ts: Date.now() });
    }
  });
});

// Heartbeat: clean up dead sockets (keeps Render WS happy)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

function broadcast(sender, obj) {
  const { roomId } = sender;
  if (!roomId || !rooms.has(roomId)) return;
  const raw = JSON.stringify(obj);
  for (const peer of rooms.get(roomId)) {
    if (peer !== sender && peer.readyState === peer.OPEN) {
      peer.send(raw);
    }
  }
}
