// npm run release -- <tag>
//
// Puts image linkbox:<tag> in the idle slot, waits until Docker says it is healthy, then moves
// traffic in stages while it reads the router's counters. When the new slot fails more than the
// limit below, it sends everything back to the old slot by itself and exits 1.
// The old slot is left running: it is the way back (npm run rollback).
import { setTimeout as sleepFor } from 'node:timers/promises';
import { SLOTS, say, mark, state, setTraffic, liveSlot, docker, containerState } from './lib.js';

// ---- the stages: percent of traffic to the new slot, and how long to watch it there ----
const STAGES = [
  { pct: 10, secs: 15 },   // the canary: well under 25%, long enough to see a fault at ~40 requests a second
  { pct: 50, secs: 15 },
  { pct: 100, secs: 10 },  // all traffic; the gate keeps watching for 10 s before the release is called done
];

// ---- the gate: the new slot is failing when, since the release began, it has ----
const MAX_ERRORS = 3;       // 3 or more 5xx or unreachable answers, or
const MAX_RATE = 0.02;      // more than 2% of its requests, once it has had
const MIN_REQUESTS = 50;    // at least 50 of them
const POLL_MS = 500;        // how often the counters are read
const HEALTHY_WITHIN_S = 90;

const tag = process.argv[2];
if (!tag) {
  console.error('usage: npm run release -- <tag>');
  process.exit(2);
}

function fail(text) {
  console.error(text);
  process.exit(1);
}

if (docker(['image', 'inspect', `linkbox:${tag}`]).status !== 0) fail(`image linkbox:${tag} not found: build it first`);

let s;
try {
  s = await state();
} catch (e) {
  fail(`the router does not answer on :8081 (${e.message}): docker compose up -d --build router`);
}

const live = liveSlot(s);
const idle = SLOTS.find((x) => x !== live);
if (s.slots[live].weight !== 100) {
  fail(`traffic is split (blue ${s.slots.blue.weight}, green ${s.slots.green.weight}): run npm run rollback first`);
}
say(`release ${tag}: ${live} serves all traffic, the new image goes to ${idle}`);
await mark(`release ${tag}: start, ${live} serves, new image to ${idle}`);

// 1. The new image in the idle slot. It has no traffic, so replacing the container there costs nothing.
const up = docker(['compose', 'up', '-d', '--no-deps', idle], { [`${idle.toUpperCase()}_TAG`]: tag });
process.stdout.write(`${up.stdout ?? ''}${up.stderr ?? ''}`);
if (up.status !== 0 || up.error) fail(`docker compose could not start ${idle} with linkbox:${tag}${up.error ? ` (${up.error.message})` : ''}`);
say(`${idle} runs linkbox:${tag}; waiting for Docker to report it healthy`);

// 2. Wait for Docker to report it healthy. No traffic moves before that.
const started = Date.now();
let c = containerState(idle);
while (c.health !== 'healthy') {
  if (!c.running || c.health === 'missing') fail(`${idle} is not running (${c.health}); no traffic moved. docker logs linkbox-${idle}-1`);
  if (Date.now() - started > HEALTHY_WITHIN_S * 1000) fail(`${idle} is not healthy after ${HEALTHY_WITHIN_S} s (${c.health}); no traffic moved`);
  await sleepFor(1000);
  c = containerState(idle);
}
say(`${idle} is healthy after ${((Date.now() - started) / 1000).toFixed(1)} s`);

// 3. The stages, with the gate.
const base = (await state()).slots[idle];
let tripped = null;
try {
  for (const stage of STAGES) {
    await setTraffic(idle, stage.pct);
    await mark(`release ${tag}: ${idle} takes ${stage.pct}%`);
    say(`${idle} takes ${stage.pct}% for ${stage.secs} s`);
    const until = Date.now() + stage.secs * 1000;
    let errors = 0;
    let requests = 0;
    while (Date.now() < until) {
      await sleepFor(POLL_MS);
      const now = (await state()).slots[idle];
      errors = now.errors - base.errors;
      requests = now.requests - base.requests;
      if (errors >= MAX_ERRORS || (requests >= MIN_REQUESTS && errors / requests > MAX_RATE)) {
        tripped = { pct: stage.pct, errors, requests };
        break;
      }
    }
    if (tripped) break;
    say(`${idle} at ${stage.pct}%: ${requests} requests, ${errors} errors since the release began`);
  }
} catch (e) {
  tripped = { error: e.message };
}

// 4a. The gate stopped it: everything goes back to the old slot, with no command from anyone.
if (tripped) {
  const why = tripped.error ?? `${tripped.errors} errors in ${tripped.requests} requests at ${tripped.pct}% (limit ${MAX_ERRORS}, or ${MAX_RATE * 100}% of at least ${MIN_REQUESTS})`;
  say(`GATE: ${idle} is failing: ${why}`);
  try {
    await setTraffic(live, 100);
  } catch (e) {
    fail(`could not send traffic back to ${live}: ${e.message}. Run npm run rollback`);
  }
  await mark(`release ${tag}: gate stopped it, all traffic back to ${live}`);
  say(`ROLLED BACK by the gate: ${live} has 100% again; ${idle} is left running for inspection`);
  process.exit(1);
}

// 4b. It held through every stage.
await mark(`release ${tag}: done, ${idle} serves, ${live} kept as the way back`);
say(`release ${tag} done: ${idle} serves 100%, ${live} is still running (npm run rollback goes back)`);
