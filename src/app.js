import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

// v1 of the short-link service.

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
    insert: db.prepare('INSERT INTO links (code, url) VALUES (?, ?)'),
    get: db.prepare('SELECT code, url, hits FROM links WHERE code = ?'),
    list: db.prepare('SELECT code, url, hits FROM links ORDER BY id DESC LIMIT ? OFFSET ?'),
    hit: db.prepare('UPDATE links SET hits = hits + 1 WHERE code = ?'),
    ping: db.prepare('SELECT 1'),
  };

  const view = (row) => ({
    code: row.code,
    url: row.url,
    shortUrl: `${config.baseUrl}/r/${row.code}`,
    hits: row.hits,
  });

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
      return json(res, 200, { version: config.version, env: config.env });
    }
    // tools/check.js uses this to hold a request open during `docker stop`. Leave it in.
    if (req.method === 'GET' && url.pathname === '/__probe/slow') {
      const ms = Math.min(Number(url.searchParams.get('ms') ?? 1000), 5000);
      await new Promise((r) => setTimeout(r, ms));
      return json(res, 200, { waited: ms });
    }

    if (parts[0] === 'links' && parts.length === 1) {
      if (req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return json(res, 200, q.list.all(limit, offset).map(view));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !isUrl(body.url)) return error(res, 400, 'invalid_body', 'url (http or https) is required');
        const code = newCode();
        q.insert.run(code, body.url);
        return json(res, 201, view(q.get.get(code)));
      }
    }

    if (req.method === 'GET' && parts[0] === 'links' && parts.length === 2) {
      const row = q.get.get(parts[1]);
      if (!row) return error(res, 404, 'not_found', `no link ${parts[1]}`);
      return json(res, 200, view(row));
    }

    if (req.method === 'GET' && parts[0] === 'r' && parts.length === 2) {
      const row = q.get.get(parts[1]);
      if (!row) return error(res, 404, 'not_found', `no link ${parts[1]}`);
      q.hit.run(row.code);
      res.writeHead(302, { location: row.url });
      return res.end();
    }

    return error(res, 404, 'not_found', 'no such route');
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) error(res, 500, 'internal', e.message);
      else res.end();
    });
  });
}
