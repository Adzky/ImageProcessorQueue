# TypeScript backend (Fastify) — design

Date: 2026-11-20 · Status: approved

## Intent

Show that the same async image-processing system can be built properly in two stacks. The
repo already has a Laravel/PHP backend (`apps/api`: `api`, `worker`, `scheduler` containers).
This adds a second, independent backend in strict TypeScript that does the same job, behind
the same React frontend, started with its own compose file.

Success: someone reviewing the repo can run either stack with one command, use the same UI
against both, run the same end-to-end smoke test against both, and read the TS code as a
credible, idiomatic counterpart, not a quick port.

## Goals

- `apps/api-ts`: Fastify API + BullMQ worker + scheduler in TypeScript with `strict: true`
  (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), one image, three commands
  — the same shape as the Laravel image.
- **Same HTTP contract** as Laravel, byte-for-byte where the frontend or smoke test can see it:
  routes, status codes, JSON shapes, error codes and messages, `Location` header, download
  filename and `Content-Type`.
- **Same behaviour**: content sniffing, 20 MB limit, resize to ≤1280 px longest side without
  upscaling, WebP at quality 80, EXIF orientation, CMYK → sRGB, metadata stripped, first frame
  of animations, 50 MP guard, permanent vs transient failures, 3 tries with 5 s / 15 s backoff,
  120 s per-attempt limit, claim-token state machine, stale-job reaper, 24 h retention with 410.
- Same env var names and defaults (`IMAGE_*`, `DB_*`, `REDIS_*`, `LOG_LEVEL`).
- Tests at the same level as the PHPUnit suite (Vitest against real Postgres and Redis, in Docker).
- `docker-compose.ts.yml` runs the whole TS stack; can run **at the same time** as the Laravel one.

## Non-goals

- No changes to the Laravel backend's behaviour. No changes to the web app's code.
- No shared database, queue or volume between the two stacks. They never see each other's data.
- No shared type package between web and API (possible later; the frontend stays as is).
- No auth, no Horizon-equivalent dashboard.

## Anti-goals (would count as failure even if it works)

- The TS backend drifts from the contract, so the UI behaves differently depending on the stack.
- `any`, unchecked casts or `@ts-ignore` used to get past strict mode.
- The TS side quietly drops the hard parts (claim token, reaper, retries) that make the Laravel
  version worth showing.

## Constraints

- Docker only; nothing installed locally beyond Docker (pnpm via corepack for local dev is fine).
- Node 24 (matches `apps/web`), pnpm, ESM.
- The web container proxies `/api/` to `http://api:8000` (`apps/web/nginx.conf`). The TS API
  service is therefore also named `api` and listens on 8000 inside its compose project, so the
  web image is reused unchanged.

## Approaches considered

| Option | Trade-off | Verdict |
|---|---|---|
| **Fastify** | Streams multipart uploads, built-in schema validation, `inject()` for tests, strong TS types. Less structure out of the box than Laravel. | **Chosen** by you. |
| NestJS | Most Laravel-like (modules, DI), easy side-by-side reading. Heavy for three endpoints; framework ceremony hides the interesting parts. | Rejected. |
| Hono | Light and modern, but typical multipart parsing buffers the whole body in memory; thinner server ecosystem. | Rejected. |
| Express | Weakest strict-TS story, nothing the others lack. | Rejected. |

Running it: a separate compose file with its own project name (chosen) rather than a profile in
the existing file, so the two stacks share nothing and the Laravel `docker compose up` stays
exactly as it is.

## Design

### Layout

```
apps/api-ts/
  src/
    config.ts            env parsing (zod), typed config object; same names/defaults as config/images.php
    db/schema.ts         Drizzle schema for image_jobs (same columns as the Laravel migration)
    db/migrations/       drizzle-kit generated SQL
    jobs/repository.ts   claim / markCompleted / markFailed as single conditional UPDATEs
    jobs/errors.ts       ImageErrorCode + messages (same strings), PermanentImageFailure
    images/processor.ts  sharp pipeline
    images/runner.ts     claim → process → complete for one delivery (testable with explicit attempt)
    http/app.ts          buildApp(): Fastify instance, routes, error handler
    http/routes/images.ts
    queue.ts             BullMQ queue + connection
    worker.ts            entry: BullMQ Worker
    scheduler.ts         entry: reaper every minute, cleanup hourly, no overlap
    server.ts            entry: run migrations if RUN_MIGRATIONS, listen on :8000
  test/                  Vitest
  Dockerfile             base (deps) / app (built) targets, like apps/api
docker-compose.ts.yml
```

### Libraries (my calls)

- **Fastify 5**, `@fastify/multipart` (streamed to disk, `fileSize` limit), JSON schemas via
  `@fastify/type-provider-typebox` or zod — builder's choice, one of them.
- **BullMQ** on Redis for the queue. **sharp** (libvips) for images. **file-type** for content
  sniffing. **Drizzle ORM** + `pg` for Postgres. **pino** (Fastify's logger) to stderr.
- **Vitest** for tests.

### HTTP contract (mirror of `apps/api`)

- `POST /api/images` (field `image`): validate size first, then type sniffed from content
  (jpg/png/webp only; extension and client MIME ignored). Store at `uploads/{uuidv7}.{ext}`,
  insert `pending` row, enqueue, return 202 `{job_id, status, status_url, created_at}` with
  `Location`. Queue down → mark row `queue_unavailable`, 503 with `error.job_id`.
  Missing file / over 20 MB / wrong type → 422 `validation_failed` with the same messages and a
  `fields.image` array. Over ~26 MB is stopped by nginx with 413 as today.
  Original name sanitised as in `sanitiseName` (basename, strip control chars, ≤200 chars, `image` fallback).
- `GET /api/images/:id` → same JSON as `ImageJobResource`. Non-UUID or unknown id → 404 `not_found`.
- `GET /api/images/:id/download` → 410 `expired`, 409 `not_ready` (same message incl. status), or
  200 `image/webp` with `Content-Disposition` attachment `{original basename}.webp`, non-ASCII safe.
- `GET /up` health check. Unhandled errors → 500 `internal_error` with the same message.

### Worker and the claim token

The Laravel design uses the queue attempt number as a claim token: each delivery carries a
number that goes up on every retry *and* every redelivery after a crash; a row can only be
claimed by a higher number and only completed by its current owner.

In BullMQ, `attemptsMade` does **not** increase when a crashed worker's job is recovered as
stalled, so it can't be the token. Use **`job.attemptsStarted`** (increments every time the job
becomes active, including after a stall). Retries: `attempts: 3`, custom backoff 5 s then 15 s.
Set `maxStalledCount` so a stalled job is redelivered rather than failed outright, and make sure
total deliveries still stop at 3 — the builder decides the exact mechanics and documents them.
The `retries_exhausted` message says "after 3 attempts", so the count must really be 3.

- Permanent failures (`corrupt_image`, `unsupported_image`, `dimensions_too_large`) →
  mark failed and throw BullMQ's `UnrecoverableError` so it isn't retried.
- Transient errors → rethrow; on the final failure, mark `retries_exhausted`.
- 120 s limit per attempt: sharp's `.timeout({ seconds: 120 })`, plus the worker lock long
  enough that a running job isn't treated as stalled.
- Graceful shutdown on SIGTERM: `worker.close()` finishes the current job (compose
  `stop_grace_period: 130s`, same as Laravel).
- `IMAGE_PROCESSING_DELAY_MS` honoured for the crash-recovery demo.

### Image pipeline (sharp)

Header check first (`sharp(...).metadata()`): unreadable → `corrupt_image`; not jpeg/png/webp →
`unsupported_image`; width×height > `IMAGE_MAX_PIXELS` → `dimensions_too_large`. Then
`sharp(path, { limitInputPixels, failOn: 'error', pages: 1 })` → `.rotate()` (EXIF) →
`.toColourspace('srgb')` → `.resize(max, max, { fit: 'inside', withoutEnlargement: true })` →
`.webp({ quality })` (metadata stripped by default) → write `{dest}.tmp`, rename into place,
delete tmp on failure. Report original width/height *after* orientation.

### Scheduler

One long-running process: reaper every minute, cleanup hourly, each guarded against overlap.
Reaper and cleanup are the same queries as `ReapStaleImageJobs` and `CleanupImageJobs`, with
`MAX_TRIES = 3`.

### Compose

`docker-compose.ts.yml`, `name: image-processor-ts`: `postgres`, `redis`, `api`, `worker`,
`scheduler`, `web` (built from `./apps/web`, unchanged), and an `api-test` service under the
`test` profile. Host ports **8081** (web) and **8001** (API) so both stacks can run at once.
Own named volumes. Same healthchecks and `depends_on` pattern as the Laravel file.

### Smoke test

`scripts/smoke.sh` already reads `BASE_URL`. It generates its test JPEG with
`docker compose exec worker php …`, which doesn't exist in the TS stack. Change it to generate
the image in a way that works for both (e.g. a `COMPOSE_FILE`-aware step that uses `node` + sharp
in the TS worker, or a generator that needs neither). Usage:
`BASE_URL=http://localhost:8081 COMPOSE_FILE=docker-compose.ts.yml bash scripts/smoke.sh`.

### Tests

Port the PHPUnit feature cases one-for-one into Vitest (state machine, upload, show, download,
worker transforms, reaper, cleanup), run against a real Postgres test DB and Redis inside
Docker: `docker compose -f docker-compose.ts.yml --profile test run --rm api-test`. Plus
`tsc --noEmit` and ESLint (`typescript-eslint` strict-type-checked) in that run.

### Docs

README is restructured so each backend has its own section (your decision):

- **Shared top part:** what the system does, the state diagram, the HTTP API contract, the
  frontend, and a "pick a backend" note with both run commands and ports.
- **Laravel backend section:** everything Laravel-specific that's there today (quick start,
  tests, env vars, architecture, "why these pieces", decisions and trade-offs, layout of `apps/api`).
- **Fastify backend section:** the same headings for the TS stack (quick start on 8081/8001,
  tests, env vars, architecture, why BullMQ/sharp/Drizzle, decisions such as `attemptsStarted`
  as the claim token, layout of `apps/api-ts`).
- **Comparison:** a short side-by-side table of how each concern is handled in Laravel vs Fastify.

Root `package.json` gets `up:ts`, `down:ts`, `test:api-ts`, `smoke:ts`.

## Calls settled after review (mine — check these)

- **Timestamps** are formatted like Laravel's `toJSON()` (six fractional digits,
  `2026-11-20T10:00:00.000000Z`), not JS's three, so JSON output really matches.
- **Exactly 3 deliveries.** BullMQ's `attempts: 3` counts failures only; a stall plus two failures
  would make 4. The worker enforces "at most 3 starts" itself using `attemptsStarted` (e.g. a 4th
  start marks `retries_exhausted` and stops). The reaper's `attempts >= 3` rule then carries over as is.
- **Queue down → 503, not a hang.** The enqueue path uses a Redis connection with the offline
  queue disabled and a short timeout, so a dead Redis fails fast into `queue_unavailable`.
- **Direct calls to :8001 (no nginx).** Multipart `fileSize` limit of 20 MB returns the 422
  "File is larger than 20 MB."; a hard body limit at ~26 MB returns 413 `file_too_large`, the same
  shape Laravel uses for `PostTooLargeException`.
- **Smoke script** uses `php` in the worker twice: to generate the input and to check the output's
  dimensions. Both steps get replaced with something that works against either stack.
- **Test database**: the TS compose file reuses `docker/postgres/init-test-db.sh`. Only
  `image_jobs` is migrated; Laravel's users/cache/jobs tables aren't needed.

## Left to the builder

- TypeBox vs zod for request/response schemas.
- Exact BullMQ stall/attempt settings, as long as the claim-token rules and the "3 attempts" limit hold.
- How test fixtures are produced (generated with sharp in tests is fine).
- Migration runner details (drizzle-kit migrate at API start when `RUN_MIGRATIONS=true`).
