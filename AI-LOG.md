# AI-LOG.md

Assistant: Claude (Sonnet 5.5), used through the Claude desktop app. Entries are written when they happen.

## Brief 1 — package v1 (commits `ba7e7fd`, then fix `b8340ef`)

**Changed** (what I kept from the assistant)
- `Dockerfile`: pinned `node:22.13.1-alpine`, `ARG APP_VERSION` baked into the image, non-root `USER node`,
  only `package.json`, `src/` and `migrations/` copied, a `HEALTHCHECK`, exec-form `CMD` with no migration.
  Kept as written; I1–I7, I10 and I13–I15 passed in `npm run check -- image` (11 of 15 on the first run).
- `src/config.js`: reads `APP_ENV`, `PORT`, `DB_PATH`, `BASE_URL`, `ADMIN_TOKEN` from the environment; in
  production it exits and names `ADMIN_TOKEN` (never its value) when the token is missing or is the dev default.
- `.dockerignore`, and a SIGTERM handler in `src/server.js` so `docker stop` lets a request in flight finish.

**Rejected** (what the assistant got wrong, and what caught it)
- The first `src/server.js` wrote `createApp(open(config.dbPath), config)`, so nothing kept the database handle.
  On Node 22.13.1 the handle was garbage-collected and every statement failed with `statement has been
  finalized`: `/health`, `POST /links` and `GET /links/:code` answered 500.
  - Caught by: `npm run check -- image` → **I8, I9, I11, I12 FAIL** (11 of 15), then the container log
    (`Error: statement has been finalized`, `src/app.js:46`) and `docker inspect` (health `unhealthy`).
  - Why the assistant missed it: its own test ran for a few seconds on Node 22.23, where the handle was not
    collected; only the image's Node 22.13.1 showed it. Reproduced afterwards with Node 22.13.1 and a forced GC:
    `/health` 500 before, 200 after.
  - Fix: `b8340ef` keeps `db` in a variable and closes it on shutdown (brief 1b in `BRIEF.md`).

## Brief 2 — the change: links can expire (commit "change: links can expire…")

**Changed** (what I kept from the assistant)
- `migrations/002_expiry.up.sql` / `.down.sql`: nullable `links.expires_at`, a `flags` table with `expiry` = 0.
  Additive, so v1 keeps running on it; the down file drops both again.
- `src/app.js`: `PUT /admin/flags/expiry`, `flags` in `GET /version`, the flag read from the database at
  every request (no cache, so a flip reaches every instance at once), 400 / 410 behaviour from `docs/CHANGE.md`.
- `test/expiry.test.js`: new tests for the flag, the 400 and 410 cases, the old rows, two instances on one
  database, and the migration up, down, up. `test/app.test.js` is untouched.

**Rejected** (what the assistant got wrong, and what caught it)
- The first `src/app.js` relied on the `server.js` fix alone to keep the database alive. Running the tests on
  Node 22.13.1 (the image's version) showed the starter's own `test/app.test.js` failing 2 of 6 with
  `statement has been finalized`, and my new tests failing the same way: the same garbage-collection problem,
  in any caller that does not hold the database. It only appeared on 22.13.1, not on the Node 22.23 used first.
  - Caught by: running `node --test` on both Node versions, not by a check.
  - Fix: `createApp` keeps `server.db = db`, so the app holds the database for as long as it lives, whoever calls it.

## Brief 3 — release and rollback scripts (commit "deploy: release with a canary gate…")

**Changed** (what I kept from the assistant)
- `deploy/release.js`: image into the idle slot, waits for Docker's health status (not a timer), 10% for 15 s,
  50% for 15 s, 100% watched for 10 s; reads `GET :8081/state` every 500 ms and, at 3 errors (or more than 2% of
  at least 50 requests) from the new slot, sends everything back by itself and exits 1. `deploy/rollback.js`:
  one command, other slot to 100%, confirmed from `/state`, refuses if the other slot is not healthy.
  `deploy/lib.js`: the control-port and docker helpers they share. Limits are named constants at the top.
- Dress rehearsal (real router, real `tools/load.js`, real `tools/check.js log`; only Docker replaced by a stand-in
  that starts the v1, v2 and `v3-bad` servers on Node 22.13.1): L0–L9 all PASS; the gate stopped `v3-bad` after
  3 s, 21 requests reached it, 3 failed. Stage times were shortened there (10 s / 4 s / 3 s) to fit one tool call.
  Not covered by the rehearsal: the real `docker compose` and HEALTHCHECK, which the real run below tests.

**Rejected** (what the assistant got wrong, and what caught it)
- The first `release.js` did not look at `spawnSync`'s `error`, so a `docker compose up` that timed out (status 0,
  `ETIMEDOUT`) was treated as success and the release went on; and the control-port calls had no retry, so a
  connection the router had closed while idle (it closes them after 65 s) killed the script with
  `fetch failed: other side closed`.
  - Caught by: the first full rehearsal, in the log (`[05:15:18] green is healthy after 0.0 s`, then the
    `TypeError: fetch failed` stack trace), not by `npm run check`.
  - Fix: `up.error` is now checked, `control()` retries once (every control call is safe to repeat), and
    `docker()` no longer gives the child a stdin pipe.
- (Not the product: the rehearsal stand-in also had two bugs of mine, a wrong argument position and a
  backgrounded `cd … &&` list that held the pipe open. Found by the same rehearsal, fixed there.)
