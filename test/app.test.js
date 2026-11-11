// What old clients rely on. Add your own tests in new files; leave this one as it is.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { open } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base;

before(async () => {
  const db = open(':memory:');
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.up.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  server = createApp(db, { version: 'test', env: 'test', baseUrl: 'http://short.test', adminToken: 'test-token' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (body) => fetch(`${base}/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('POST /links creates a link', async () => {
  const r = await post({ url: 'https://example.com/a' });
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.equal(d.url, 'https://example.com/a');
  assert.equal(d.hits, 0);
  assert.equal(d.shortUrl, `http://short.test/r/${d.code}`);
});

test('POST /links rejects a body with no usable url', async () => {
  assert.equal((await post({ url: 'not a url' })).status, 400);
  assert.equal((await post({})).status, 400);
});

test('an unknown field in the body is ignored', async () => {
  assert.equal((await post({ url: 'https://example.com/b', somethingNew: 1 })).status, 201);
});

test('GET /r/:code redirects and counts the hit', async () => {
  const d = await (await post({ url: 'https://example.com/c' })).json();
  const r = await fetch(`${base}/r/${d.code}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://example.com/c');
  assert.equal((await (await fetch(`${base}/links/${d.code}`)).json()).hits, 1);
});

test('unknown codes are 404', async () => {
  assert.equal((await fetch(`${base}/links/nope`)).status, 404);
  assert.equal((await fetch(`${base}/r/nope`, { redirect: 'manual' })).status, 404);
});

test('every response names the version that answered', async () => {
  assert.equal((await fetch(`${base}/health`)).headers.get('x-app-version'), 'test');
  assert.equal((await fetch(`${base}/nope`)).headers.get('x-app-version'), 'test');
});
