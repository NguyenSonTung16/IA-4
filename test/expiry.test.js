// Tests for the change in docs/CHANGE.md (v2). test/app.test.js stays as the starter had it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { open } from '../src/db.js';
import { createApp } from '../src/app.js';

const DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const sql = (name) => readFileSync(join(DIR, name), 'utf8');
const upFiles = () => readdirSync(DIR).filter((f) => f.endsWith('.up.sql')).sort();
const migrate = (db) => { for (const f of upFiles()) db.exec(sql(f)); };
const config = { version: 'test', env: 'test', baseUrl: 'http://short.test', adminToken: 'test-token' };
const TOKEN = { 'x-admin-token': 'test-token' };

async function boot(db) {
  const server = createApp(db, config);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* redirects have no body */ }
    return { status: res.status, data, location: res.headers.get('location') };
  };
  const flag = (on) => call('PUT', '/admin/flags/expiry', { enabled: on }, TOKEN);
  const close = () => { server.closeAllConnections(); server.close(); };
  return { call, flag, close };
}

const fresh = async () => { const db = open(':memory:'); migrate(db); return { db, ...(await boot(db)) }; };
const expireNow = (db, code) => db.prepare('UPDATE links SET expires_at = ? WHERE code = ?').run(new Date(Date.now() - 1000).toISOString(), code);

test('flag off by default: expiresInSeconds is ignored and expiresAt is null', async () => {
  const { call, close } = await fresh();
  assert.deepEqual((await call('GET', '/version')).data.flags, { expiry: false });
  const made = await call('POST', '/links', { url: 'https://example.com/a', expiresInSeconds: 1 });
  assert.equal(made.status, 201);
  assert.equal(made.data.expiresAt, null);
  assert.equal((await call('GET', `/links/${made.data.code}`)).data.expiresAt, null);
  close();
});

test('PUT /admin/flags/expiry: 401 without the right token, 200 with it', async () => {
  const { call, close } = await fresh();
  assert.equal((await call('PUT', '/admin/flags/expiry', { enabled: true })).status, 401);
  assert.equal((await call('PUT', '/admin/flags/expiry', { enabled: true }, { 'x-admin-token': 'wrong' })).status, 401);
  const ok = await call('PUT', '/admin/flags/expiry', { enabled: true }, TOKEN);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.enabled, true);
  assert.equal((await call('PUT', '/admin/flags/expiry', { enabled: 'yes' }, TOKEN)).status, 400);
  assert.deepEqual((await call('GET', '/version')).data.flags, { expiry: true });
  close();
});

test('flag on: valid and invalid expiresInSeconds', async () => {
  const { call, flag, close } = await fresh();
  await flag(true);
  const timed = await call('POST', '/links', { url: 'https://example.com/t', expiresInSeconds: 3600 });
  assert.equal(timed.status, 201);
  assert.ok(Date.parse(timed.data.expiresAt) > Date.now());
  assert.match(timed.data.expiresAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal((await call('POST', '/links', { url: 'https://example.com/n' })).data.expiresAt, null);
  for (const bad of [-1, 0, 1.5, '10', null, 1e300]) {
    assert.equal((await call('POST', '/links', { url: 'https://example.com/b', expiresInSeconds: bad })).status, 400, `expiresInSeconds ${JSON.stringify(bad)}`);
  }
  close();
});

test('flag on: an expired link answers 410 and does not count the hit; listing still shows it', async () => {
  const { db, call, flag, close } = await fresh();
  await flag(true);
  const { data } = await call('POST', '/links', { url: 'https://example.com/e', expiresInSeconds: 3600 });
  const live = await call('GET', `/r/${data.code}`);
  assert.equal(live.status, 302);
  assert.equal(live.location, 'https://example.com/e');
  expireNow(db, data.code);
  const gone = await call('GET', `/r/${data.code}`);
  assert.equal(gone.status, 410);
  assert.equal(gone.data.error, 'expired');
  const shown = await call('GET', `/links/${data.code}`);
  assert.equal(shown.status, 200);
  assert.equal(shown.data.hits, 1);
  assert.ok(shown.data.expiresAt);
  assert.ok((await call('GET', '/links')).data.some((l) => l.code === data.code && l.expiresAt));
  close();
});

test('flag turned off again: the expired link redirects, no restart', async () => {
  const { db, call, flag, close } = await fresh();
  await flag(true);
  const { data } = await call('POST', '/links', { url: 'https://example.com/o', expiresInSeconds: 3600 });
  expireNow(db, data.code);
  assert.equal((await call('GET', `/r/${data.code}`)).status, 410);
  await flag(false);
  assert.equal((await call('GET', `/r/${data.code}`)).status, 302);
  assert.equal((await call('GET', `/links/${data.code}`)).data.expiresAt, null);
  close();
});

test('a row from before the migration has expiresAt null and never expires', async () => {
  const db = open(':memory:');
  db.exec(sql('001_init.up.sql'));
  db.prepare('INSERT INTO links (code, url) VALUES (?, ?)').run('oldrow11', 'https://example.com/old');
  db.exec(sql('002_expiry.up.sql'));
  const { call, flag, close } = await boot(db);
  await flag(true);
  const row = await call('GET', '/links/oldrow11');
  assert.equal(row.status, 200);
  assert.equal(row.data.expiresAt, null);
  assert.equal((await call('GET', '/r/oldrow11')).status, 302);
  close();
});

test('the flag reaches a second instance on the same database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkbox-'));
  const a = open(join(dir, 'app.db'));
  migrate(a);
  const b = open(join(dir, 'app.db'));
  const one = await boot(a);
  const two = await boot(b);
  assert.deepEqual((await two.call('GET', '/version')).data.flags, { expiry: false });
  await one.flag(true);
  assert.deepEqual((await two.call('GET', '/version')).data.flags, { expiry: true });
  await two.flag(false);
  assert.deepEqual((await one.call('GET', '/version')).data.flags, { expiry: false });
  one.close(); two.close(); a.close(); b.close();
  rmSync(dir, { recursive: true, force: true });
});

test('migration 002 is additive for v1 and has a way back', () => {
  const db = open(':memory:');
  db.exec(sql('001_init.up.sql'));
  const v1 = () => {
    db.prepare('INSERT INTO links (code, url) VALUES (?, ?)').run(`c${Math.random().toString(36).slice(2, 10)}`, 'https://example.com');
    return db.prepare('SELECT code, url, hits FROM links').all().length;
  };
  assert.equal(v1(), 1);
  db.exec(sql('002_expiry.up.sql'));
  assert.equal(v1(), 2);                       // v1's own statements still work on the new schema
  db.exec(sql('002_expiry.down.sql'));
  assert.equal(v1(), 3);                       // and after the way back
  assert.throws(() => db.prepare('SELECT expires_at FROM links'));
  db.exec(sql('002_expiry.up.sql'));           // and it can go forward again
  assert.equal(v1(), 4);
});
