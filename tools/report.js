// Reads one load log and works out the numbers the release is judged on. No Docker needed.
const LIMITS = {
  minRate: 20,            // requests a second over the whole run, or the run proves little
  firstStageMax: 25,      // % of traffic the first canary stage may take
  firstStageSecs: 10,     // how long it has to stay there
  minStages: 2,           // stages below 100% before the new version takes everything
  holdSecs: 10,           // how long a rollback or the clean end has to be observed
  rollbackSecs: 300,      // the five minutes
};
export { LIMITS };

export function parse(text) {
  const lines = text.split('\n');
  const headers = lines.filter((l) => l.startsWith('=== load start'));
  const tools = headers[0]?.match(/tools=(\S+)/)?.[1];
  const secs = [];
  const marks = [];
  for (const l of lines) {
    const m = l.match(/^T\+(\d+) total=(\d+) fail=(\d+)(.*) weights=(\S+)$/);
    if (m) {
      const byV = {};
      const slotOf = {};
      for (const v of m[4].matchAll(/v\[([^\]@]+)@([^\]]+)\]=(\d+)\/(\d+)/g)) {
        const e = (byV[v[1]] ??= { n: 0, f: 0 });
        e.n += Number(v[3]);
        e.f += Number(v[4]);
        slotOf[v[1]] = v[2];
      }
      const w = Object.fromEntries(m[5].split(',').map((p) => { const [k, x] = p.split(':'); return [k, Number(x)]; }));
      secs.push({ t: Number(m[1]), total: Number(m[2]), fail: Number(m[3]), byV, slotOf, w });
      continue;
    }
    const k = l.match(/^T\+([\d.]+)s MARK (.*)$/);
    if (k) marks.push({ t: Number(k[1]), text: k[2] });
  }
  return { headers: headers.length, tools, secs, marks, ended: lines.some((l) => l.startsWith('FINAL ')) };
}

const n = (s, v) => s.byV[v]?.n ?? 0;
const f = (s, v) => s.byV[v]?.f ?? 0;

// Each result: { id, ok, text }. `numbers` holds the figures, for the summary.
export function analyse(text) {
  const { headers, tools, secs, marks, ended } = parse(text);
  const out = [];
  const add = (id, ok, msg) => out.push({ id, ok: Boolean(ok), text: msg });
  const numbers = { tools };

  add('L1', headers === 1 && ended, `one continuous run that ended cleanly: ${headers} run(s), ${ended ? 'ended' : 'no FINAL line'}`);
  const total = secs.reduce((s, x) => s + x.total, 0);
  const rate = secs.length ? total / secs.length : 0;
  numbers.total = total;
  numbers.duration = secs.length;
  add('L2', rate >= LIMITS.minRate, `traffic held up: ${total} requests in ${secs.length} s, ${rate.toFixed(1)} a second (needs ${LIMITS.minRate})`);

  const seen = [];
  for (const s of secs) for (const v of Object.keys(s.byV)) if (v !== 'none' && !seen.includes(v)) seen.push(v);
  const bad = seen.find((v) => v.endsWith('-bad'));
  const good = seen.filter((v) => v !== bad);
  const [oldV, newV] = good;
  numbers.versions = seen;
  if (!oldV || !newV) {
    add('L3', false, `found an old and a new version: saw ${seen.join(', ') || 'none'}`);
    return { results: out, numbers };
  }

  // Everything that failed and was not answered by the bad drill image.
  const outside = secs.reduce((s, x) => s + x.fail - f(x, bad), 0);
  numbers.failedOutside = outside;
  add('L3', outside === 0, `failed requests outside the bad canary: ${outside}`);

  // The release: old -> new. Every response names its slot, so the log says where new went.
  const iFirst = secs.findIndex((s) => n(s, newV) > 0);
  const newSlot = secs[iFirst].slotOf[newV];
  let iFull = secs.findIndex((s, i) => i >= iFirst && s.w[newSlot] === 100);
  if (iFull < 0) iFull = secs.length;
  const stages = [];
  for (let i = iFirst; i < iFull; i++) {
    const w = secs[i].w[newSlot];
    if (w === 0) continue;
    const elapsed = i === iFirst ? 1 : secs[i].t - secs[i - 1].t;
    if (stages.at(-1)?.w === w) stages.at(-1).secs += elapsed;
    else stages.push({ w, secs: elapsed });
  }
  numbers.stages = stages;
  const stageText = stages.map((s) => `${s.w}% ${s.secs} s`).join(', ') || 'none';
  add('L4', stages.length >= LIMITS.minStages && stages[0].w <= LIMITS.firstStageMax && stages[0].secs >= LIMITS.firstStageSecs,
    `canary before 100%: ${stageText} (needs ${LIMITS.minStages} stages, the first at ${LIMITS.firstStageMax}% or less for ${LIMITS.firstStageSecs} s)`);

  // The migration comes first, with the old version still serving on the new schema.
  const firstNewT = secs[iFirst].t;
  const mig = marks.findLast((m) => /migrat/i.test(m.text) && m.t < firstNewT);
  const after = mig ? secs.filter((s) => s.t > mig.t && s.t < firstNewT && n(s, oldV) > 0) : [];
  numbers.oldOnNewSchema = after.length;
  add('L5', mig && after.length >= 5, mig
    ? `migration before deploy: marked at T+${mig.t}s, then ${oldV} served ${after.length} s on the new schema before ${newV} took a request`
    : `migration before deploy: no migration mark before the first ${newV} request`);

  // Rollback to the old version, across the schema change, then forward again.
  const iBad = bad ? secs.findIndex((s) => n(s, bad) > 0) : secs.length;
  const iBack = secs.findIndex((s, i) => i > iFull && i < iBad && n(s, oldV) > 0);
  let held = 0;
  let iForward = -1;
  if (iBack >= 0) {
    iForward = secs.findIndex((s, i) => i > iBack && n(s, newV) > 0 && n(s, oldV) === 0);
    const end = iForward < 0 ? iBad : iForward;
    held = secs.slice(iBack, end).filter((s) => n(s, oldV) > 0 && n(s, newV) === 0).length;
  }
  numbers.oldHeldSecs = held;
  add('L6', iBack >= 0 && held >= LIMITS.holdSecs && iForward >= 0,
    iBack < 0 ? `rollback to ${oldV} under load: never happened after ${newV} reached 100%`
      : `rollback to ${oldV} under load: ${oldV} alone for ${held} s (needs ${LIMITS.holdSecs}), ${iForward >= 0 ? `then forward to ${newV}` : `never forward again to ${newV}`}`);

  // The bad canary.
  if (!bad) {
    add('L7', false, 'bad canary: no version ending in -bad took traffic (see the drill in README.md)');
    return { results: out, numbers };
  }
  const badSecs = secs.filter((s) => n(s, bad) > 0);
  const answered = badSecs.reduce((s, x) => s + n(x, bad), 0);
  const failedBad = badSecs.reduce((s, x) => s + f(x, bad), 0);
  numbers.badAnswered = answered;
  numbers.badFailed = failedBad;
  const iB = secs.indexOf(badSecs[0]);
  const badSlot = badSecs[0].slotOf[bad];
  const peak = Math.max(...secs.slice(iB, secs.indexOf(badSecs.at(-1)) + 1).map((s) => s.w[badSlot]));
  numbers.badPeak = peak;
  add('L7', failedBad > 0 && peak <= LIMITS.firstStageMax,
    `bad canary stayed a canary: ${answered} requests reached it, ${failedBad} failed, its weight peaked at ${peak}% (limit ${LIMITS.firstStageMax}%)`);

  const firstFail = badSecs.find((s) => f(s, bad) > 0);
  const lastServed = badSecs.at(-1);
  const seconds = firstFail ? lastServed.t - firstFail.t + 1 : null;
  numbers.rollbackSecs = seconds;
  add('L8', seconds !== null && seconds <= LIMITS.rollbackSecs,
    `time to rollback: ${seconds === null ? 'no failure to measure from' : `${seconds} s from its first failed request to its last answered request`} (limit ${LIMITS.rollbackSecs} s)`);

  const tail = secs.slice(secs.indexOf(lastServed) + 1);
  const clean = tail.length >= LIMITS.holdSecs && tail.every((s) => s.fail === 0 && n(s, bad) === 0) && tail.slice(-LIMITS.holdSecs).every((s) => n(s, newV) === s.total && s.total > 0);
  numbers.tailSecs = tail.length;
  add('L9', clean, `clean end: ${tail.length} s after the rollback, the last ${LIMITS.holdSecs} s all ${newV} with 0 failed`);

  return { results: out, numbers };
}
