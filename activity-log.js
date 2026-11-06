// activity-log.js — record room activity (who joined / left which room, and when) in Postgres (Supabase).
//
// One row per "presence": a device connection being in a room, from join to leave.
//   room        full room id the device joined (e.g. "a1b2c3d4e5f6a7b8:baby")
//   role        'sender' (Camera) or 'receiver' (Viewer)
//   conn_id     random id of the WebSocket connection (not a device or person id)
//   ip          client IP address (from Render's X-Forwarded-For, one trusted hop)
//   joined_at / left_at   left_at stays NULL while the device is still in the room
//
// Room analytics (the time a room had at least one Camera AND one Viewer) is worked out from these
// rows by GET /admin/analytics/rooms (see roomAnalytics below).
//
// Enabled only when ACTIVITY_DATABASE_URL (or DATABASE_URL) is set. If the database is unreachable,
// signalling keeps working: writes are queued in memory (bounded) and retried; nothing ever blocks a join.
//
// Env:
//   ACTIVITY_DATABASE_URL  postgres connection string (Supabase "Session pooler" URL recommended)
//   ACTIVITY_RETENTION_DAYS  delete rows older than this (default 395 ≈ 13 months; 0 = keep forever)

import pg from 'pg';
import net from 'node:net';

const { Pool } = pg;

const SCHEMA = `
create table if not exists room_presence (
  id         bigserial primary key,
  room       text        not null,
  role       text        not null check (role in ('sender','receiver')),
  conn_id    text        not null,
  ip         inet,
  joined_at  timestamptz not null default now(),
  left_at    timestamptz,
  server_id  text
);
create index if not exists room_presence_room_joined on room_presence (room, joined_at);
create index if not exists room_presence_open on room_presence (left_at) where left_at is null;
-- Only the server (service connection) reads/writes this table; nothing is exposed to the public API.
alter table room_presence enable row level security;
`;

const MAX_QUEUE = 5000;

/** Client IP: Render adds the real address to X-Forwarded-For; trust exactly `hops` proxies (can't be spoofed). */
export function clientIp(req, hops = 1) {
  const remote = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  // chain = [client, proxy1, ..., remote]; the address `hops` steps back from the remote is trusted
  const chain = [...xff, remote];
  const pick = chain[Math.max(0, chain.length - 1 - hops)] || remote;
  const ip = pick.replace(/^::ffff:/, '');
  return net.isIP(ip) ? ip : null;
}

export function createActivityLog({ url = process.env.ACTIVITY_DATABASE_URL || process.env.DATABASE_URL, serverId = process.env.RENDER_INSTANCE_ID || 'local',
                                    retentionDays = Number(process.env.ACTIVITY_RETENTION_DAYS ?? 395), poolFactory } = {}) {
  if (!url && !poolFactory) {
    console.log('[activity] disabled (no ACTIVITY_DATABASE_URL)');
    const noop = () => {};
    return { enabled: false, join: noop, leave: noop, roomAnalytics: async () => { throw new Error('activity log disabled'); }, close: async () => {} };
  }

  const pool = poolFactory ? poolFactory() : new Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },   // Supabase requires TLS
  });
  pool.on?.('error', e => console.log('[activity] pool error:', e.message));

  let ready = null;           // schema promise
  const open = new Map();     // conn_id -> row id (for the matching "leave")
  const queue = [];           // pending writes when the DB is slow/down
  let flushing = false;

  async function ensureSchema() {
    if (!ready) ready = (async () => {
      await pool.query(SCHEMA);
      // Rows left open by a previous server process (crash/redeploy) can never be closed by it: close them now.
      const r = await pool.query(`update room_presence set left_at = now() where left_at is null and (server_id is distinct from $1)`, [serverId]);
      if (r.rowCount) console.log(`[activity] closed ${r.rowCount} stale presence row(s) from a previous run`);
      console.log('[activity] ready');
    })().catch(e => { ready = null; throw e; });
    return ready;
  }

  function enqueue(job) {
    if (queue.length >= MAX_QUEUE) { queue.shift(); console.log('[activity] queue full, dropped oldest event'); }
    queue.push(job);
    flush();
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length) {
        try { await ensureSchema(); await queue[0](); queue.shift(); }
        catch (e) { console.log('[activity] write failed, will retry:', e.message); await new Promise(r => setTimeout(r, 5000)); }
      }
    } finally { flushing = false; }
  }

  function join({ connId, room, role, ip }) {
    const at = new Date();
    enqueue(async () => {
      const r = await pool.query(
        `insert into room_presence (room, role, conn_id, ip, joined_at, server_id) values ($1,$2,$3,$4,$5,$6) returning id`,
        [room, role === 'sender' ? 'sender' : 'receiver', connId, ip || null, at, serverId]);
      open.set(connId, r.rows[0].id);
    });
  }
  function leave({ connId }) {
    const at = new Date();
    enqueue(async () => {
      const id = open.get(connId);
      if (id == null) return;
      await pool.query(`update room_presence set left_at = $2 where id = $1 and left_at is null`, [id, at]);
      open.delete(connId);
    });
  }

  // Daily clean-up of old rows (retention).
  let pruneTimer = null;
  if (retentionDays > 0) {
    const prune = () => enqueue(async () => {
      const r = await pool.query(`delete from room_presence where coalesce(left_at, joined_at) < now() - make_interval(days => $1)`, [retentionDays]);
      if (r.rowCount) console.log(`[activity] pruned ${r.rowCount} row(s) older than ${retentionDays} days`);
    });
    setTimeout(prune, 60_000).unref?.();
    pruneTimer = setInterval(prune, 24 * 3600_000); pruneTimer.unref?.();
  }

  /**
   * Room analytics for [from, to): for every room, the periods during which at least one Camera and at least
   * one Viewer were present at the same time ("sessions"). A sweep over join/leave events, all in SQL.
   * Returns { from, to, rooms: [{ room, sessions, totalSeconds, avgSeconds, longestSeconds, lastActive, activeNow }] }.
   */
  async function roomAnalytics({ from, to }) {
    await ensureSchema();
    const sql = `
      with p as (                                   -- presence clipped to the window
        select room, role,
               greatest(joined_at, $1::timestamptz)                 as s,
               least(coalesce(left_at, now()), $2::timestamptz)      as e
        from room_presence
        where joined_at < $2 and coalesce(left_at, now()) > $1
      ),
      ev as (                                       -- +1 / -1 per role at each join / leave
        select room, s as t, case role when 'sender' then 1 else 0 end as ds, case role when 'receiver' then 1 else 0 end as dr from p where e > s
        union all
        select room, e, case role when 'sender' then -1 else 0 end,           case role when 'receiver' then -1 else 0 end from p where e > s
      ),
      steps as (                                    -- running counts after each instant
        select room, t, sum(sum(ds)) over w as senders, sum(sum(dr)) over w as receivers
        from ev group by room, t
        window w as (partition by room order by t)
      ),
      seg as (                                      -- constant-state segments [t, next_t)
        select room, t, lead(t) over (partition by room order by t) as next_t, senders > 0 and receivers > 0 as active from steps
      ),
      grp as (                                      -- merge consecutive active segments into sessions
        select *, sum(case when active then 0 else 1 end) over (partition by room order by t) as g from seg where next_t is not null
      ),
      sessions as (
        select room, min(t) as started, max(next_t) as ended from grp where active group by room, g
      )
      select room,
             count(*)::int                                            as sessions,
             coalesce(sum(extract(epoch from ended - started)), 0)::float8 as total_s,
             coalesce(max(extract(epoch from ended - started)), 0)::float8 as longest_s,
             max(ended)                                               as last_active
      from sessions group by room order by total_s desc`;
    const r = await pool.query(sql, [from, to]);
    // Rooms with a Camera and a Viewer right now (open rows only)
    const live = await pool.query(`
      select room from room_presence where left_at is null
      group by room having bool_or(role = 'sender') and bool_or(role = 'receiver')`);
    const activeNow = new Set(live.rows.map(x => x.room));
    return {
      from: new Date(from).toISOString(), to: new Date(to).toISOString(),
      rooms: r.rows.map(x => ({
        room: x.room, sessions: x.sessions, totalSeconds: Math.round(x.total_s),
        avgSeconds: x.sessions ? Math.round(x.total_s / x.sessions) : 0, longestSeconds: Math.round(x.longest_s),
        lastActive: x.last_active ? new Date(x.last_active).toISOString() : null, activeNow: activeNow.has(x.room),
      })),
    };
  }

  /** Close everything this process has open (graceful shutdown). */
  async function close() {
    clearInterval(pruneTimer);
    try { await ensureSchema(); await pool.query(`update room_presence set left_at = now() where left_at is null and server_id = $1`, [serverId]); } catch {}
    try { await pool.end(); } catch {}
  }

  ensureSchema().catch(e => console.log('[activity] database not reachable yet:', e.message));
  return { enabled: true, join, leave, roomAnalytics, close, _pool: pool, _flushed: async () => { while (queue.length || flushing) await new Promise(r => setTimeout(r, 20)); } };
}
