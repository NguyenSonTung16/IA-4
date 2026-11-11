// Steady traffic through the router, for the whole release. Leave it running: its log is
// your evidence. One run, from before the first release to after the last rollback.
//
//   npm run load                 until Ctrl+C
//   DURATION=60 npm run load     for 60 seconds
//
// Counted as failed:
//   error     any 5xx, including the router's 502 when a slot is not there
//   network   the router itself did not answer
//   contract  a wrong status, a missing field, a response with no x-app-version
//   lost      a link we were told exists is gone, points elsewhere, or lost a counted hit
import { writeFileSync, appendFileSync } from 'node:fs';
import { fingerprint } from './lib.js';

const TARGET = process.env.TARGET ?? 'http://127.0.0.1:8080';
const CONTROL = process.env.CONTROL ?? 'http://127.0.0.1:8081';
const LOG = process.env.LOG ?? 'load-log.txt';
const DURATION = Number(process.env.DURATION ?? 0);
const WORKERS = 8;
const PERIOD_MS = 200;       // each worker: one request every 200 ms, 40 requests a second in all
const MAX_DETAILS = 20;      // detail lines per kind of failure; the counters keep counting

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
writeFileSync(LOG, '');
const log = (line) => { console.log(line); appendFileSync(LOG, line + '\n'); };

const totals = { ok: 0, error: 0, network: 0, contract: 0, lost: 0 };
const byVersion = new Map();  // version -> { n, f }, whole run
let tick = new Map();         // version@slot -> { n, f }, this second
const detailsOf = {};

function count(version, slot, failed) {
  for (const [m, key] of [[byVersion, version], [tick, `${version}@${slot}`]]) {
    if (!m.has(key)) m.set(key, { n: 0, f: 0 });
    const e = m.get(key);
    e.n++;
    if (failed) e.f++;
  }
}

function fail(kind, what, r) {
  totals[kind]++;
  count(r?.version ?? 'none', r?.slot ?? 'none', true);
  detailsOf[kind] = (detailsOf[kind] ?? 0) + 1;
  if (detailsOf[kind] <= MAX_DETAILS) {
    log(`T+${secs()} FAIL ${kind} ${what} -> ${r?.status ?? 'no answer'} version=${r?.version ?? 'none'} slot=${r?.slot ?? 'none'}`);
  }
}

function pass(r) {
  totals.ok++;
  count(r.version, r.slot ?? 'none', false);
}

async function call(method, path, body) {
  try {
    const res = await fetch(TARGET + path, {
      method,
      redirect: 'manual',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = undefined; }
    return {
      status: res.status,
      data,
      location: res.headers.get('location'),
      version: res.headers.get('x-app-version') ?? undefined,
      slot: res.headers.get('x-slot') ?? undefined,
    };
  } catch (e) {
    return { network: e.cause?.code ?? e.name };
  }
}

// code -> { url, hits } as last acknowledged to this client
const links = new Map();
const codes = [];
const someCode = () => codes[Math.floor(Math.random() * codes.length)];

// Returns the response if it may be judged further; otherwise records the failure and returns null.
function screen(what, r) {
  if (r.network) { fail('network', `${what} (${r.network})`); return null; }
  if (r.status >= 500) { fail('error', what, r); return null; }
  if (!r.version) { fail('contract', `${what}, no x-app-version`, r); return null; }
  return r;
}

async function createLink() {
  const url = `https://example.com/${Math.random().toString(36).slice(2)}`;
  // One new client in five sends a field v1 does not know about. v1 ignores unknown fields.
  const body = Math.random() < 0.2 ? { url, expiresInSeconds: 2592000 } : { url };
  const r = screen('POST /links', await call('POST', '/links', body));
  if (!r) return;
  if (r.status !== 201 || r.data?.url !== url || typeof r.data?.code !== 'string' || r.data?.hits !== 0 || typeof r.data?.shortUrl !== 'string') {
    return fail('contract', 'POST /links', r);
  }
  links.set(r.data.code, { url, hits: 0 });
  codes.push(r.data.code);
  pass(r);
}

async function readLink() {
  const code = someCode();
  const want = links.get(code);
  const wantHits = want.hits;
  const r = screen(`GET /links/${code}`, await call('GET', `/links/${code}`));
  if (!r) return;
  if (r.status === 404) return fail('lost', `GET /links/${code}, created earlier in this run`, r);
  if (r.status !== 200) return fail('contract', `GET /links/${code}`, r);
  if (r.data?.url !== want.url) return fail('lost', `GET /links/${code}, url is ${r.data?.url}`, r);
  if (!(r.data?.hits >= wantHits)) return fail('lost', `GET /links/${code}, hits ${r.data?.hits}, at least ${wantHits} acknowledged`, r);
  pass(r);
}

async function follow() {
  const code = someCode();
  const want = links.get(code);
  const r = screen(`GET /r/${code}`, await call('GET', `/r/${code}`));
  if (!r) return;
  if (r.status === 404) return fail('lost', `GET /r/${code}, created earlier in this run`, r);
  if (r.status !== 302 || r.location !== want.url) return fail('contract', `GET /r/${code}`, r);
  want.hits++;
  pass(r);
}

async function listPage() {
  const r = screen('GET /links', await call('GET', '/links?limit=20'));
  if (!r) return;
  if (r.status !== 200 || !Array.isArray(r.data)) return fail('contract', 'GET /links', r);
  pass(r);
}

async function once() {
  const roll = Math.random();
  if (roll < 0.25 || !codes.length) return createLink();
  if (roll < 0.75) return readLink();
  if (roll < 0.95) return follow();
  return listPage();
}

// Follow the router, so that every weight change and mark lands in this one log.
let weights = 'unknown';
let marksSeen = -1;      // marks left before this run are not part of its log
let controlDown = false;
async function followRouter() {
  try {
    const res = await fetch(`${CONTROL}/state`, { signal: AbortSignal.timeout(1000) });
    const s = await res.json();
    if (controlDown) { controlDown = false; log(`T+${secs()} ROUTER control port back`); }
    const w = `blue:${s.slots.blue.weight},green:${s.slots.green.weight}`;
    if (marksSeen < 0) { marksSeen = s.marks.length; weights = w; return; }
    if (w !== weights) { weights = w; log(`T+${secs()} WEIGHTS blue=${s.slots.blue.weight} green=${s.slots.green.weight}`); }
    for (; marksSeen < s.marks.length; marksSeen++) log(`T+${secs()} MARK ${s.marks[marksSeen].text}`);
  } catch {
    if (!controlDown) { controlDown = true; log(`T+${secs()} ROUTER control port not answering`); }
  }
}

await followRouter();
if (controlDown) {
  console.error(`the router is not answering on ${CONTROL}: start it first (see README.md)`);
  process.exit(2);
}

log(`=== load start ${new Date().toISOString()} target=${TARGET} tools=${fingerprint()} weights=${weights}`);

let stop = false;
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });
if (DURATION) setTimeout(() => { stop = true; }, DURATION * 1000);

const poll = setInterval(followRouter, 500);
const ticker = setInterval(() => {
  const n = Math.round((Date.now() - t0) / 1000);   // seconds on the clock, even if a tick came late
  const parts = [...tick.entries()].map(([v, e]) => `v[${v}]=${e.n}/${e.f}`).join(' ');
  const total = [...tick.values()].reduce((s, e) => s + e.n, 0);
  const failed = [...tick.values()].reduce((s, e) => s + e.f, 0);
  log(`T+${String(n).padStart(4, '0')} total=${total} fail=${failed} ${parts} weights=${weights}`);
  tick = new Map();
}, 1000);

await Promise.all(Array.from({ length: WORKERS }, async (_, i) => {
  await new Promise((r) => setTimeout(r, (i * PERIOD_MS) / WORKERS));
  while (!stop) {
    const started = Date.now();
    try { await once(); } catch (e) { fail('contract', `client crash: ${e.message}`); }
    const rest = PERIOD_MS - (Date.now() - started);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
  }
}));
clearInterval(ticker);
clearInterval(poll);

const failed = totals.error + totals.network + totals.contract + totals.lost;
log(`FINAL total=${totals.ok + failed} ok=${totals.ok} error=${totals.error} network=${totals.network} contract=${totals.contract} lost=${totals.lost}`);
log(`BY VERSION ${[...byVersion.entries()].map(([v, e]) => `${v}: ${e.n} answered, ${e.f} failed`).join(' | ')}`);
log(`RESULT: ${failed} failed requests. Judge the run with: npm run check -- log`);
