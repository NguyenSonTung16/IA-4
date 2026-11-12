# BRIEF.md — what I handed over to my assistant

Each brief is committed BEFORE the hand-over, so `git diff` shows only what the assistant changed.

## Brief 1 — package linkbox as v1 (criterion 1)

**Ask:** package the service so the `image` group of `npm run check` is green, with NO change in behaviour:
I1–I15 (pinned base image, <= 300 MB, non-root user, no secret in image/history, only what the
service needs in the image, migrations run inside the image, version from `APP_VERSION` build arg,
config from environment, HEALTHCHECK, graceful `docker stop` <= 8 s, production config works, data
outlives the container, refuses to start in production on a missing or `dev-secret` token without
printing it, starting a container does not run migrations).

**Limits:**
- Nothing under `tools/` and nothing in `test/app.test.js` may change.
- Keep `createApp(db, config)` and `node src/migrate.js` as they are (the checks call them).
- Do not add dependencies. Do not change what any endpoint answers.
- Touch only: `Dockerfile`, `.dockerignore`, `src/config.js`, `src/server.js`, `package.json` (start script).

**Done when:**
- `npm run check -- image --new=linkbox:v1` shows I1–I15 all PASS.
- `npm test` still passes (T3: 6 pass, 0 fail) and `npm run check -- tools` shows the fingerprint `4b56096c90ea819d`.
- `git diff starter -- tools/ test/app.test.js` is empty.

## Brief 1b — fix v1 after `npm run check -- image` went red (criterion 1)

**What happened:** after brief 1, `npm run check -- image --new=linkbox:v1` gave 11 of 15: I8, I9, I11 and
I12 failed. The container log said `Error: statement has been finalized` (ERR_INVALID_STATE) at
`src/app.js:46`, so `/health`, `POST /links` and `GET /links/:code` all answered 500.

**Ask:** make the service keep working after garbage collection, with no change in behaviour.
The cause is in `src/server.js`: `createApp(open(...), config)` leaves nothing holding the database
handle, so on Node 22.13.1 it is collected and its prepared statements are finalized.

**Limits:**
- Nothing under `tools/` and nothing in `test/app.test.js` may change.
- Touch only `src/server.js`. Keep `createApp(db, config)` and `node src/migrate.js` as they are.

**Done when:**
- With Node 22.13.1 and a forced garbage collection, `/health` still answers 200 (it answers 500 before the fix).
- `npm test` still passes, and after rebuilding `linkbox:v1`, `npm run check -- image --new=linkbox:v1` shows I1–I15 all PASS.

## Brief 2 — the change: links can expire, behind a flag (criteria 2 and 3)

**Ask:** build exactly what `docs/CHANGE.md` specifies, as v2, starting from tag `v1`.
- Migration `migrations/002_expiry.up.sql` + `002_expiry.down.sql`: a nullable `links.expires_at`, and a table that stores the flag in the database.
- v1 must keep running on the migrated schema, and the down migration must give v1 a working schema again.
- Flag `expiry`: stored in the database, off by default, never an environment variable; every running instance sees a flip within 2 s with no restart; `PUT /admin/flags/expiry` with `x-admin-token` (200 with the new state, 401 on a wrong or missing token); `GET /version` gains `flags`.
- Flag off: behaves as v1 (`expiresInSeconds` ignored, `expiresAt` is `null`, `GET /r/:code` always redirects).
- Flag on: the table in `docs/CHANGE.md` (201 with ISO `expiresAt`, 400 for a bad `expiresInSeconds`, 410 `{"error":"expired"}` for an expired link without counting the hit).
- Every field v1 returns stays; rows from before the migration have `expiresAt: null` and never expire.

**Limits:**
- Nothing under `tools/` and nothing in `test/app.test.js` may change.
- Keep `createApp(db, config)` and `node src/migrate.js` as they are. No new dependencies.
- Touch only `src/app.js`, `migrations/002_*`, and new test files (`test/expiry.test.js`). Do not touch the `/__probe/slow` route.

**Done when:**
- `npm test` passes, including the new tests.
- After `docker build --build-arg APP_VERSION=2.0.0 -t linkbox:v2 .`: `npm run check -- change` shows F1–F7 PASS, `npm run check -- compat` shows C1–C4 PASS.
- `git diff starter -- tools/ test/app.test.js` is empty and the fingerprint is `4b56096c90ea819d`.

## Brief 3 — release and rollback scripts (criteria 4 and 5)

**Ask:** write `deploy/release.js` (`npm run release -- <tag>`) and `deploy/rollback.js` (`npm run rollback`), plain Node, no dependencies, using only the router's control port and the `docker` CLI.
- `release`: put `linkbox:<tag>` in the idle slot, wait until Docker reports the container healthy (not a timer), then move traffic in stages: at least two stages below 100%, the first at 25% or less for at least 10 s. While waiting it reads `GET :8081/state` and, when the canary slot fails more than a limit, sends all traffic back by itself and exits non-zero. It leaves the old slot running. `/health` stays green in the bad release, so the gate must count the router's errors, not ask `/health`.
- `rollback`: one command, sends everything to the other slot and confirms the new weights from `GET :8081/state`.
- Both leave marks in the load log (`POST :8081/mark`). No mark may contain the word "migrat": the checks read that word as the migration.

**Limits:**
- Nothing under `tools/` and nothing in `test/app.test.js` may change; `compose.yaml`, the Dockerfile and `src/` stay as they are.
- Touch only `deploy/release.js`, `deploy/rollback.js` and a shared `deploy/lib.js`. Leave `deploy/migrate.js` alone.
- Write the limit and the stage times as named constants at the top, so `RELEASE.md` can say why.

**Done when:**
- A full dress rehearsal (router + load + both scripts, v1 → v2 → rollback → v2 → `v3-bad`) gives L0–L9 PASS in `npm run check -- log`, with the gate stopping `v3-bad` by itself.
- `git diff starter -- tools/ test/app.test.js` is empty and the fingerprint is `4b56096c90ea819d`.

## Brief 4 — RELEASE.md and NOTES.md (criteria 3, 4, 5 and 6)

**Ask:** write `RELEASE.md` for what is in this repository, and a first `NOTES.md`.
- `RELEASE.md`: one table row per step of the real run, in order, with five columns: the schema after the step, what is serving, the exact command, how to undo it, which versions can run on that schema. It must match the tags (`starter`, `v1`, `v2`), the migration (`002_expiry`) and the commands in `package.json`.
- It also says: the point of no return (or why there is none); the gate's limit, why that number, and what it misses; and what a rollback does not undo, including what happens to a link that expired while v1 was serving.
- `NOTES.md`: anything wrong or surprising in a tool (`tools/`, README), as findings, without changing the tool; and what the machine could not do (the second part is filled in after the real run).

**Limits:**
- Nothing under `tools/` and nothing in `test/app.test.js` may change; no code changes in this brief.
- Every number in `RELEASE.md` must be one that is in `deploy/release.js` or in a log; no figure taken from memory.

**Done when:**
- Each of the commands in the table exists in the repository (`package.json`, `compose.yaml`, `docs/CHANGE.md`), checked by reading them.
- The gate numbers in `RELEASE.md` equal the constants at the top of `deploy/release.js`.
