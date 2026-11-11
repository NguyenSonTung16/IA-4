# The change: links can expire

This is what v2 adds. `npm run check -- change` runs against it, so read it the way a test
reads it.

## Schema

A nullable `links.expires_at`, and whatever you need to store the flag. v1 keeps running on
the new schema: that is the point of the exercise.

## The flag

`expiry`, stored **in the database**, off until someone turns it on. It is not an
environment variable: turning it off must not need a new image or a restart, and every
running instance must see the change within 2 seconds.

```http
PUT /admin/flags/expiry
x-admin-token: <the value of ADMIN_TOKEN>
content-type: application/json

{"enabled": true}
```

`200` with the new state; `401` when the token is wrong or missing.

`GET /version` gains `flags`: `{"version": "2.0.0", "env": "staging", "flags": {"expiry": false}}`.

## With the flag off

v2 behaves as v1 does. `expiresInSeconds` in a body is ignored, every response carries
`"expiresAt": null`, and `GET /r/:code` always redirects, even for a link that has expired.

## With the flag on

| Request | Answer |
|---|---|
| `POST /links` with `"expiresInSeconds": 3600` | `201`, and `expiresAt` is an ISO 8601 time |
| `POST /links` with no `expiresInSeconds` | `201`, `"expiresAt": null`: this link never expires |
| `POST /links` with `expiresInSeconds` that is not a positive whole number | `400` |
| `GET /r/:code`, not yet expired | `302`, counts the hit |
| `GET /r/:code`, expired | `410`, `{"error": "expired"}`, does not count the hit |
| `GET /links/:code`, `GET /links` | `200`, with `expiresAt`, expired or not |

A row written before the migration has `"expiresAt": null` and never expires.

## What stays the same

Everything `test/app.test.js` checks, and every field v1 returns. v1 and v2 answer side by
side during a canary and after a rollback, so one client may reach either of them from one
request to the next.
