# Self-assessment — IA#4 Release and rollback

Total I claim: **94 / 100**. Evidence is in the repository (tags `starter`, `v1`, `v2`; `git log`), `check-log.txt` (39 of 39 passed,
fingerprint 4b56096c90ea819d) and `load-log.txt` (line numbers below).

| # | Criterion | Max | Claimed | Evidence |
|---|-----------|-----|---------|----------|
| 1 | Image and config | 20 | 20 | `Dockerfile`, `.dockerignore`, `src/config.js`, `env/`; `check-log.txt` I1–I15 all PASS; tag `v1`. Note: `server.js` fix for the GC'd database handle, commit b8340ef (NOTES.md finding 1). |
| 2 | Change behind a flag | 10 | 10 | `src/app.js`, `migrations/002_expiry.*`, `test/expiry.test.js`; `check-log.txt` T3, F1–F7 PASS; tag `v2`. |
| 3 | Migration and deploy order | 15 | 14 | C1–C4 and L5 PASS (`load-log.txt` line 32: migration mark at T+30.5 s, v1 served on the new schema before v2 took traffic); `RELEASE.md` table (10 rows) and order. I may have worded a table cell less precisely than the checker expects. |
| 4 | Canary release | 15 | 14 | `deploy/release.js`; L0–L4 PASS; stages `load-log.txt` lines 45–97 (10% 16 s, 50% 15 s); health wait in `release-log.txt`; gate section of `RELEASE.md`. The gate is blind to failures the router does not count (NOTES.md finding 2). |
| 5 | The way back | 20 | 19 | `deploy/rollback.js`, L6–L9 PASS: rollback `load-log.txt` lines 114–129, bad release lines 181–197 (3 failed of 14, gate stopped it by itself, 3 s); `rollback` confirms with `GET :8081/state`; `RELEASE.md` section "what rollback does not undo" includes the link that expired while v1 served. |
| 6 | Briefs, commits, checking | 20 | 17 | `BRIEF.md` (briefs 1, 1b, 2, 3, 4, each committed before its hand-over with limits and check IDs); starter committed and tagged first; packaging, change and release scripts are separate commits after clean trees; `AI-LOG.md` has Changed/Rejected lines from real findings. Deducted for: brief 1b was written after the first image check failed, and the log files were committed in one commit. |

## What I did not manage
- The gate only sees what the router counts (5xx and unreachable); wrong 4xx answers, missing fields and lost hits do not stop a release.
- I ran the full sequence once on Docker Desktop; stage lengths and the `--force` rollback path were not tried under other conditions.
- A stand-in for Docker was used in a rehearsal before the real run; the real run is the evidence, not the rehearsal.
