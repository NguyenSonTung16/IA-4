import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// v2 of the short-link service: v1, plus links that can expire, behind the `expiry` flag.
// The flag lives in the database, so every running instance sees a change at its next request.

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const newCode = () => [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);

export function createApp(db, config) {
  const q = {
    insert: db.prepare('INSERT INTO links (code, url, expires_at) VALUES (?, ?, ?)'),
    get: db.prepare('SELECT code, url, hits, expires_at FROM links WHERE code = ?'),
    list: db.prepare('SELECT code, url, hits, expires_at FROM links ORDER BY id DESC LIMIT ? OFFSET ?'),
    hit: db.prepare('UPDATE links SET hits = hits + 1 WHERE code = ?'),
    ping: db.prepare('SELECT 1'),
    flag: db.prepare('SELECT enabled FROM flags WHERE name = ?'),
    setFlag: db.prepare('INSERT INTO flags (name, enabled) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled'),
  };

  // Read at every request, never cached: a flip reaches every instance at once, and turning the
  // flag off needs no new image and no restart.
  const flagOn = (name) => q.flag.get(name)?.enabled === 1;

  // With the flag off a link never shows an expiry date, even if one was stored while it was on.
  const view = (row, expiry) => ({
    code: row.code,
    url: row.url,
    shortUrl: `${config.baseUrl}/r/${row.code}`,
    hits: row.hits,
    expiresAt: expiry ? (row.expires_at ?? null) : null,
  });

  const isExpired = (row) => row.expires_at != null && Date.parse(row.expires_at) <= Date.now();

  const tokenOk = (given) => {
    const a = Buffer.from(String(given ?? ''));
    const b = Buffer.from(String(config.adminToken ?? ''));
    return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, code, message) => json(res, status, { error: code, message });

  async function handle(req, res) {
    res.setHeader('x-app-version', config.version);
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') {
      q.ping.get();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/version') {
      return json(res, 200, { version: config.version, env: config.env, flags: { expiry: flagOn('expiry') } });
    }
    // tools/check.js uses this to hold a request open during `docker stop`. Leave it in.
    if (req.method === 'GET' && url.pathname === '/__probe/slow') {
      const ms = Math.min(Number(url.searchParams.get('ms') ?? 1000), 5000);
      await new Promise((r) => setTimeout(r, ms));
      return json(res, 200, { waited: ms });
    }

    if (req.method === 'PUT' && parts[0] === 'admin' && parts[1] === 'flags' && parts.length === 3) {
      if (!tokenOk(req.headers['x-admin-token'])) return error(res, 401, 'unauthorized', 'a valid x-admin-token is required');
      if (parts[2] !== 'expiry') return error(res, 404, 'not_found', `no flag ${parts[2]}`);
      const body = await readBody(req);
      if (!body || typeof body.enabled !== 'boolean') return error(res, 400, 'invalid_body', 'enabled (true or false) is required');
      q.setFlag.run('expiry', body.enabled ? 1 : 0);
      return json(res, 200, { flag: 'expiry', enabled: body.enabled });
    }

    if (parts[0] === 'links' && parts.length === 1) {
      if (req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const expiry = flagOn('expiry');
        return json(res, 200, q.list.all(limit, offset).map((row) => view(row, expiry)));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !isUrl(body.url)) return error(res, 400, 'invalid_body', 'url (http or https) is required');
        const expiry = flagOn('expiry');
        let expiresAt = null;
        // With the flag off the field is ignored, as v1 ignores it.
        if (expiry && body.expiresInSeconds !== undefined) {
          const s = body.expiresInSeconds;
          const at = Number.isSafeInteger(s) && s > 0 ? new Date(Date.now() + s * 1000) : null;
          if (!at || Number.isNaN(at.getTime())) {
            return error(res, 400, 'invalid_body', 'expiresInSeconds must be a positive whole number');
          }
          expiresAt = at.toISOString();
        }
        const code = newCode();
        q.insert.run(code, body.url, expiresAt);
        return json(res, 201, view(q.get.get(code), expiry));
      }
    }

    if (req.method === 'GET' && parts[0] === 'links' && parts.length === 2) {
      const row = q.get.get(parts[1]);
      if (!row) return error(res, 404, 'not_found', `no link ${parts[1]}`);
      return json(res, 200, view(row, flagOn('expiry')));
    }

    if (req.method === 'GET' && parts[0] === 'r' && parts.length === 2) {
      const row = q.get.get(parts[1]);
      if (!row) return error(res, 404, 'not_found', `no link ${parts[1]}`);
      if (flagOn('expiry') && isExpired(row)) return json(res, 410, { error: 'expired' });
      q.hit.run(row.code);
      res.writeHead(302, { location: row.url });
      return res.end();
    }

    return error(res, 404, 'not_found', 'no such route');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) error(res, 500, 'internal', e.message);
      else res.end();
    });
  });
  // The prepared statements do not keep the database alive (Node 22.13.1 frees it once nothing else
  // holds it, and every statement then fails with "statement has been finalized"). The app holds
  // it for as long as the server lives, whoever called createApp.
  server.db = db;
  return server;
}
