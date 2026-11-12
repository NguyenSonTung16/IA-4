# NOTES.md

## Findings about the starter and the tools

Nothing under `tools/` or in `test/app.test.js` was changed. These are things I think are wrong or easy to misread.

1. **The starter's `src/server.js` loses the database on Node 22.13.1.** `createApp(open(config.dbPath), config)` leaves
   nothing holding the database handle; the prepared statements do not keep it alive, so the garbage collector frees it and
   every statement fails with `statement has been finalized` (`/health` answers 500). It also hits the starter's own
   `test/app.test.js`, which keeps `db` in a local variable of `before()`: when I ran it on Node 22.13.1, two of its six tests
   failed; on Node 22.23 none did (I ran it once on each, so I cannot say how often). I could not change that test, so `createApp` now keeps `server.db = db`, and
   `server.js` keeps the handle and closes it on shutdown. The image uses Node 22.13.1 (checks I8, I9, I11, I12 went red
   because of it).
2. **The router only counts 5xx and unreachable answers, so a gate built on `GET :8081/state` cannot see the load script's
   `contract` or `lost` failures** (a wrong 4xx or 410, a missing field, a lost hit). I wrote the limit of the gate with
   that in mind (see `RELEASE.md`), but it is a real blind spot of the setup.
3. **`/state` counters are cumulative since the router started**, and the README does not say so. A gate has to subtract
   the value it read when the release began. `marks` in the same answer also grows without a limit.
4. **I9 does not measure the image's own HEALTHCHECK timing.** `tools/check.js` starts its containers with
   `--health-interval=1s --health-start-period=0s`, which overrides the image. Only the command is tested. My image
   uses `--interval=2s --start-period=3s`.
5. **README step 6, "turn the flag on: PUT /admin/flags/expiry through :8080"**, sends the call to whichever slot the router
   picks. While v1 still gets traffic it answers 404 for that route. It has to be done after v2 has reached 100%.
6. **L5 reads the word "migrat" in any mark.** Any mark that contains it counts as the migration mark; my release and
   rollback marks avoid the word so that only `deploy/migrate.js` writes it.

## The real run (12 Nov 2026, Docker Desktop, one `npm run load` from T+0 to the end)

`check-log.txt` ends with `RESULT: 39 of 39 passed`; `load-log.txt` ends with `FINAL total=7316 ... error=3`, and all 3 failures
came from `2.0.1-bad` (14 requests reached it). What I measured, from the files:

- v2 became healthy 3.4 s after `docker compose up` (`release-log.txt`, first release); the gate saw 0 errors at 10%, 50% and 100%.
- Rollback to blue: confirmed by `GET :8081/state` in the same command (`release-log.txt`, section `rollback`); blue served alone for 15 s.
- The bad release was stopped by the gate itself, 4 s after the canary got 10% (`GATE:` line in `release-log.txt`), 3 failed in 14 requests.
  `check` L8 measures 3 s from its first failed request to its last answered request.
- The second `release v2` found `green` already running and reused it (`Running`, healthy after 0.1 s); the bad release
  recreated `blue` (`Recreate`), so the old v2 container in `blue` no longer exists. The way back after that is `green`, which still runs v2.

What was not exercised on the real machine: the stage lengths are the constants in `release.js` (15 s, 15 s, 10 s) and were
run only once; a failure that the router does not count (a wrong 4xx, a lost hit) would not have stopped the gate (see finding 2);
`rollback --force` and the "target not healthy" refusal were rehearsed with a stand-in for Docker only, not on Docker.
I ran the sequence once and kept that run; I did not repeat it to pick a better one.
