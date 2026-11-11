// The checks you run on yourself. Every line is PASS or FAIL with what was measured.
//
//   npm run check                         everything
//   npm run check -- tools                the tools and the old-client tests
//   npm run check -- image                one image: size, user, health, config, stop
//   npm run check -- change               the change in docs/CHANGE.md, on the image
//   npm run check -- compat               the old and the new image on one database
//   npm run check -- log                  the numbers in load-log.txt
//
//   --old=linkbox:v1  --new=linkbox:v2  --log=load-log.txt     to point it elsewhere
//
// The containers and volumes it starts are its own and are removed afterwards.
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fingerprint, TOOLS, ROOT } from './lib.js';
import { analyse } from './report.js';

const LIMITS = { imageMB: 300, stopMs: 8000, flagMs: 2000 };

const args = process.argv.slice(2);
const opt = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const stages = args.filter((a) => !a.startsWith('--'));
const want = (s) => stages.length === 0 || stages.includes(s);
const OLD = opt('old', 'linkbox:v1');
const NEW = opt('new', 'linkbox:v2');
const LOGFILE = opt('log', 'load-log.txt');

let passed = 0;
let failed = 0;
function report(id, ok, text) {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(3)} ${text}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- docker helpers
const docker = (a, ms = 60_000) => spawnSync('docker', a, { encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL', maxBuffer: 1 << 26 });
const dockerAsync = (a) => new Promise((res) => {
  const p = spawn('docker', a, { stdio: 'ignore' });
  p.on('exit', (code) => res(code));
});
const tag = randomBytes(3).toString('hex');
const containers = new Set();
const volumes = new Set();
let serial = 0;

function newVolume() {
  const v = `linkbox-check-${tag}-${++serial}`;
  docker(['volume', 'create', v]);
  volumes.add(v);
  return v;
}

const ENVS = {
  staging: { APP_ENV: 'staging', DB_PATH: '/data/app.db', BASE_URL: 'https://staging.check.test', ADMIN_TOKEN: 'check-token-staging' },
  production: { APP_ENV: 'production', DB_PATH: '/data/app.db', BASE_URL: 'https://links.check.test', ADMIN_TOKEN: 'check-token-production' },
};
const envArgs = (env) => Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
const mountArgs = (v) => ['--mount', `type=volume,source=${v},target=/data`];

function oneOff(image, volume, env, ...cmd) {
  return docker(['run', '--rm', ...mountArgs(volume), ...envArgs(env), image, ...cmd], 60_000);
}

async function start(image, volume, env = ENVS.staging) {
  const name = `linkbox-check-${tag}-${++serial}`;
  containers.add(name);
  const r = docker(['run', '-d', '--name', name, '-p', '127.0.0.1::3000', '--health-interval=1s', '--health-start-period=0s',
    ...mountArgs(volume), ...envArgs(env), image]);
  if (r.status !== 0) return { name, error: r.stderr.trim().split('\n').at(-1) };
  const port = docker(['port', name, '3000']).stdout.trim().split('\n')[0];
  const base = `http://${port}`;
  for (let i = 0; i < 75; i++) {
    const up = await http(base, '/health', { timeout: 1000 }).then((x) => x.ok).catch(() => false);
    if (up) return { name, base };
    if (docker(['inspect', '-f', '{{.State.Running}}', name]).stdout.trim() !== 'true') break;
    await wait(200);
  }
  const logs = docker(['logs', '--tail', '3', name]);
  return { name, error: `no 200 from /health: ${(logs.stderr || logs.stdout).trim().split('\n').at(-1) ?? ''}` };
}

function remove(c) {
  if (!c) return;
  docker(['rm', '-f', c.name]);
  containers.delete(c.name);
}

function cleanup() {
  for (const c of containers) docker(['rm', '-f', c]);
  for (const v of volumes) docker(['volume', 'rm', '-f', v]);
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// One connection per request, as the router does. A pooled connection that the service closed
// while this script was busy would look like a failure of the service.
const http = (base, path, init = {}) => new Promise((res, rej) => {
  const r = request(base + path, {
    method: init.method ?? 'GET',
    agent: false,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  }, (a) => {
    let text = '';
    a.setEncoding('utf8');
    a.on('data', (c) => { text += c; });
    a.on('end', () => res({ status: a.statusCode, ok: a.statusCode < 300, json: async () => JSON.parse(text) }));
  });
  r.setTimeout(init.timeout ?? 5000, () => r.destroy(new Error(`no answer from ${path}`)));
  r.on('error', rej);
  if (init.body) r.write(init.body);
  r.end();
});
const postLink = (base, body) => http(base, '/links', { method: 'POST', body: JSON.stringify(body) });
const setFlag = (base, on, token = ENVS.staging.ADMIN_TOKEN) => http(base, '/admin/flags/expiry', {
  method: 'PUT', headers: { 'x-admin-token': token }, body: JSON.stringify({ enabled: on }),
});
const flagIs = async (base, on) => (await (await http(base, '/version')).json())?.flags?.expiry === on;

function imageExists(image) {
  if (docker(['image', 'inspect', image]).status === 0) return true;
  report('--', false, `image ${image} not found: build it first, or point at it with --new= / --old=`);
  return false;
}

// ---------------------------------------------------------------- stage: tools
function stageTools() {
  console.log('\n== tools');
  const fp = fingerprint();
  const file = join(TOOLS, 'FINGERPRINT');
  const recorded = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  report('T1', fp === recorded, `tools fingerprint ${fp}: compare it with the value in the rubric (tools/FINGERPRINT says ${recorded || 'nothing'})`);

  const inGit = spawnSync('git', ['rev-parse', '--verify', 'starter'], { cwd: ROOT, encoding: 'utf8' }).status === 0;
  if (!inGit) {
    report('T2', false, 'no git tag `starter`: tag the starter commit before your first change');
  } else {
    const paths = ['tools', 'test/app.test.js'];
    const diff = spawnSync('git', ['diff', '--stat', 'starter', '--', ...paths], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...paths], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    report('T2', !diff && !untracked, !diff && !untracked ? 'tools/ and test/app.test.js are as the starter had them' : `changed since the starter: ${(diff || untracked).split('\n').join('; ')}`);
  }
  const t = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/app.test.js'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  const m = (t.stdout ?? '').match(/# pass (\d+)[\s\S]*?# fail (\d+)/);
  report('T3', t.status === 0, `old-client tests: ${m ? `${m[1]} pass, ${m[2]} fail` : 'did not run'}`);
}

// ---------------------------------------------------------------- stage: image
async function stageImage(image) {
  console.log(`\n== image ${image}`);
  if (!imageExists(image)) return;
  const inspect = JSON.parse(docker(['image', 'inspect', image]).stdout)[0];
  const cfg = inspect.Config;

  const dockerfile = existsSync(join(ROOT, 'Dockerfile')) ? readFileSync(join(ROOT, 'Dockerfile'), 'utf8') : '';
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]);
  const loose = froms.filter((b) => !/:[^:]*\d/.test(b) && !b.includes('@sha256'));
  report('I1', froms.length > 0 && loose.length === 0, `base image pinned to a version: ${froms.join(', ') || 'no FROM found'}`);

  const mb = Math.round(inspect.Size / 1e6);
  report('I2', mb <= LIMITS.imageMB, `image size ${mb} MB (limit ${LIMITS.imageMB})`);

  const user = cfg.User ?? '';
  report('I3', user && user !== 'root' && !/^0(:|$)/.test(user), `runs as a non-root user: USER is ${user || 'not set'}`);

  const envNames = (cfg.Env ?? []).map((e) => e.split('=')[0]).filter((k) => /TOKEN|SECRET|PASSWORD|API_?KEY/i.test(k));
  const history = docker(['history', '--no-trunc', image]).stdout;
  const inHistory = /dev-secret|ADMIN_TOKEN=\S+/.test(history);
  report('I4', envNames.length === 0 && !inHistory, envNames.length || inHistory
    ? `secret baked into the image: ${envNames.join(', ') || 'found in docker history'}`
    : 'no secret in the image config or its history');

  const workdir = cfg.WorkingDir || '/';
  const ls = docker(['run', '--rm', '--entrypoint', 'sh', image, '-c', `ls -A ${workdir}`]);
  if (ls.status !== 0) {
    report('I5', false, `could not list ${workdir} in the image (it needs a shell for this check)`);
  } else {
    const found = ls.stdout.split('\n').filter(Boolean);
    const extra = found.filter((f) => ['.git', '.env', 'env', 'tools', 'test', 'deploy', 'data', 'compose.yaml', 'Dockerfile', 'README.md'].includes(f) || f.endsWith('.txt'));
    report('I5', extra.length === 0, extra.length ? `in the image but not needed to run: ${extra.join(', ')}` : `only what the service needs in ${workdir}: ${found.join(', ')}`);
  }

  const vol = newVolume();
  const mig = oneOff(image, vol, ENVS.staging, 'node', 'src/migrate.js', 'up');
  report('I6', mig.status === 0, mig.status === 0 ? 'migrations run from inside the image, on a fresh volume at /data' : `migration failed: ${(mig.stderr || mig.stdout).trim().split('\n').find((l) => /error/i.test(l)) ?? 'see docker output'}`);

  const staging = await start(image, vol, ENVS.staging);
  if (staging.error) {
    report('I7', false, `does not start with the staging config: ${staging.error}`);
    return;
  }
  const v = await (await http(staging.base, '/version')).json();
  const baked = (cfg.Env ?? []).find((e) => e.startsWith('APP_VERSION='))?.split('=')[1];
  report('I7', baked && v.version === baked && v.version !== 'dev', `version comes from the image: /version says ${v.version}, APP_VERSION says ${baked ?? 'not set'}`);

  const link = await (await postLink(staging.base, { url: 'https://example.com/keep' })).json();
  report('I8', v.env === 'staging' && link.shortUrl?.startsWith(ENVS.staging.BASE_URL), `staging config applied: env=${v.env}, shortUrl=${link.shortUrl}`);

  // Health as Docker sees it.
  let health = '';
  for (let i = 0; i < 20; i++) {
    health = docker(['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', staging.name]).stdout.trim();
    if (health === 'healthy' || health === 'none') break;
    await wait(500);
  }
  report('I9', health === 'healthy', `HEALTHCHECK reports healthy: ${health}`);

  // Stop with a request in flight: the request finishes, the container goes quickly.
  const inflight = http(staging.base, '/__probe/slow?ms=1500', { timeout: 12_000 }).then((r) => r.status).catch(() => null);
  await wait(300);
  const t0 = Date.now();
  await dockerAsync(['stop', staging.name]);
  const ms = Date.now() - t0;
  const status = await inflight;
  report('I10', status === 200 && ms <= LIMITS.stopMs, `docker stop with a request in flight: request got ${status ?? 'no answer'}, stop took ${(ms / 1000).toFixed(1)} s (limit ${LIMITS.stopMs / 1000} s)`);
  remove(staging);

  // Same image, other environment, same volume: the data is still there.
  const prod = await start(image, vol, ENVS.production);
  if (prod.error) {
    report('I11', false, `does not start with the production config: ${prod.error}`);
  } else {
    const pv = await (await http(prod.base, '/version')).json();
    const kept = await http(prod.base, `/links/${link.code}`);
    const keptBody = kept.status === 200 ? await kept.json() : {};
    report('I11', pv.env === 'production' && keptBody.shortUrl?.startsWith(ENVS.production.BASE_URL),
      `same image, production config: env=${pv.env}, shortUrl=${keptBody.shortUrl ?? 'none'}`);
    report('I12', kept.status === 200, `data outlives the container: link created before the replacement answers ${kept.status}`);
    remove(prod);
  }

  // Production refuses to start on a missing or default token.
  for (const [id, env, what] of [
    ['I13', { ...ENVS.production, ADMIN_TOKEN: undefined }, 'no ADMIN_TOKEN'],
    ['I14', { ...ENVS.production, ADMIN_TOKEN: 'dev-secret' }, 'ADMIN_TOKEN=dev-secret'],
  ]) {
    const e = Object.fromEntries(Object.entries(env).filter(([, x]) => x !== undefined));
    const name = `linkbox-check-${tag}-${++serial}`;
    containers.add(name);
    docker(['run', '-d', '--name', name, ...mountArgs(vol), ...envArgs(e), image]);
    let running = 'true';
    for (let i = 0; i < 50 && running === 'true'; i++) {
      await wait(200);
      running = docker(['inspect', '-f', '{{.State.Running}}', name]).stdout.trim();
    }
    const code = docker(['inspect', '-f', '{{.State.ExitCode}}', name]).stdout.trim();
    const out = docker(['logs', name]);
    const said = out.stdout + out.stderr;
    const names = /ADMIN_TOKEN/.test(said);
    const leaks = /dev-secret/.test(said);
    report(id, running === 'false' && code !== '0' && names && !leaks,
      `production with ${what}: ${running === 'false' ? `exits with code ${code}` : 'keeps running after 10 s'}, ${names ? 'names the variable' : 'does not name the variable'}${leaks ? ', and prints the secret' : ''}`);
    remove({ name });
  }

  // Migration and deploy are two steps, in an order you choose. Starting must not migrate.
  const fresh = newVolume();
  const name = `linkbox-check-${tag}-${++serial}`;
  containers.add(name);
  docker(['run', '-d', '--name', name, ...mountArgs(fresh), ...envArgs(ENVS.staging), image]);
  await wait(3000);
  remove({ name });
  const list = oneOff(image, fresh, ENVS.staging, 'node', 'src/migrate.js', 'status');
  const migrated = /\[x\]/.test(list.stdout);
  report('I15', list.status === 0 && !migrated, migrated ? 'starting the container ran the migrations by itself' : 'starting the container does not run migrations');
}

// ---------------------------------------------------------------- stage: change
async function stageChange(image) {
  console.log(`\n== change in docs/CHANGE.md, on ${image}`);
  if (!imageExists(image)) return;
  const vol = newVolume();
  const mig = oneOff(image, vol, ENVS.staging, 'node', 'src/migrate.js', 'up');
  if (mig.status !== 0) { report('F1', false, 'migrations failed, so the change cannot be checked'); return; }
  const a = await start(image, vol);
  const b = await start(image, vol);
  if (a.error || b.error) { report('F1', false, `does not start: ${a.error ?? b.error}`); return; }
  const startedAt = () => docker(['inspect', '-f', '{{.State.StartedAt}}', a.name]).stdout.trim();
  const started = startedAt();

  // Flag off: as if nothing had changed.
  const offCreate = await postLink(a.base, { url: 'https://example.com/off', expiresInSeconds: 1 });
  const off = await offCreate.json().catch(() => ({}));
  const v0 = await (await http(a.base, '/version')).json();
  report('F1', offCreate.status === 201 && off.expiresAt === null && v0.flags?.expiry === false,
    `flag off by default: /version flags.expiry=${v0.flags?.expiry}, POST with expiresInSeconds gives expiresAt=${JSON.stringify(off.expiresAt)}`);

  const denied = await setFlag(a.base, true, 'wrong-token');
  report('F2', denied.status === 401, `PUT /admin/flags/expiry with a wrong token answers ${denied.status}`);

  const on = await setFlag(a.base, true);
  report('F3', on.status === 200, `PUT /admin/flags/expiry with the token from ADMIN_TOKEN answers ${on.status}`);

  // The other instance sees the flip too, with no restart.
  let reached = null;
  const t0 = Date.now();
  while (Date.now() - t0 <= LIMITS.flagMs) {
    if (await flagIs(b.base, true)) { reached = Date.now() - t0; break; }
    await wait(100);
  }
  report('F4', reached !== null, reached !== null ? `flag reaches a second instance on the same database in ${reached} ms` : `second instance still says off after ${LIMITS.flagMs} ms`);

  const invalid = await postLink(a.base, { url: 'https://example.com/x', expiresInSeconds: -1 });
  report('F5', invalid.status === 400, `flag on, expiresInSeconds=-1 answers ${invalid.status}`);

  const onCreate = await postLink(a.base, { url: 'https://example.com/on', expiresInSeconds: 2 });
  const link = await onCreate.json().catch(() => ({}));
  const validDate = typeof link.expiresAt === 'string' && !Number.isNaN(Date.parse(link.expiresAt));
  const beforeExpiry = await http(a.base, `/r/${link.code}`);
  await wait(2500);
  const afterExpiry = await http(b.base, `/r/${link.code}`);
  const afterBody = await afterExpiry.json().catch(() => ({}));
  report('F6', onCreate.status === 201 && validDate && beforeExpiry.status === 302 && afterExpiry.status === 410 && afterBody.error === 'expired',
    `flag on, link with 2 s to live: expiresAt=${link.expiresAt}, ${beforeExpiry.status} before it expires, ${afterExpiry.status} ${afterBody.error ?? ''} after`);

  const offAgain = await setFlag(b.base, false);
  let flipped = false;
  const t1 = Date.now();
  while (Date.now() - t1 <= LIMITS.flagMs && !flipped) {
    flipped = await flagIs(a.base, false);
    if (!flipped) await wait(100);
  }
  const redirected = await http(a.base, `/r/${link.code}`);
  report('F7', offAgain.status === 200 && flipped && redirected.status === 302 && startedAt() === started,
    `flag off again, no restart: the expired link answers ${redirected.status}, the container was ${startedAt() === started ? 'not restarted' : 'restarted'}`);
  remove(a);
  remove(b);
}

// ---------------------------------------------------------------- stage: compat
async function stageCompat(oldImage, newImage) {
  console.log(`\n== compat: ${oldImage} and ${newImage} on one database`);
  if (!imageExists(oldImage) || !imageExists(newImage)) return;
  const vol = newVolume();
  if (oneOff(oldImage, vol, ENVS.staging, 'node', 'src/migrate.js', 'up').status !== 0) {
    report('C1', false, `migrations of ${oldImage} failed`);
    return;
  }
  const o = await start(oldImage, vol);
  if (o.error) { report('C1', false, `${oldImage} does not start: ${o.error}`); return; }
  const fromOld = await (await postLink(o.base, { url: 'https://example.com/from-old' })).json();

  const mig = oneOff(newImage, vol, ENVS.staging, 'node', 'src/migrate.js', 'up');
  if (mig.status !== 0) { report('C1', false, `migrations of ${newImage} failed`); remove(o); return; }
  const stillOk = await postLink(o.base, { url: 'https://example.com/old-after-migration' });
  const stillRead = await http(o.base, `/links/${fromOld.code}`);
  const stillBody = await stillRead.json().catch(() => ({}));
  report('C1', stillOk.status === 201 && stillRead.status === 200 && stillBody.url === 'https://example.com/from-old',
    `${oldImage} on the migrated schema: POST answers ${stillOk.status}, GET answers ${stillRead.status}`);

  const n = await start(newImage, vol);
  if (n.error) { report('C2', false, `${newImage} does not start: ${n.error}`); remove(o); return; }
  await setFlag(n.base, true);
  const created = await postLink(n.base, { url: 'https://example.com/from-new', expiresInSeconds: 3600 });
  const fromNew = await created.json().catch(() => ({}));
  const rOld = await http(o.base, `/r/${fromNew.code}`);
  const lOld = await http(o.base, '/links?limit=5');
  report('C2', created.status === 201 && rOld.status === 302 && lOld.status === 200,
    `${oldImage} reads what ${newImage} wrote with the flag on: redirect ${rOld.status}, list ${lOld.status}`);

  const fromOldOnNew = await http(n.base, `/links/${fromOld.code}`);
  const body = await fromOldOnNew.json().catch(() => ({}));
  const follow = await http(n.base, `/r/${fromOld.code}`);
  report('C3', fromOldOnNew.status === 200 && body.expiresAt === null && follow.status === 302,
    `${newImage} reads a row from before the migration: ${fromOldOnNew.status}, expiresAt=${JSON.stringify(body.expiresAt)}, redirect ${follow.status}`);
  remove(n);

  const down = oneOff(newImage, vol, ENVS.staging, 'node', 'src/migrate.js', 'down');
  const afterDown = await postLink(o.base, { url: 'https://example.com/after-down' });
  const up = oneOff(newImage, vol, ENVS.staging, 'node', 'src/migrate.js', 'up');
  report('C4', down.status === 0 && afterDown.status === 201 && up.status === 0,
    `the migration has a way back: down ${down.status === 0 ? 'ran' : 'failed'}, ${oldImage} then answers ${afterDown.status}, up ${up.status === 0 ? 'ran' : 'failed'}`);
  remove(o);
}

// ---------------------------------------------------------------- stage: log
function stageLog(file) {
  console.log(`\n== log ${file}`);
  const path = resolve(file);
  if (!existsSync(path)) { report('L0', false, `no ${file}: run the release under npm run load first`); return; }
  const { results, numbers } = analyse(readFileSync(path, 'utf8'));
  const fp = fingerprint();
  report('L0', numbers.tools === fp, `the run used these tools: log says ${numbers.tools}, tools/ is ${fp}`);
  for (const r of results) report(r.id, r.ok, r.text);
}

// ---------------------------------------------------------------- main
if (spawnSync('docker', ['version'], { encoding: 'utf8', timeout: 30_000 }).status !== 0 && (want('image') || want('change') || want('compat'))) {
  console.log('Docker is not answering: start it and run this again.');
  process.exit(2);
}
console.log(`tools fingerprint: ${fingerprint()}`);
for (const [stage, run] of [
  ['tools', stageTools],
  ['image', () => stageImage(NEW)],
  ['change', () => stageChange(NEW)],
  ['compat', () => stageCompat(OLD, NEW)],
  ['log', () => stageLog(LOGFILE)],
]) {
  if (!want(stage)) continue;
  try {
    await run();
  } catch (e) {
    report('--', false, `the ${stage} group stopped early: ${e.message}`);
  }
}
cleanup();
console.log(`\nRESULT: ${passed} of ${passed + failed} passed`);
process.exit(failed ? 1 : 0);
