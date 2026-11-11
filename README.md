# IA#4 starter: release a change, then roll it back under load

CSC13114 · Advanced Web Application Development · HK1 2026–2027

`linkbox` is a small short-link service: Node 22, no dependencies, SQLite. It runs, and it
is not ready to be released. Your job is to package it, release a change to it while traffic
keeps flowing, watch a bad release fail on a small share of that traffic, and go back. A
script measures the two numbers that matter: **how many requests failed**, and **how long the
way back took**.

Use your assistant for all of it. What is scored is what you handed over, what you committed
before you handed it over, and how you checked what came back. The rubric on Classroom has
the marks.

You need Docker with Compose, Node 22.13 or later, and Git. It runs on Windows, macOS and
Linux; all the scripts are Node, none are shell.

## How it fits together

```
npm run load ──▶ router :8080 ──weights──▶ blue   (one image)  ──┐
                 router :8081              green  (another image) ├─ one volume, /data/app.db
                 (control)                                       ─┘
```

- **Two slots, `blue` and `green`.** Each runs one image. A release puts the new image in the
  slot that has no traffic.
- **The router** decides how much traffic each slot gets. It never retries, so a failure
  reaches the client and gets counted. It is in `tools/router/` and it stands in for the load
  balancer of a real deployment.
- **The volume** holds the database. Both slots use the same one, so old and new code run
  against the same schema at the same time.

| Control port | What it does |
|---|---|
| `GET :8081/state` | weights, and for each slot the number of requests and of errors so far |
| `POST :8081/weights` | body `{"blue": 90, "green": 10}`; the two must add up to 100 |
| `POST :8081/mark` | any text; it shows up in the load log |

The compose file names the containers `linkbox-blue-1` and `linkbox-green-1`.
`BLUE_TAG=v2 docker compose up -d --no-deps blue` puts the image `linkbox:v2` in the blue slot.

## Commands

| Command | What it does |
|---|---|
| `npm test` | your tests and the old-client tests, on your machine, no Docker |
| `npm run migrate:image -- <tag> [down]` | runs the migrations inside image `linkbox:<tag>`, on the volume, and marks the log |
| `npm run load` | about 40 requests a second through the router until Ctrl+C; writes `load-log.txt` from scratch each time it starts |
| `npm run mark -- "text"` | leaves a line in the running load log |
| `npm run check` | every check below; add `-- tools`, `-- image`, `-- change`, `-- compat` or `-- log` for one group |
| `npm run drill:build -- <tag>` | builds the bad release `linkbox:v3-bad` from your `linkbox:<tag>` |
| `npm run release -- <tag>` | **yours to write**, step 5 |
| `npm run rollback` | **yours to write**, step 5 |

What the load script counts as failed:

| Kind | What it means |
|---|---|
| `error` | any 5xx, including the router's 502 when a slot is not there |
| `network` | the router itself did not answer |
| `contract` | a wrong status, a missing field, a response with no `x-app-version` |
| `lost` | a link we were told exists is gone, points elsewhere, or lost a counted hit |

## The steps

### 1. Look at what you were given

Read `Dockerfile`, `src/config.js`, `src/server.js` and `compose.yaml`, then see for yourself
what the checks say about the image:

```bash
git init            # if you did not clone it
git add -A && git commit -m "starter"
git tag starter
docker build -t linkbox:v1 .
docker compose up -d --build router
npm run migrate:image -- v1
docker compose up -d --no-deps blue
npm run check -- image --new=linkbox:v1
```

The check goes red in many places. Each line says what it measured. `docker compose down -v`
clears everything.

### 2. Commit before you hand anything over

Every hand-over starts from a clean commit, so that `git diff` shows exactly what your
assistant changed. Keep the briefs you give it in `BRIEF.md`: what you asked for, the limits you
set, and how you will know it is done.

**Put this limit in every brief: nothing under `tools/` and nothing in `test/app.test.js` may
change.** When a check is red, an assistant may well edit the check. `npm run check` prints a
fingerprint of `tools/` at the top of its output, and `git diff starter -- tools/` shows the
rest. If a tool looks wrong to you, write that in `NOTES.md`: that is a finding.

### 3. Package it: `v1`

The behaviour does not change. Get the `image` group of `npm run check` green:

| Check | What it wants |
|---|---|
| `I1` | the base image pinned to a version |
| `I2` | an image of 300 MB or less |
| `I3` | a non-root user |
| `I4` | no secret in the image config or its history |
| `I5` | only what the service needs in the image: no `.git`, `env/`, `tools/`, logs |
| `I6` | `node src/migrate.js up` works in the image, on a fresh volume mounted at `/data` |
| `I7` | `/version` reports the `APP_VERSION` baked into the image: `docker build --build-arg APP_VERSION=1.0.0` |
| `I8` | `APP_ENV`, `BASE_URL`, `DB_PATH`, `ADMIN_TOKEN` come from the environment |
| `I9` | a `HEALTHCHECK` that reports healthy |
| `I10` | `docker stop` lets a request in flight finish, and takes 8 s or less (Docker kills at 10) |
| `I11`, `I12` | the same image runs with the production config, and the data outlives the container |
| `I13`, `I14` | with `APP_ENV=production`, it refuses to start on a missing token or on `dev-secret`, names the variable, and does not print the value |
| `I15` | starting a container does not run the migrations: they are a separate step |

Keep `createApp(db, config)` and `node src/migrate.js` as they are: the checks call them. Commit,
`git tag v1`, then `docker build --build-arg APP_VERSION=1.0.0 -t linkbox:v1 .`

### 4. Make the change: `v2`

[`docs/CHANGE.md`](docs/CHANGE.md) is the specification: links can expire, behind a flag kept in
the database, with a migration that v1 keeps running on. Get the `change` and `compat` groups
green. Commit, `git tag v2`, then `docker build --build-arg APP_VERSION=2.0.0 -t linkbox:v2 .`

Write `RELEASE.md` before you release: one row per step, with the schema after it, what is
serving, the exact command, how to undo it, and which versions can run on that schema. Add what
a rollback does **not** undo, and name your point of no return if there is one.

### 5. Write the release and the rollback

- **`npm run release -- <tag>`** puts the image in the idle slot, waits until Docker says it is
  healthy, then moves traffic in stages: at least two stages below 100%, the first at 25% or
  less for at least 10 seconds. It reads `GET :8081/state` while it waits and goes back by
  itself when the canary fails more than a limit you choose. Say why you chose it in
  `RELEASE.md`. It leaves the old slot running.
- **`npm run rollback`** sends everything to the other slot in one command and confirms it with
  `GET :8081/state`.

`/health` stays green during the bad release. A release that only looks at `/health` will walk
straight through it.

### 6. Run it under load

One load run covers all of this, in this order. **Start the load before the first step and stop
it after the last one**: a second `npm run load` overwrites the log.

```bash
docker compose down -v
docker compose up -d --build router
npm run migrate:image -- v1
BLUE_TAG=v1 docker compose up -d --no-deps blue    # wait until it is healthy

npm run load                                       # in a second terminal: leave it running

npm run migrate:image -- v2                        # wait 10 s or so: v1 now runs on the new schema
npm run release -- v2                              # the release, zero failed requests
# turn the flag on: PUT /admin/flags/expiry through :8080, wait 10 s
npm run rollback                                   # back to v1, across the migration; hold it 10 s or more
npm run release -- v2                              # forward again
npm run drill:build -- v2
npm run release -- v3-bad                          # the bad release: it must stop on the canary
                                                   # wait 10 s or more, then Ctrl+C in the load terminal
```

Keep the output of the commands: `... 2>&1 | tee -a release-log.txt`. On PowerShell,
`... 2>&1 | Tee-Object -Append release-log.txt`.

On a shell that has no `VAR=value command` form, set `BLUE_TAG` first
(`$env:BLUE_TAG = "v1"` on PowerShell).

### 7. Read the numbers

```bash
npm run check 2>&1 | tee check-log.txt
```

The `log` group reads `load-log.txt`:

| Check | What it wants |
|---|---|
| `L0` | the run used these tools |
| `L1`, `L2` | one continuous run that ended with Ctrl+C, at 20 requests a second or more |
| `L3` | **zero failed requests** outside the bad canary |
| `L4` | the canary stages described in step 5 |
| `L5` | a migration mark before the first v2 request, then at least 5 s of v1 on the new schema |
| `L6` | v1 alone for 10 s or more after v2 had reached 100%, then v2 again |
| `L7` | the bad version failed, and never got more than 25% of the traffic |
| `L8` | **time to rollback** at most 5 minutes: from its first failed request to its last answered request |
| `L9` | at least 10 s after that, all on v2, with 0 failed |

A green check does not finish the job. It sees only what it measures: read the load log
yourself. Some questions it cannot answer, and `RELEASE.md` has to: what happens to a link that
expired while v1 was serving? And what does your limit in the gate miss?

## What to hand in

See the IA#4 rubric on Classroom.
