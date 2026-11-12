// npm run rollback
//
// Sends all traffic to the other slot, in one command, and confirms it by reading GET :8081/state.
// It refuses when the other slot is not running and healthy, because that would be an outage.
// `npm run rollback -- --force` skips that check.
import { SLOTS, say, mark, state, setTraffic, liveSlot, containerState } from './lib.js';

let s;
try {
  s = await state();
} catch (e) {
  console.error(`the router does not answer on :8081 (${e.message})`);
  process.exit(1);
}

const from = liveSlot(s);
const to = SLOTS.find((x) => x !== from);
say(`rollback: traffic goes from ${from} to ${to}`);

const c = containerState(to);
if (!process.argv.includes('--force') && !(c.running && c.health === 'healthy')) {
  console.error(`${to} is not running and healthy (${c.running ? c.health : 'not running'}): no traffic moved. Use -- --force to go anyway`);
  process.exit(1);
}

let after;
try {
  after = await setTraffic(to, 100);
} catch (e) {
  console.error(`rollback failed: ${e.message}`);
  process.exit(1);
}
await mark(`rollback: all traffic to ${to}`);

const { blue, green } = after.slots;
say(`confirmed by GET :8081/state: blue ${blue.weight}%, green ${green.weight}%`);
say(`so far: blue ${blue.requests} requests, ${blue.errors} errors; green ${green.requests} requests, ${green.errors} errors`);
