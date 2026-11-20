# Image Processor — async worker architecture

Upload a JPG, PNG or WebP (up to 20 MB). The API stores it and answers **immediately** with a `job_id`. A separate **queue worker** then resizes it to at most 1280 px on the longest side, compresses it at quality 80 and converts it to WebP. The React frontend polls with exponential backoff and offers the download as soon as the job completes, or shows a clear error if it fails.

```
pending ──► processing ──► completed
                      └──► failed
```

The same React frontend runs unchanged against **two interchangeable backends**. They implement the same HTTP contract, use the same database table and follow the same failure rules:

- **Laravel** (`apps/api`): Laravel 13 on PHP 8.4 (FrankenPHP), Redis queue, Intervention Image / Imagick.
- **Fastify** (`apps/api-ts`): strict TypeScript on Node 24, Fastify 5, BullMQ on Redis, sharp, Drizzle ORM.

Both sit on Postgres and Redis behind an nginx container that serves the SPA and proxies `/api`.

## Pick a backend

Requirements: Docker (with Compose v2). Nothing else needs to be installed locally.

| | Laravel | Fastify (TypeScript) |
|---|---|---|
| Start | `docker compose up --build` | `docker compose -f docker-compose.ts.yml up --build` |
| App (SPA + `/api`) | http://localhost:8080 | http://localhost:8081 |
| API directly | http://localhost:8000 | http://localhost:8001 |
| Stop | `docker compose down` | `docker compose -f docker-compose.ts.yml down` |
| Backend tests | `docker compose --profile test run --rm api-test` | `docker compose -f docker-compose.ts.yml --profile test run --rm api-test` |

Both stacks can run **at the same time**. They use different compose project names, ports and volumes, so they never share data. The root `package.json` has shortcuts: `up`, `down`, `test:api` and `smoke` for Laravel, and `up:ts`, `down:ts`, `test:api-ts` and `smoke:ts` for Fastify. `smoke:ts` works from any shell, including cmd.exe and PowerShell (it needs `bash` on the PATH, which Git for Windows provides).

## HTTP API contract

Both backends answer identically: same keys, same status codes, same error messages.

| Endpoint | Success | Errors |
|---|---|---|
| `POST /api/images` (multipart field `image`) | **202** `{job_id, status: "pending", status_url, created_at}` | 422 `validation_failed` (missing file, not a JPG/PNG/WebP, over 20 MB) · 413 `file_too_large` (body over ~26 MB) · 503 `queue_unavailable` |
| `GET /api/images/{id}` | 200 `{job_id, status, attempts, original{name,mime,size,width,height}, result{size,width,height} or null, download_url or null, error{code,message} or null, expired, created_at, started_at, completed_at, failed_at}` | 404 `not_found` (unknown or malformed id) |
| `GET /api/images/{id}/download` | 200 `image/webp`, named `{original-name}.webp` | 404 `not_found` · 409 `not_ready` · 410 `expired` |

Every error has the shape `{"error": {"code", "message", …}}`. Timestamps are ISO 8601 with six fractional digits (`2026-11-20T10:00:00.000000Z`). A failed job carries one of these error codes: `corrupt_image`, `unsupported_image`, `dimensions_too_large`, `retries_exhausted`, `worker_lost`, `queue_unavailable`.

## Frontend

React 19 + Vite + TypeScript (pnpm), served by nginx, which proxies `/api` to the chosen backend (same origin, so no CORS). The frontend doesn't know which backend it talks to.

```bash
# Frontend tests: Vitest (uses corepack, so no global pnpm install is needed)
corepack pnpm --dir apps/web install
corepack pnpm --dir apps/web test
```

### Frontend polling strategy


- The first poll is at **500 ms**. Each next delay is **×1.5**, **capped at 5 s**, with **±20 % jitter** so many open tabs don't poll in lockstep. A typical job finishes within the first few polls, and a long one costs at most one request every ~5 s.
- **Polling pauses while the tab is hidden** (Page Visibility API) and resumes instantly when you come back.
- **Network or server errors** keep backing off and show "Connection lost, retrying…", so it survives an API restart.
- After **10 minutes** it gives up with a "Still processing — check back later" message and a Refresh button.
- **Reloading the page resumes polling** for the current job (its id is kept in `localStorage`): the job lives on the server, independent of the browser.
- When the job completes, the card switches to the download state, the tab title becomes "✓ Ready", and a screen-reader live region announces it.

Polling (rather than WebSockets/SSE) matches the brief and needs no extra infrastructure. With backoff and visibility pausing, it's cheap.

---

# Laravel backend

**Stack:** Laravel 13 on PHP 8.4 (FrankenPHP) · Redis queue · Postgres · Intervention Image / Imagick · Docker Compose.

## Quick start

Requirements: Docker (with Compose v2). Nothing else needs to be installed locally.

```bash
docker compose up --build
```

Open **http://localhost:8080** and drop in an image.

The first build takes a minute or two. The API is also exposed on **http://localhost:8000** if you'd like to use curl:

```bash
curl -F image=@photo.jpg http://localhost:8000/api/images
# → 202 {"job_id":"…","status":"pending","status_url":"/api/images/…"}
curl http://localhost:8000/api/images/<job_id>
curl -OJ http://localhost:8000/api/images/<job_id>/download
```

Scale the workers horizontally:

```bash
docker compose up -d --scale worker=3
```

Stop everything with `docker compose down`. Add `-v` to also delete the database, the queue and the stored images.

## Running the tests

```bash
# Backend: PHPUnit against a real Postgres test database, inside a container (no local PHP needed)
docker compose --profile test run --rm api-test

# Frontend: Vitest (uses corepack, so no global pnpm install is needed)
corepack pnpm --dir apps/web install
corepack pnpm --dir apps/web test

# End-to-end: with the stack running, upload → poll → download → verify WebP 1280px
bash scripts/smoke.sh
```

| Layer | What is covered |
|---|---|
| State machine | The claim token: duplicate deliveries are no-ops, retries take over, a stale owner can't overwrite the result, terminal rows never change |
| API | 202 + `job_id` for JPG/PNG/WebP and uppercase extensions; the 20 MB limit; wrong type; a text file renamed to `.jpg` (content sniffing); 503 when the queue is down; status shape in every state; 404 for unknown and malformed ids; download 409/410/200; non-ASCII download filenames |
| Worker | Landscape/portrait → 1280; tall-narrow (100×5000 → 26×1280); no upscaling; WebP output; quality setting reaches the encoder; PNG transparency kept; CMYK → sRGB; EXIF orientation; metadata stripped; first frame of animations; corrupt file; unsupported format; >50 MP; no partial files left behind; permanent failures not retried; `retries_exhausted` message |
| Recovery & retention | The reaper fails orphaned `processing` jobs (final attempt after 10 min, earlier attempts only after 1 h, so queued retries survive a backlog), never `pending` or finished ones, and is scheduled every minute. Cleanup expires finished jobs after 24 h (files deleted, 410 on download), never touches unfinished ones, and is idempotent |
| Frontend | Backoff sequence (cap, jitter), stop on done, error backoff, pause while the tab is hidden, give-up, cancel; client validation; API error mapping (413, 422, 404, network); resume-after-reload storage (corrupt or unavailable storage) |

## Environment variables

`docker compose up` works without any `.env` file. Every variable has a default in `docker-compose.yml`. To override one, copy `.env.example` to `.env` and edit it.

| Variable | Default | Purpose |
|---|---|---|
| `APP_KEY` | demo key baked into compose | Laravel encryption key. **Set your own outside this demo.** |
| `APP_ENV` / `APP_DEBUG` | `production` / `false` | Laravel environment. Debug mode shows exception details in API errors. |
| `LOG_LEVEL` | `info` | Logs go to stderr (`docker compose logs worker`). |
| `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | `images`, `images`, `secret` | Postgres credentials (shared by the `postgres` container and the app). |
| `DB_HOST`, `DB_PORT`, `REDIS_HOST`, `REDIS_PORT`, `QUEUE_CONNECTION` | `postgres`, `5432`, `redis`, `6379`, `redis` | Wiring between containers (set in compose). |
| `REDIS_QUEUE_RETRY_AFTER` | `150` | Seconds before a reserved-but-unfinished job is handed out again. Must be greater than the worker's 120 s timeout. |
| `IMAGE_MAX_UPLOAD_KB` | `20480` | Upload limit (20 MB). |
| `IMAGE_MAX_DIMENSION` | `1280` | Longest side of the output. |
| `IMAGE_QUALITY` | `80` | WebP quality. |
| `IMAGE_MAX_PIXELS` | `50000000` | Inputs above 50 MP are rejected (guards against decompression bombs). |
| `IMAGE_STALE_AFTER_SECONDS` | `600` | The reaper fails a job on its final attempt whose claim is older than this. |
| `IMAGE_LOST_AFTER_SECONDS` | `3600` | The reaper fails a job on an earlier attempt (retry still queued) only after this long, when its queue message must have been lost. |
| `IMAGE_RETENTION_HOURS` | `24` | Hourly cleanup deletes files of finished jobs older than this. The download then answers 410 Gone. |
| `IMAGE_PROCESSING_DELAY_MS` | `0` | **Demo only.** Adds an artificial delay inside the worker so you can watch the states change or kill a worker mid-job. |
| `VITE_API_BASE_URL` | `/api` | Frontend build-time API base. |
| `VITE_API_PROXY` | `http://localhost:8000` | Where `pnpm dev` proxies `/api` (local frontend development only). |

---

## Architecture

```
 Browser (React SPA)
     │  GET /            static files
     │  /api/*           proxied by nginx (same origin → no CORS)
     ▼
 ┌─────────┐        ┌────────────┐  1. INSERT image_jobs (pending)   ┌──────────┐
 │   web   │ ─────► │    api     │ ────────────────────────────────► │ postgres │
 │ (nginx) │        │ Laravel    │  2. RPUSH ProcessImage ─┐         └──────────┘
 └─────────┘        └─────┬──────┘                         ▼              ▲
                          │ store upload            ┌───────────┐          │ claim / complete / fail
                          ▼                         │   redis   │          │ (conditional UPDATEs)
                  ┌───────────────┐                 │   queue   │ ──pop──► ┌───────────┐
                  │ images volume │ ◄───────────────┴───────────┘          │  worker   │ ×N
                  │ uploads/      │ ◄─── read original, write result ───── │ queue:work│
                  │ results/      │                                        │ Imagick   │
                  └───────────────┘                                        └───────────┘
                                                                           ┌───────────┐
                                                                           │ scheduler │ reaper (1 min), cleanup (1 h)
                                                                           └───────────┘
```

### Request flow

1. **Upload:** `POST /api/images`. Laravel validates the type (by sniffing the content, not trusting the extension) and the size. It stores the original at `uploads/{id}.{ext}`, inserts a `pending` row and pushes a `ProcessImage` message to the `images` queue in Redis. It responds **202** with `job_id`. No image decoding happens in the request: a 12 MB photo is acknowledged in well under a second.
2. **Process:** a worker pops the message. It claims the row (`processing`), decodes, auto-orients, resizes, encodes WebP at quality 80, writes `results/{id}.webp` atomically (temp file + rename), and marks the row `completed`.
3. **Poll:** `GET /api/images/{id}` returns the status, attempt count, original and result dimensions, and either `download_url` or `error {code, message}`.
4. **Download:** `GET /api/images/{id}/download` streams the WebP as `{original-name}.webp`. It returns 409 if the job isn't finished yet.
5. **Cleanup:** every hour, `images:cleanup` deletes the files of finished jobs older than 24 h and marks them expired. The row is kept, so the API answers **410 Gone** rather than 404 and the UI says the result has expired.

### Why these pieces

- **A queue + a separate worker container.** This is the standard pattern for CPU-heavy work. The HTTP tier stays fast and cheap, and you can scale the worker tier on its own (`--scale worker=N`). A slow or crashing image never takes the API down with it. The `api` and `worker` containers run the **same Laravel image** with different commands. That's how Laravel teams ship this in practice: the job class is shared code, but only the worker process ever executes it. I considered a standalone Node/Go worker instead. It would mean two codebases writing one table, and Laravel's retry/timeout/failure handling would have to be rebuilt, so I didn't.
- **Redis as the queue, Postgres as the record.** Redis is built for moving messages: blocking pops, reservations with expiry. It runs with AOF persistence, so queued jobs survive a restart. Postgres is the durable source of truth for job state, which the API reads and the worker writes. Keeping state out of the queue means a status request never depends on queue internals.
- **FrankenPHP** serves the API (a production web server, not `artisan serve`). It runs in the same image as the worker. The worker image includes `pcntl`, so `queue:work` can enforce the 120 s timeout and finish the current job on SIGTERM (`stop_grace_period: 130s`).
- **nginx in front of the SPA** proxies `/api`. The browser sees a single origin, so there's no CORS. It also streams uploads through without buffering them to disk.

### Job lifecycle and failure handling

Every state change is a **single conditional `UPDATE`**, so concurrent or duplicate deliveries can't corrupt state:

| Transition | Guard |
|---|---|
| claim → `processing` | `status IN (pending, processing) AND attempts < :n`, where `:n` is this delivery's queue attempt number |
| → `completed` | `status = processing AND attempts = :n` (only the current owner) |
| → `failed` | `status IN (pending, processing)` |

The queue attempt number works as a **claim token**. Laravel's Redis queue increments it atomically every time a message is reserved. A genuine retry always carries a higher number and can take over a job a dead worker left in `processing`. A duplicate message cannot. A slow, stale worker that lost ownership can't overwrite the newer owner's result. The status never moves backwards. A retry stays `processing`, and the UI shows "attempt 2 of 3".

| Failure | What happens |
|---|---|
| **Bad input** (corrupt, unsupported, >50 MP) | Fails **immediately** with a specific message. Retrying can't fix it. |
| **Transient error** (I/O, DB hiccup) | Retried up to 3 attempts, with 5 s and 15 s backoff. Then `failed` / "couldn't process this image after 3 attempts". |
| **Worker stopped gracefully** (deploy, `docker compose stop`) | `queue:work` finishes the current job before exiting. |
| **Worker killed mid-job** (OOM, SIGKILL, host crash) | The message stays reserved in Redis. After `retry_after` (150 s), the next worker that polls the queue moves the expired reservation back onto the queue. It re-reserves it with a higher attempt number, re-claims the row and finishes. After 3 attempts the job is marked `failed`. |
| **Job orphaned anyway** (all workers down past the last attempt, queue data lost) | The scheduler runs `images:reap-stale` every minute and fails orphaned `processing` rows with "Processing didn't finish in time". On the **final attempt** that happens 10 min after its claim, because no retry is coming. On **earlier attempts** a retry is still queued, maybe behind a backlog, so it waits **1 h** and assumes the queue message was lost only then. **`pending` rows are never reaped**: a backlog behind busy workers is normal, not a failure. |
| **Queue unreachable at upload time** | The row is marked `failed` (`queue_unavailable`) and the API returns 503, so the job never sits in `pending` with no message behind it. |

#### Try the crash recovery yourself

```bash
# 1. Give the worker a 20 s artificial delay so there's time to kill it
IMAGE_PROCESSING_DELAY_MS=20000 docker compose up -d worker

# 2. Upload an image in the UI (or with curl), then within 20 s:
docker compose kill worker
docker compose start worker

# 3. Watch: the job stays "processing" (attempt 1), then after ~150 s it is
#    picked up again as attempt 2 and completes.

# 4. Back to normal
docker compose up -d worker
```


### Decisions and trade-offs

- **pnpm, no Turborepo.** pnpm has fast, strict and disk-efficient installs and is the established choice for Vite projects. Bun's main advantage is raw install speed, which barely matters with one small package. I didn't use Turborepo because it orchestrates *JavaScript* packages, and this repo has exactly one (the PHP side is managed by Composer inside Docker). It would have been ceremony without benefit. The root `package.json` just holds convenience scripts.
- **"Compress to 80 %, then convert to WebP" is one encode.** Encoding WebP at quality 80 *is* the compression. Compressing to JPEG first and then re-encoding to WebP would lose quality twice and gain nothing.
- **Never upscale.** Images already under 1280 px keep their size and are only re-encoded.
- **EXIF orientation is applied, then metadata stripped.** Phone photos come out the right way up, and location data is removed.
- **Output dimensions are reported as displayed**, after orientation.
- **Content sniffing at upload.** A `.jpg` that isn't really an image is rejected with a 422 before anything is queued.
- **Two size limits.** Laravel enforces the 20 MB rule with a friendly 422. The web servers stop anything above ~26 MB with a 413, so oversized bodies never reach PHP. The frontend shows the same "larger than 20 MB" message for both.
- **Local shared volume for files.** It's simple and works with one command. In production this would be S3 (or similar), so workers on other hosts can reach the files.
- **UUIDv7 job ids.** They're unguessable enough for a demo without auth, and time-ordered for index locality.
- **Tests hit a real Postgres** (a separate `images_test` database), so UUID casting and the conditional updates behave as in production.

### What I'd do next (deliberately out of scope for the time budget)

- **S3 + presigned URLs:** upload straight to object storage and download from a CDN.
- **Laravel Horizon** for queue metrics and dashboards, plus alerting on failed-job rate and queue depth.
- **Auth and per-user job lists, rate limiting, and virus scanning** of uploads.
- **Server-Sent Events** as a push channel, keeping polling as the fallback.
- **Component tests** for the React UI (MSW-mocked API).

## Layout of `apps/api`

```
apps/api/        Laravel API + worker (one image, different commands)
  app/Http/        controller, request validation, resource, error shape
  app/Jobs/        ProcessImage (queue job: retry/fail policy)
  app/Images/      ImageJobRunner (claim → process → complete), ImageProcessor (the transform)
  app/Models/      ImageJob (guarded state transitions)
  app/Console/     images:reap-stale, images:cleanup
  docker/          Caddyfile, php.ini, entrypoint
```

---

# Fastify backend

**Stack:** Node 24 · pnpm · TypeScript (strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`) · Fastify 5 + `@fastify/multipart` · BullMQ 6 on Redis · sharp · file-type · Drizzle ORM + pg · zod · croner · pino · Vitest · Postgres · Docker Compose.

TypeScript 7 compiles and type-checks the project. `typescript-eslint` doesn't support TypeScript 7 yet, so `typescript` is aliased to `@typescript/typescript6` for the linter, and `@typescript/native` provides TypeScript 7 for `tsc`. Both are pinned in `apps/api-ts/package.json`.

## Quick start

```bash
docker compose -f docker-compose.ts.yml up --build
```

Open **http://localhost:8081** and drop in an image. The API is also exposed on **http://localhost:8001**:

```bash
curl -F image=@photo.jpg http://localhost:8001/api/images
# → 202 {"job_id":"…","status":"pending","status_url":"/api/images/…","created_at":"…"}
curl http://localhost:8001/api/images/<job_id>
curl -OJ http://localhost:8001/api/images/<job_id>/download
```

Scale the workers horizontally:

```bash
docker compose -f docker-compose.ts.yml up -d --scale worker=3
```

Stop everything with `docker compose -f docker-compose.ts.yml down`. Add `-v` to also delete the database, the queue and the stored images. The Laravel stack keeps its own volumes, so this doesn't touch it.

## Running the tests

```bash
# Backend: typecheck + lint + Vitest against a real Postgres (images_test) and a real Redis, inside a container
docker compose -f docker-compose.ts.yml --profile test run --rm api-test

# End-to-end: with the stack running (needs `bash`, e.g. Git Bash on Windows), upload → poll → download → verify WebP 1280px
bash scripts/smoke.sh --ts
```

The same `scripts/smoke.sh` serves both stacks. `--ts` is shorthand for `BASE_URL=http://localhost:8081 COMPOSE="docker compose -f docker-compose.ts.yml"`; if you set `BASE_URL` and `COMPOSE` yourself they must point at the same stack. The stack is taken from `COMPOSE` (or an explicit `STACK=ts|php`), and the script fails early if that stack's worker container is not running.

| Layer | What is covered |
|---|---|
| Config | Defaults for an empty environment, overrides, non-integer values rejected |
| State machine (`JobRepository`) | The claim token: same or lower attempt rejected, higher attempt takes over, only the current owner can complete, terminal rows never change |
| Delivery policy (`handleDelivery`) | Success; permanent failure without retry; transient error rethrown on attempt 1 and `retries_exhausted` on attempt 3; takeover after a crash; a 4th start fails the job without processing it; a real BullMQ queue end to end |
| API | 202 for JPG/PNG/WebP and uppercase extensions; the 20 MB limit; wrong type; a text file renamed to `.jpg`; 503 when the queue is down, including a real Redis outage answering within 2.5 s; a body over 26 MB gets 413; no file left behind after an over-limit or aborted upload; status shape in every state; 404 for unknown and malformed ids; download 409/410/200; non-ASCII download filenames |
| Image processor | Landscape/portrait → 1280; tall-narrow; no upscaling; WebP output; quality setting reaches the encoder; PNG transparency kept; CMYK → sRGB; EXIF orientation; metadata stripped; first frame of animations; corrupt, unsupported and >50 MP inputs; no partial files left behind; timeouts and filesystem errors are not treated as permanent |
| Recovery & retention | The reaper fails orphaned `processing` jobs (final attempt after 10 min, earlier attempts only after 1 h), never `pending` or finished ones; cleanup expires finished jobs after 24 h and never touches unfinished ones; both are idempotent; schedules are every minute and hourly |

## Environment variables

`docker compose -f docker-compose.ts.yml up` works without any `.env` file. Every variable has a default in `docker-compose.ts.yml` (and again in `src/config.ts`, which validates them with zod at start-up). To override one, copy `.env.example` to `.env` and edit it. The same file feeds both stacks; the Laravel-only entries (`APP_*`) are ignored here.

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | pino log level. Logs are JSON on stderr (`docker compose -f docker-compose.ts.yml logs worker`). |
| `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | `images`, `images`, `secret` | Postgres credentials (shared by the `postgres` container and the app). |
| `DB_HOST`, `DB_PORT`, `REDIS_HOST`, `REDIS_PORT` | `postgres`, `5432`, `redis`, `6379` | Wiring between containers (set in compose; outside compose the code defaults to `localhost`). |
| `RUN_MIGRATIONS` | `true` on `api`, `false` elsewhere | The `api` container applies the Drizzle migrations at start-up. |
| `IMAGE_STORAGE_PATH` | `/app/storage/images` | Where `uploads/` and `results/` live (the shared `images-data` volume). |
| `IMAGE_MAX_UPLOAD_KB` | `20480` | Upload limit (20 MB). |
| `IMAGE_MAX_DIMENSION` | `1280` | Longest side of the output. |
| `IMAGE_QUALITY` | `80` | WebP quality. |
| `IMAGE_MAX_PIXELS` | `50000000` | Inputs above 50 MP are rejected (guards against decompression bombs). |
| `IMAGE_STALE_AFTER_SECONDS` | `600` | The reaper fails a job on its final attempt whose claim is older than this. |
| `IMAGE_LOST_AFTER_SECONDS` | `3600` | The reaper fails a job on an earlier attempt (retry still queued) only after this long, when its queue message must have been lost. |
| `IMAGE_RETENTION_HOURS` | `24` | Hourly cleanup deletes files of finished jobs older than this. The download then answers 410 Gone. |
| `IMAGE_PROCESSING_DELAY_MS` | `0` | **Demo only.** Adds an artificial delay inside the worker so you can watch the states change or kill a worker mid-job. |

There is no equivalent of Laravel's `REDIS_QUEUE_RETRY_AFTER`: BullMQ detects a dead worker through lock expiry and stall checks instead (see below).

---

## Architecture

```
 Browser (React SPA)
     │  GET /            static files
     │  /api/*           proxied by nginx (same origin → no CORS)
     ▼
 ┌─────────┐        ┌────────────┐  1. INSERT image_jobs (pending)   ┌──────────┐
 │   web   │ ─────► │    api     │ ────────────────────────────────► │ postgres │
 │ (nginx) │        │ Fastify    │  2. queue.add(process-image) ─┐   └──────────┘
 └─────────┘        └─────┬──────┘                               ▼        ▲
                          │ stream upload to disk         ┌───────────┐   │ claim / complete / fail
                          ▼                               │   redis   │   │ (conditional UPDATEs)
                  ┌───────────────┐                       │  (BullMQ) │ ──┴─────► ┌───────────┐
                  │ images volume │ ◄─────────────────────┴───────────┘           │  worker   │ ×N
                  │ uploads/      │ ◄─── read original, write result ───────────  │ BullMQ    │
                  │ results/      │                                               │ sharp     │
                  └───────────────┘                                               └───────────┘
                                                                                  ┌───────────┐
                                                                                  │ scheduler │ reaper (1 min), cleanup (1 h)
                                                                                  └───────────┘
```

One image, three commands: `node dist/server.js` (api), `node dist/worker.js` and `node dist/scheduler.js`. Compose runs them as the `api`, `worker` and `scheduler` services.

### Request flow

1. **Upload:** `POST /api/images`. Fastify streams the `image` part to `uploads/{id}.part` on disk, so nothing is buffered in memory. It then sniffs the content with `file-type` (the extension and client MIME type are ignored), renames the file to `uploads/{id}.{ext}`, inserts a `pending` row and adds a `process-image` job to the `images` queue in Redis. It responds **202** with `job_id`. A body whose `content-length` is above 26 MB is refused with 413 before it is read; a file between 20 and 26 MB gets the friendly 422. Temp files are removed on every failure path (rejected type, too large, client disconnect, enqueue failure). No image decoding happens in the request.
2. **Process:** a worker takes the job. It claims the row (`processing`), reads the header to check the format and size, then runs one sharp pipeline: auto-orient, convert to sRGB, resize to fit 1280 px, encode WebP at quality 80. It writes `results/{id}.webp` atomically (temp file + rename) and marks the row `completed`.
3. **Poll:** `GET /api/images/{id}` returns the status, attempt count, original and result dimensions, and either `download_url` or `error {code, message}`.
4. **Download:** `GET /api/images/{id}/download` streams the WebP as `{original-name}.webp`. It returns 409 if the job isn't finished yet.
5. **Cleanup:** every hour the scheduler deletes the files of finished jobs older than 24 h and marks them expired. The row is kept, so the API answers **410 Gone** rather than 404.

### Why these pieces

- **A queue + a separate worker container.** Same reasoning as in the Laravel section: the HTTP tier stays fast, the worker tier scales on its own (`--scale worker=N`), and a slow or crashing image never takes the API down. The `api`, `worker` and `scheduler` containers run the **same image** with different commands, so the job code is shared but only the worker process executes it.
- **BullMQ on Redis.** Fastify has no queue of its own, so I needed a library. BullMQ gives me delayed retries with custom backoff, a lock/stall mechanism that redelivers a job whose worker died, graceful close that waits for the job in progress, and an attempt counter that works as a claim token (see decisions). Redis was already in the stack for Laravel, so both backends use the same kind of infrastructure. The producer uses its own Redis connection with the offline queue disabled, so a dead Redis fails fast instead of hanging a request.
- **sharp (libvips).** Fast, low memory, and it streams. It supports the same transform in one pipeline: EXIF rotation, colour-space conversion, `fit: inside` resize without enlargement, WebP encoding. `limitInputPixels` guards against decompression bombs, and `.timeout()` bounds a single attempt.
- **Drizzle ORM + pg.** The schema is plain TypeScript, queries are typed, and the conditional `UPDATE`s of the state machine read almost like the SQL they produce. Migrations are generated by `drizzle-kit` into `src/db/migrations` and applied by the `api` container at start-up when `RUN_MIGRATIONS=true`. There is no query-builder magic hiding the guards.
- **zod** validates the environment at start-up, the route parameters and the queue payload, so bad input fails at the edge with a clear message instead of deep in a handler.
- **Fastify** keeps request handling small and fast and has first-class multipart streaming. The app is built by a `buildApp()` factory, so tests can drive it with `inject()` and fake dependencies.
- **croner** runs the two maintenance tasks inside a small `scheduler` process. Each task uses `protect: true` so a slow run is never overlapped by the next tick. Run one scheduler only.
- **nginx in front of the SPA** uses the same config as the Laravel stack (`proxy_pass http://api:8000`). In each compose file the service name `api` resolves to that stack's own API.

### Job lifecycle and failure handling

Every state change is a **single conditional `UPDATE`** in `JobRepository`, the same three guards as in the Laravel section: claim only moves `pending`/`processing` rows to a higher attempt number, completion needs `status = processing AND attempts = :n`, and failing is allowed from `pending`/`processing` only.

The claim token is BullMQ's **`job.attemptsStarted`**. It increments every time a job starts, including when a stalled job is redelivered after its worker died. `attemptsMade` would not work: it counts failed attempts only, so a redelivery after a crash would reuse the previous number and the retry could not take over the row. A genuine retry or redelivery always carries a higher number; a duplicate cannot, and a slow stale worker can't overwrite the newer owner's result.

BullMQ's `attempts` option is only a **ceiling** (`MAX_TRIES + 1`, so the library never gives up before the code does). The real "3 deliveries" limit is enforced in `handleDelivery`: a 4th start marks the job `retries_exhausted` without processing it, and a failure on the 3rd start does the same. Permanent failures throw BullMQ's `UnrecoverableError`, which stops retrying immediately.

| Failure | What happens |
|---|---|
| **Bad input** (corrupt, unsupported, >50 MP) | Fails **immediately** with a specific message (`corrupt_image`, `unsupported_image`, `dimensions_too_large`). Retrying can't fix it. Only clear decode failures count as permanent. |
| **Transient error** (I/O, DB hiccup, sharp timeout) | Retried up to 3 starts, with 5 s then 15 s backoff (measured: 5.4 s and 15.5 s). Then `failed` / "couldn't process this image after 3 attempts". Each attempt is limited to 120 s by sharp's `.timeout()`, and a timeout is retried, matching Laravel. |
| **Worker stopped gracefully** (deploy, `docker compose stop`) | `worker.close()` waits for the job in progress (`stop_grace_period: 130s`). |
| **Worker killed mid-job** (OOM, SIGKILL, host crash) | The job's lock expires and BullMQ's stall check puts it back on the queue (`maxStalledCount: 3`). In testing, a killed worker's job was redelivered after about 90 s (Laravel's `retry_after` is 150 s). It starts again with a higher `attemptsStarted`, re-claims the row and finishes. After 3 starts the job is marked `failed`. |
| **Job orphaned anyway** (all workers down past the last attempt, queue data lost) | The scheduler's reaper runs every minute and fails orphaned `processing` rows with "Processing didn't finish in time" (`worker_lost`): on the **final attempt** (`attempts >= 3`) 10 min after the claim, on **earlier attempts** only after **1 h**. **`pending` rows are never reaped.** |
| **Queue unreachable at upload time** | The row is marked `failed` (`queue_unavailable`) and the API returns 503 within about 2 s (producer connection with the offline queue disabled, plus a 2 s enqueue timeout). |

#### Try the crash recovery yourself

```bash
# 1. Give the worker a 20 s artificial delay so there's time to kill it
IMAGE_PROCESSING_DELAY_MS=20000 docker compose -f docker-compose.ts.yml up -d worker

# 2. Upload an image in the UI (or with curl), then within 20 s:
docker compose -f docker-compose.ts.yml kill worker
docker compose -f docker-compose.ts.yml start worker

# 3. Watch: the job stays "processing" (attempt 1), then after about 90 s it is
#    picked up again as attempt 2 and completes.

# 4. Back to normal
docker compose -f docker-compose.ts.yml up -d worker
```

### Decisions and trade-offs

- **The same product decisions as in the Laravel section.** One encode (WebP at quality 80 *is* the compression), never upscale, EXIF orientation applied then metadata stripped, dimensions reported as displayed, content sniffing at upload, local shared volume for files, UUIDv7 job ids, tests against a real Postgres. They hold for both backends.
- **`attemptsStarted` as the claim token, and a 3-delivery cap enforced in code.** See the lifecycle section above. BullMQ's own retry count can't express "at most 3 starts, stalls included", so I didn't lean on it.
- **Only decode failures are permanent.** This mirrors Laravel, where only the decoder exception skips retries. A timeout or a write error is rethrown and retried, so a transient problem can't permanently fail a good image. Errors from sharp are classified by message ("corrupt header", "read error", "premature end"…), except messages that start with `timeout:`.
- **Uploads stream to disk, then get sniffed.** The multipart `fileSize` limit gives the friendly 422 at 20 MB, an `onRequest` hook turns a `content-length` above 26 MB into a 413 before anything is read (the same shape Laravel uses for `PostTooLargeException`), and a disconnecting client leaves neither a row nor a file.
- **Timestamps look like Laravel's.** `toJSON()` prints six fractional digits (`.000000Z`), not JavaScript's three, so the JSON of both backends is identical.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on, and ESLint runs `typescript-eslint`'s `strictTypeChecked` rules with `any`, `@ts-` comments and type assertions banned. The TypeScript 7 / 6 split exists only because the linter lags behind the compiler.
- **One scheduler process.** The reaper and cleanup are idempotent, so a second scheduler wouldn't corrupt anything, but it would do the same work twice. Run one.
- **Tests hit a real Postgres and a real Redis** (a separate `images_test` database), so UUID handling, the conditional updates and the queue's retry options behave as in production. Only `image_jobs` is migrated; Laravel's users, cache and jobs tables aren't needed.

## Layout of `apps/api-ts`

```
apps/api-ts/     Fastify API + BullMQ worker + scheduler (one image, three commands)
  src/server.ts, worker.ts, scheduler.ts   entry points
  src/config.ts      zod-validated environment
  src/queue.ts       BullMQ producer (fail-fast) and worker (attemptsStarted → handleDelivery)
  src/http/          app factory, upload streaming, routes, resource, error shape
  src/jobs/          JobRepository (guarded transitions), handleDelivery (retry/fail policy), errors, time
  src/images/        runner (claim → process → complete), processor (the sharp transform)
  src/maintenance/   reap-stale, cleanup, croner schedule
  src/db/            Drizzle schema, client, migrations
  test/              Vitest suites mirroring src/
  scripts/           smoke-image.mjs (test image generator for scripts/smoke.sh)
```

---

# Laravel vs Fastify

| Concern | Laravel (`apps/api`) | Fastify (`apps/api-ts`) |
|---|---|---|
| HTTP framework | Laravel 13 on FrankenPHP | Fastify 5 |
| Validation | Form request (type sniffed from content, 20 MB rule) | `@fastify/multipart` limits + `file-type` sniffing; zod for env, params and queue payload |
| Upload handling | Stored with `storeAs` on the images disk; web servers refuse bodies above ~26 MB | Streamed to a `.part` file, sniffed, renamed; temp files removed on every failure path; `content-length` above 26 MB gets 413 before reading |
| Queue | Laravel Redis queue (`queue:work`) | BullMQ 6 on Redis |
| Retries / claim token | 3 tries, 5 s and 15 s backoff; the queue's attempt number is the claim token | 3 deliveries, 5 s and 15 s backoff; `job.attemptsStarted` is the claim token, and `handleDelivery` enforces the cap |
| Timeout | 120 s job timeout (`pcntl`); `retry_after` 150 s redelivers a killed worker's job | 120 s per attempt via sharp `.timeout()`; BullMQ stall detection redelivered a killed worker's job after about 90 s |
| Image library | Intervention Image on Imagick | sharp (libvips) |
| ORM / migrations | Eloquent, Laravel migrations | Drizzle ORM + pg, `drizzle-kit` migrations applied at `api` start |
| Scheduler | `schedule:work` runs `images:reap-stale` and `images:cleanup` | croner in a `scheduler` process (every minute, hourly, `protect: true`) |
| Logging | Laravel logging to stderr (`LOG_CHANNEL=stderr`) | pino, JSON on stderr |
| Tests | PHPUnit against a real Postgres | Vitest against a real Postgres and Redis, plus `tsc` and ESLint |

## Repository layout

```
apps/api/        Laravel API + worker (see its layout above)
apps/api-ts/     Fastify API + worker + scheduler (see its layout above)
apps/web/        React SPA + nginx config
docker/          Postgres init (test database), shared by both compose files
scripts/         smoke.sh, shared by both stacks
docs/design/     design document and implementation plan
docs/superpowers/ specs and plans for the TypeScript backend
```
