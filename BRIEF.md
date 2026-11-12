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
