// Shared by release.js and rollback.js: the router's control port and the docker CLI.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CONTROL = 'http://127.0.0.1:8081';
export const SLOTS = ['blue', 'green'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const say = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);

// Every call to the control port is safe to repeat (read the state, set the same weights, add a mark),
// so a connection that the router closed while it sat idle is simply tried again once.
async function control(path, init) {
  let r;
  try {
    r = await fetch(CONTROL + path, init);
  } catch {
    r = await fetch(CONTROL + path, init);
  }
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} answered ${r.status}`);
  return r.json();
}

export const state = () => control('/state');

// Leaves a line in the running load log. Never stops a release if the mark cannot be written.
export const mark = (text) => control('/mark', { method: 'POST', body: text }).catch(() => {});

// Sends `pct` % of the traffic to `slot` and the rest to the other one, then reads /state to confirm.
export async function setTraffic(slot, pct) {
  const other = SLOTS.find((s) => s !== slot);
  const want = { [slot]: pct, [other]: 100 - pct };
  await control('/weights', { method: 'POST', body: JSON.stringify({ blue: want.blue, green: want.green }) });
  const s = await state();
  if (s.slots.blue.weight !== want.blue || s.slots.green.weight !== want.green) {
    throw new Error(`router did not take the weights: blue ${s.slots.blue.weight}, green ${s.slots.green.weight}`);
  }
  return s;
}

// The slot that has the traffic is the one with the larger weight.
export function liveSlot(s) {
  return s.slots.blue.weight >= s.slots.green.weight ? 'blue' : 'green';
}

export function docker(args, env = {}) {
  return spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, timeout: 120_000, killSignal: 'SIGKILL' });
}

// What Docker says about a slot's container: { running, health } with health healthy | starting | unhealthy | none.
export function containerState(slot) {
  const r = docker(['inspect', '-f', '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', `linkbox-${slot}-1`]);
  if (r.status !== 0) return { running: false, health: 'missing' };
  const [running, health] = r.stdout.trim().split(' ');
  return { running: running === 'true', health };
}
