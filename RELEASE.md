# RELEASE.md — releasing v2 of linkbox, and going back

Tags: `starter` (as received), `v1` (packaged, same behaviour), `v2` (links can expire, behind the `expiry` flag).
Migration: `migrations/002_expiry.up.sql` / `002_expiry.down.sql`. Two slots, `blue` and `green`, behind the router;
the router's control port is `:8081`. Commands are the ones in `package.json` and `compose.yaml`.

## The plan, one row per step

Schema 001 is the starter's `links` table. Schema 002 adds `links.expires_at` (nullable) and a `flags` table.
v2 cannot start on 001 (it prepares statements that name `expires_at` and `flags`); v1 runs on both.

| # | Step and exact command | Schema after | What is serving | How to undo it | Versions that can run on this schema |
|---|---|---|---|---|---|
| 1 | Start clean: `docker compose down -v`, then `docker compose up -d --build router` | none (no volume yet) | nothing | `docker compose down -v` | – |
| 2 | `npm run migrate:image -- v1` | 001 | nothing | `npm run migrate:image -- v1 down` (drops `links`; the table is empty here) | v1 only |
| 3 | `BLUE_TAG=v1 docker compose up -d --no-deps blue`, wait until healthy, then start `npm run load` | 001 | blue = v1, 100% | `docker compose stop blue` | v1 only |
| 4 | `npm run migrate:image -- v2` (then wait about 10 s: v1 is now running on schema 002) | **002** | blue = v1, 100%, on the new schema | `npm run migrate:image -- v2 down`, only once nothing runs v2: it drops `flags` and every `expires_at` | v1 and v2 |
| 5 | `npm run release -- v2`: the image goes to green, Docker must report it healthy, then green takes 10% for 15 s, 50% for 15 s, 100% for 10 s; blue stays up | 002 | green = v2, 100%; blue = v1 running, 0% | by itself: the gate sends everything back to blue if green fails; by hand: `npm run rollback` | v1 and v2 |
| 6 | Turn the flag on through the router: `PUT http://127.0.0.1:8080/admin/flags/expiry` with header `x-admin-token` and body `{"enabled":true}`; wait 10 s | 002 (`flags.expiry` = 1) | green = v2, 100%, expiry on | the same call with `{"enabled":false}`: no restart, every instance sees it within 2 s | v1 and v2 |
| 7 | `npm run rollback`: all traffic to blue (v1), across the migration; hold for 10 s or more | 002, unchanged | blue = v1, 100%; green = v2 running, 0% | `npm run rollback` again (back to green) | v1 and v2 |
| 8 | `npm run release -- v2` again: green already runs `linkbox:v2` (compose reports it running), so only the stages repeat | 002 | green = v2, 100%; blue = v1 running, 0% | as step 5 | v1 and v2 |
| 9 | `npm run drill:build -- v2` builds the image `linkbox:v3-bad` (v2 plus a fault); nothing that serves changes | 002 | green = v2, 100% | `docker image rm linkbox:v3-bad` | v1, v2 and v3-bad |
| 10 | `npm run release -- v3-bad`: the image goes to blue (the idle slot, which replaces its v1 container), blue takes 10%, the gate sees the failures and sends everything back to green; wait 10 s or more, then stop the load | 002 | green = v2, 100%; blue = v3-bad running, 0% | by itself, in the same release; the failing container is left running for inspection | v1, v2 and v3-bad |

The order is expand first: the migration (step 4) runs while v1 is the only version serving, and v1 keeps serving on the new
schema for about 10 s before any v2 request. The load log shows it as a `migration up from linkbox:v2` mark followed by
seconds in which v1 answers on schema 002 (check L5).

## Point of no return

None, in this plan. Traffic never depends on the schema: v1 and v2 both run on 002, so going back is only moving the router's
weights (`npm run rollback`), and that is why the rollback in step 7 works across the migration.

The one step that loses information is `migrate down` of 002, which is not part of any rollback here: it drops the flag and
every expiry date, so every link becomes permanent again. It is only safe once no instance runs v2, and it is a decision, not
a reflex. A later migration that drops or renames a column v1 reads would be a real point of no return (nothing is left for
v1 to run on); this release has none.

## The gate in `deploy/release.js`

Constants at the top of the file: stages 10% for 15 s, 50% for 15 s, 100% for 10 s; `MAX_ERRORS = 3`; `MAX_RATE = 0.02` once
the new slot has had `MIN_REQUESTS = 50`; counters read every `POLL_MS = 500` ms; the container must be healthy within 90 s.

- **What it counts.** Since the release began, the new slot's `errors` and `requests` from `GET :8081/state` (the router
  counts 5xx and unreachable answers). It trips at 3 errors, or at more than 2% of at least 50 requests. One error on its own
  never trips it. It does not ask `/health`: `/health` stays green in the bad release.
- **Why these numbers.** The load is about 40 requests a second, so at 10% the canary gets about 4 a second (the rehearsal log shows 35 in 10 s), around 50 in 15 s.
  Trip on 1 error and one stray reset would abort a good release; trip only at a high rate and a fault that fails 3 requests in 20
  would pass the canary. 3 errors is the smallest number that is not one stray error, and it bounds the damage: the bad canary
  has taken only a few seconds of requests when it trips. In the dress rehearsal (real router and load script, a stand-in for
  Docker, stage times shortened) the gate stopped `v3-bad` at the first stage after 3 errors in 21 requests, and the
  load log counted 3 failed requests from the bad version.
- **What it misses.**
  - Anything the router does not count as an error: a wrong 4xx or 410, a wrong redirect target, a missing field. The load
    script's `contract` and `lost` failures never reach `/state`.
  - Data damage that answers 200: a lost link or hit.
  - Latency: a response that takes 9 s counts as fine (the router times out at 10 s).
  - A fault below the floor: in the 10% stage about 50 requests arrive, so a fault that fails fewer than about 6% of requests may
    not reach 3 errors in 15 s. It would then show up only at 50%, or not at all.
  - Faults on routes the canary barely reaches, and faults that appear only later: after 100%, when the flag is on, or
    after hours. After the 10 s at 100% nothing watches any more.
  - It judges the new slot alone, with no comparison against the old one: a failure the old version shares would count against
    the new one.

## What a rollback does not undo

`npm run rollback` moves traffic and nothing else.
- **The schema stays at 002**: `expires_at` and `flags` are still there. Undoing that is `migrate down`, a separate command.
- **The flag stays on.** Its state is a row in the database, so it is still on after v1 serves, and still on when v2 comes back.
- **Everything written while v2 served stays**: the links it created (with their `expires_at`), and the hits it counted.
- **A link that expired while v1 was serving.** v1 does not know about `expires_at`, so it redirects with a 302 and counts the
  hit, as if the link had never expired. The row is not changed: when v2 serves again with the flag on, the same link answers
  410. A client can therefore see 302 and 410 for one link depending on which version answers, and the hits counted while v1
  served stay in the total.
- **Links created by v1 have no expiry** (`expires_at` is null) and never expire, in either version.
- **The failed requests of the bad canary** are not taken back, and the failing container is left running, not removed.
- **The old container may be gone.** Step 10 puts `v3-bad` in blue, replacing the v1 container there; after it, the way back is
  green (v2), and v1 would have to be started again with `BLUE_TAG=v1 docker compose up -d --no-deps blue`.
