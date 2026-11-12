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
