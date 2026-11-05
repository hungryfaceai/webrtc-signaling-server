# Naptio signaling server

WebSocket signaling for Naptio (camera ⇄ viewer). Devices join a room, exchange WebRTC
offers/answers/ICE candidates through this server, then stream directly to each other.
Media never passes through it.

Run locally: `npm install` then `npm start` (listens on `PORT`, default 3000; WebSocket at `/ws`).

## Endpoints

| Path | Purpose |
|---|---|
| `/ws` | WebSocket signaling. Browser connections are accepted only from `ALLOWED_ORIGINS`. |
| `/keepalive` | Uptime-monitor ping (GET or HEAD): answers `ok`. See below. |
| `/health` | Platform health check: answers `ok`. |
| `/admin/login` | POST `{"password": …}` → a session token (8 h). See *Admin password* below. |
| `/rooms` | Admin only: active rooms. Needs `Authorization: Bearer <session token>`; disabled if no admin sign-in is configured. |
| `/a/*` | Retired analytics: `410 Gone`. |

## Settings (environment variables)

| Name | Default | |
|---|---|---|
| `ADMIN_PASSWORD_HASH` | *(unset → no password sign-in)* | scrypt hash of the admin password, made with `node hash-password.js`. |
| `ADMIN_SESSION_HOURS` | 8 | How long an admin sign-in lasts. |
| `ADMIN_SESSION_SECRET` | *(optional)* | Extra secret mixed into session signing. Changing it signs everyone out. |
| `ADMIN_KEY` | *(legacy)* | Old static key, still accepted while set. Delete it once the password works. |
| `TRUST_PROXY_HOPS` | 1 | Proxies in front of the app (Render: 1). Used for the real client IP. |
| `ALLOWED_ORIGINS` | GitHub Pages site, localhost, `capacitor://localhost` | Comma-separated browser origins. |
| `MAX_MSG_BYTES` | 65536 | Largest WebSocket message. |
| `MAX_ROOM_PEERS` | 16 | Devices per room. |
| `MAX_MAILBOX_PER_FP` / `MAX_MAILBOX_FPS` / `MAILBOX_TTL_MS` | 50 / 1000 / 600000 | Limits for messages queued for offline devices. |

## Admin password

The admin tools (`utils/rooms`, `utils/roster`) sign in with a password. Render never stores the
password itself, only a salted **scrypt** hash (OWASP parameters N=2^17, r=8, p=1), which can't be
turned back into the password.

1. On your own computer, in this folder: `node hash-password.js`. Type a password of at least
   12 characters (a passphrase of four or more random words is best) twice. Nothing shows as you type.
2. Copy the printed line that starts with `scrypt$` into Render → this service → **Environment** →
   `ADMIN_PASSWORD_HASH`, and save (Render redeploys).
3. Open the roster page, enter the password, **Sign in**. You stay signed in for 8 hours in that tab.
4. Once that works, delete the old `ADMIN_KEY` variable on Render.

To change the password, repeat steps 1–2; everyone signed in is signed out. Protection: each check
deliberately takes about half a second; after 5 wrong tries an IP address is locked out for 30 s,
doubling up to 15 minutes; at most 30 attempts a minute overall. Failed attempts are logged with the
IP address, never the password.

## Keeping the free service awake

Render's free plan stops the service after about 15 minutes without inbound traffic; the next
request then waits roughly 50–60 seconds while it starts. For a baby monitor that means a
parent opening the app after a quiet spell waits a minute before the camera connects. An
external uptime service can request **`https://signaling-server-f5gu.onrender.com/keepalive`**
about every 10 minutes to keep it running.

* **What it does:** `/keepalive` answers `ok` (GET or HEAD). It runs before every other check,
  so it works from any origin or host; it touches no rooms or sockets, sets no cookie, writes
  nothing to the log, and is never cached (`Cache-Control: no-store`, no ETag), so each ping
  really reaches the server and costs almost nothing.
* **Setting up the monitor** (UptimeRobot, or Better Stack / cron-job.org, all with free plans):
  add an **HTTP(s)** monitor for `https://signaling-server-f5gu.onrender.com/keepalive`, method
  GET or HEAD, interval **10 minutes** (anything under 15 works; UptimeRobot's free plan
  offers 5 minutes as its shortest), expecting status 200. A **Keyword** monitor can also
  check that the body contains `ok`. Most of these services can email you if the server goes
  down, which doubles as an outage alert.
* **Free hours:** Render gives 750 free instance hours a month per workspace. One service kept
  awake uses about 720–744, so this works only if the signaling server is the only free service
  kept awake in the workspace; with a second one awake, the hours run out and Render suspends
  the free services until the next month. Free services can also be restarted by Render at
  any time, so a monitor reduces cold starts but can't guarantee none. For a production baby
  monitor, a paid instance (no spin-down) is the reliable option.
* **Note:** the monitor keeps the server warm; it doesn't keep a room's connections alive.
  Devices already keep their own WebSocket connections open with regular keepalive messages.
