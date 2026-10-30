// Batcave composer API: sign-in plus a small document store.
// Pure logic, no Netlify imports, so the same code runs in the function and in tests.
//
// createHandler({ data, auth, env, now }) returns async (Request, ctx) => Response
//   data / auth : stores with get(key), set(key, obj), delete(key), list(prefix) -> keys
//   env         : (name) => string | undefined
//   now         : () => ms since epoch (injectable for tests)

const COLLECTIONS = new Set(['issues', 'index', 'defaults', 'settings', 'posts', 'postindex']);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_BODY = 300_000;            // characters; the composer itself stops at 250,000
const MAX_IMPORT = 4_000_000;        // characters for one restore
const SESSION_DAYS = 30;
const MAX_FAILS = 10;                // wrong passcodes allowed per window, per address
const WINDOW_MS = 15 * 60 * 1000;
const COOKIE = 'bcc_session';

const enc = new TextEncoder();

/* ---------- small helpers ---------- */
function json(status, body, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64url(s) {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

// The token is bound to the passcode, so changing the passcode signs everyone out.
async function fingerprint(passcode) {
  return hex(await sha256('bcc-fp:' + passcode)).slice(0, 32);
}
async function makeToken({ passcode, secret }, expSec) {
  const sig = await hmac(secret, `v1.${expSec}.${await fingerprint(passcode)}`);
  return `v1.${expSec}.${b64url(sig)}`;
}
async function tokenOk({ passcode, secret }, token, nowMs) {
  const m = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{20,64})$/.exec(token || '');
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp * 1000 > nowMs)) return false;
  let got;
  try { got = unb64url(m[2]); } catch { return false; }
  const want = await hmac(secret, `v1.${exp}.${await fingerprint(passcode)}`);
  return safeEqual(got, want);
}

function readConfig(env) {
  const passcode = (env('BATCAVE_PASSCODE') || '').trim();
  const secret = (env('BATCAVE_SESSION_SECRET') || '').trim();
  if (passcode.length < 10) { console.error('BATCAVE_PASSCODE is missing or shorter than 10 characters'); return null; }
  if (secret.length < 32) { console.error('BATCAVE_SESSION_SECRET is missing or shorter than 32 characters'); return null; }
  return { passcode, secret };
}

function getCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function cookieHeader(value, maxAge, secure) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    }),
  );
  return out;
}

/* ---------- the handler ---------- */
export function createHandler({ data, auth, env, now = () => Date.now() }) {
  async function listCollection(coll) {
    const keys = await data.list(coll + '/');
    const recs = await mapLimit(keys, 8, (k) => data.get(k));
    const docs = [];
    keys.forEach((k, i) => {
      const r = recs[i];
      if (r && typeof r === 'object') docs.push({ id: k.slice(coll.length + 1), data: r.data, updatedAt: r.updatedAt });
    });
    return docs;
  }

  async function handle(req, ctx = {}) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') return json(404, { error: 'not_found' });
    const route = parts.slice(1);

    const cfg = readConfig(env);
    if (!cfg) return json(503, { error: 'not_configured' });

    const secure = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
    const nowMs = now();

    // Writes must come from this site, as JSON.
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.get('origin');
      if (origin) {
        let ok = false;
        try { ok = new URL(origin).host === url.host; } catch { ok = false; }
        if (!ok) return json(403, { error: 'bad_origin' });
      }
      const sendsBody = method === 'PUT' || method === 'POST' || method === 'PATCH';
      if (sendsBody && route[0] !== 'logout' && !(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
        return json(415, { error: 'json_only' });
      }
    }

    /* --- sign in --- */
    if (route[0] === 'login' && route.length === 1) {
      if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
      const ip = ctx.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
      const tkey = 'throttle/' + hex(await sha256('ip:' + ip)).slice(0, 40);
      let rec = await auth.get(tkey);
      if (rec && nowMs - rec.first > WINDOW_MS) rec = null;
      if (rec && rec.count >= MAX_FAILS) {
        const wait = Math.max(1, Math.ceil((rec.first + WINDOW_MS - nowMs) / 1000));
        return json(429, { error: 'too_many_attempts', retryAfter: wait }, { 'retry-after': String(wait) });
      }
      let body = null;
      try { const t = await req.text(); if (t.length <= 2000) body = JSON.parse(t); } catch { body = null; }
      const given = body && typeof body.passcode === 'string' ? body.passcode.trim() : '';
      const good = given.length > 0 && safeEqual(await sha256(given), await sha256(cfg.passcode));
      if (!good) {
        await auth.set(tkey, { count: (rec ? rec.count : 0) + 1, first: rec ? rec.first : nowMs });
        return json(401, { error: 'wrong_passcode' });
      }
      if (rec) await auth.delete(tkey);
      const exp = Math.floor(nowMs / 1000) + SESSION_DAYS * 86400;
      return json(200, { ok: true }, { 'set-cookie': cookieHeader(await makeToken(cfg, exp), SESSION_DAYS * 86400, secure) });
    }

    if (route[0] === 'logout' && route.length === 1) {
      if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
      return json(200, { ok: true }, { 'set-cookie': cookieHeader('', 0, secure) });
    }

    /* --- everything below needs a session --- */
    if (!(await tokenOk(cfg, getCookie(req, COOKIE), nowMs))) return json(401, { error: 'sign_in_needed' });

    if (route[0] === 'session' && route.length === 1) {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return json(200, { ok: true });
    }

    if (route[0] === 'export' && route.length === 1) {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
      const collections = {};
      for (const c of COLLECTIONS) {
        collections[c] = {};
        for (const d of await listCollection(c)) collections[c][d.id] = d.data;
      }
      const day = new Date(nowMs).toISOString().slice(0, 10);
      return json(200, { exportedAt: new Date(nowMs).toISOString(), collections }, {
        'content-disposition': `attachment; filename="batcave-composer-backup-${day}.json"`,
      });
    }

    if (route[0] === 'import' && route.length === 1) {
      if (method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
      const text = await req.text();
      if (text.length > MAX_IMPORT) return json(413, { error: 'too_large' });
      let body;
      try { body = JSON.parse(text); } catch { return json(400, { error: 'bad_json' }); }
      const cols = body && body.collections;
      if (!cols || typeof cols !== 'object' || Array.isArray(cols)) return json(400, { error: 'not_a_backup' });
      const writes = [];
      for (const [c, docs] of Object.entries(cols)) {
        if (!COLLECTIONS.has(c)) return json(400, { error: 'unknown_collection' });
        if (!docs || typeof docs !== 'object' || Array.isArray(docs)) return json(400, { error: 'not_a_backup' });
        for (const [id, d] of Object.entries(docs)) {
          if (!ID_RE.test(id)) return json(400, { error: 'bad_id' });
          if (!d || typeof d !== 'object' || Array.isArray(d)) return json(400, { error: 'object_only' });
          if (JSON.stringify(d).length > MAX_BODY) return json(413, { error: 'too_large' });
          writes.push([c, id, d]);
        }
      }
      const updatedAt = new Date(nowMs).toISOString();
      await mapLimit(writes, 6, ([c, id, d]) => data.set(`${c}/${id}`, { data: d, updatedAt }));
      return json(200, { ok: true, written: writes.length, issues: writes.filter((w) => w[0] === 'issues').length, posts: writes.filter((w) => w[0] === 'posts').length });
    }

    if (route[0] === 'db' && route.length >= 2 && route.length <= 3) {
      const coll = route[1];
      if (!COLLECTIONS.has(coll)) return json(404, { error: 'unknown_collection' });

      if (route.length === 2) {
        if (method !== 'GET') return json(405, { error: 'method_not_allowed' }, { allow: 'GET' });
        return json(200, { docs: await listCollection(coll) });
      }

      const id = route[2];
      if (!ID_RE.test(id)) return json(400, { error: 'bad_id' });
      const key = `${coll}/${id}`;

      if (method === 'GET') {
        const rec = await data.get(key);
        if (!rec || typeof rec !== 'object') return json(200, { exists: false, data: null });
        return json(200, { exists: true, data: rec.data, updatedAt: rec.updatedAt });
      }
      if (method === 'PUT') {
        const text = await req.text();
        if (text.length > MAX_BODY) return json(413, { error: 'too_large' });
        let doc;
        try { doc = JSON.parse(text); } catch { return json(400, { error: 'bad_json' }); }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return json(400, { error: 'object_only' });
        const updatedAt = new Date(nowMs).toISOString();
        await data.set(key, { data: doc, updatedAt });
        return json(200, { ok: true, updatedAt });
      }
      if (method === 'DELETE') {
        await data.delete(key);
        return json(200, { ok: true });
      }
      return json(405, { error: 'method_not_allowed' }, { allow: 'GET, PUT, DELETE' });
    }

    return json(404, { error: 'not_found' });
  }

  return async (req, ctx) => {
    try {
      return await handle(req, ctx);
    } catch (e) {
      console.error('batcave api error:', e && e.message ? e.message : e);
      return json(500, { error: 'server_error' });
    }
  };
}
