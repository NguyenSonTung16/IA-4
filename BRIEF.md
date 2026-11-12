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
