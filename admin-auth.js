// admin-auth.js — password sign-in for the admin tools (utils/rooms, utils/roster).
//
// How it works
//  * The password is never stored. Render holds only ADMIN_PASSWORD_HASH: a salted scrypt hash
//    (memory-hard, OWASP-recommended parameters) produced on your own computer by
//    `node hash-password.js`. A hash can't be turned back into the password.
//  * POST /admin/login {password} → checks it against the hash in constant time and returns a
//    short-lived session token (HMAC-SHA256 signed, 8 h by default). The browser keeps the token
//    for the tab only and sends it as "Authorization: Bearer <token>".
//  * Brute force: failed attempts are limited per client IP (and globally), with a growing
//    lockout; every check costs a full scrypt run, so guessing is slow.
//  * Changing ADMIN_PASSWORD_HASH (or ADMIN_SESSION_SECRET) on Render signs everyone out.
//
// Hash format (all base64url):  scrypt$N$r$p$<salt>$<hash>

import { scrypt as _scrypt, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';

// OWASP Password Storage Cheat Sheet: scrypt N=2^17, r=8, p=1 (≈128 MiB, a few hundred ms).
export const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keyLen: 32 };
const MAXMEM = 256 * 1024 * 1024;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

function scrypt(password, salt, { N, r, p, keyLen }) {
  return new Promise((resolve, reject) =>
    _scrypt(password, salt, keyLen, { N, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Create a storable hash for a password (used by hash-password.js). */
export async function hashPassword(password, params = SCRYPT) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Password must be at least 12 characters.');
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, params);
  return ['scrypt', params.N, params.r, params.p, b64u(salt), b64u(key)].join('$');
}

/** Parse and sanity-check a stored hash. Returns null if it isn't one of ours. */
export function parseHash(stored) {
  const parts = String(stored || '').trim().split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, N, r, p, salt, key] = parts;
  const params = { N: Number(N), r: Number(r), p: Number(p), keyLen: unb64u(key).length };
  const okPow2 = Number.isInteger(params.N) && params.N >= 2 ** 14 && (params.N & (params.N - 1)) === 0;
  if (!okPow2 || !(params.r >= 1 && params.r <= 32) || !(params.p >= 1 && params.p <= 16)) return null;
  if (unb64u(salt).length < 16 || params.keyLen < 16) return null;
  return { params, salt: unb64u(salt), key: unb64u(key) };
}

/** Constant-time password check against a parsed hash. */
export async function verifyPassword(password, parsed) {
  if (!parsed || typeof password !== 'string' || password.length === 0 || password.length > 1024) return false;
  const key = await scrypt(password.normalize('NFKC'), parsed.salt, parsed.params);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

/**
 * Build the admin auth service from the environment.
 *   ADMIN_PASSWORD_HASH   required to enable password sign-in
 *   ADMIN_SESSION_SECRET  optional; signs session tokens (else derived from the hash)
 *   ADMIN_SESSION_HOURS   optional; default 8
 *   ADMIN_KEY             optional legacy static key (kept so nothing breaks while switching)
 */
export function createAdminAuth(env = process.env, { now = () => Date.now(), log = console } = {}) {
  const parsed = parseHash(env.ADMIN_PASSWORD_HASH);
  if (env.ADMIN_PASSWORD_HASH && !parsed) log.warn('[admin] ADMIN_PASSWORD_HASH is set but invalid — password sign-in disabled');
  const legacyKey = env.ADMIN_KEY || '';
  const sessionMs = Math.max(5, Number(env.ADMIN_SESSION_HOURS) || 8) * 3600 * 1000;
  // Token signing key. Including the password hash means changing the password signs everyone out.
  const secret = createHash('sha256')
    .update('naptio-admin-session-v1|' + (env.ADMIN_SESSION_SECRET || '') + '|' + (env.ADMIN_PASSWORD_HASH || ''))
    .digest();

  const enabled = !!parsed || !!legacyKey;

  // ---- sessions (stateless, signed) ----
  function issueToken() {
    const payload = b64u(JSON.stringify({ v: 1, exp: now() + sessionMs, n: b64u(randomBytes(9)) }));
    const sig = b64u(createHmac('sha256', secret).update(payload).digest());
    return { token: `${payload}.${sig}`, expiresAt: new Date(now() + sessionMs).toISOString() };
  }
  function tokenValid(token) {
    const [payload, sig, extra] = String(token || '').split('.');
    if (!payload || !sig || extra !== undefined) return false;
    const want = createHmac('sha256', secret).update(payload).digest();
    const got = unb64u(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
    try { const { v, exp } = JSON.parse(unb64u(payload).toString('utf8')); return v === 1 && Number(exp) > now(); }
    catch { return false; }
  }
  function legacyKeyValid(value) {
    if (!legacyKey) return false;
    const got = Buffer.from(String(value)), want = Buffer.from(legacyKey);
    return got.length === want.length && timingSafeEqual(got, want);
  }
  /** True if the request carries a valid session token (or, during the switch-over, the old key). */
  function authorized(req) {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) return false;
    const v = h.slice(7).trim();
    return (parsed && tokenValid(v)) || legacyKeyValid(v);
  }

  // ---- brute-force limiting ----
  const PER_IP_FREE = 5;          // free attempts before lockouts start
  const GLOBAL_PER_MIN = 30;      // all clients together
  const failures = new Map();     // ip -> { count, lockedUntil, last }
  let globalWindow = { start: now(), count: 0 };
  function lockedFor(ip) {
    const f = failures.get(ip);
    return f && f.lockedUntil > now() ? Math.ceil((f.lockedUntil - now()) / 1000) : 0;
  }
  function recordFailure(ip) {
    const f = failures.get(ip) || { count: 0, lockedUntil: 0, last: 0 };
    f.count += 1; f.last = now();
    if (f.count >= PER_IP_FREE) f.lockedUntil = now() + Math.min(15 * 60, 2 ** (f.count - PER_IP_FREE) * 30) * 1000;
    failures.set(ip, f);
    if (failures.size > 10000) failures.delete(failures.keys().next().value);
  }
  function globalAllowed() {
    if (now() - globalWindow.start > 60000) globalWindow = { start: now(), count: 0 };
    return ++globalWindow.count <= GLOBAL_PER_MIN;
  }
  setInterval(() => { const cut = now() - 3600 * 1000; for (const [ip, f] of failures) if (f.last < cut && f.lockedUntil < now()) failures.delete(ip); }, 600000).unref?.();

  /** Express handler for POST /admin/login */
  async function login(req, res) {
    res.set('Cache-Control', 'no-store');
    if (!parsed) return res.status(404).json({ error: 'Password sign-in is not configured.' });
    const ip = req.ip || 'unknown';
    const wait = lockedFor(ip);
    if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: `Too many attempts. Try again in ${wait} s.` }); }
    if (!globalAllowed()) { res.set('Retry-After', '60'); return res.status(429).json({ error: 'Too many sign-in attempts. Try again in a minute.' }); }
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    let ok = false;
    try { ok = await verifyPassword(password, parsed); } catch (e) { log.warn('[admin] verify error', e?.message || e); }
    if (!ok) {
      recordFailure(ip);
      log.log(`[admin] sign-in FAILED ip=${ip}`);           // never log the password
      return res.status(401).json({ error: 'Wrong password.' });
    }
    failures.delete(ip);
    log.log(`[admin] sign-in ok ip=${ip}`);
    return res.json(issueToken());
  }

  return { enabled, passwordEnabled: !!parsed, legacyEnabled: !!legacyKey, authorized, login, issueToken, tokenValid };
}
