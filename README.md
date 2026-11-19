# Image Processor — async worker architecture

Upload a JPG, PNG or WebP (up to 20 MB). The API stores it and answers **immediately** with a `job_id`. A separate **queue worker** then resizes it to at most 1280 px on the longest side, compresses it at quality 80 and converts it to WebP. The React frontend polls with exponential backoff and offers the download as soon as the job completes, or shows a clear error if it fails.

```
pending ──► processing ──► completed
                      └──► failed
```

**Stack:** React 19 + Vite + TypeScript (pnpm) · Laravel 13 on PHP 8.4 (FrankenPHP) · Redis queue · Postgres · Intervention Image / Imagick · Docker Compose.

---

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
| Recovery | The reaper fails stale `processing` jobs only, never `pending` or finished ones, and is scheduled every minute |
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
| `IMAGE_STALE_AFTER_SECONDS` | `600` | The reaper fails `processing` jobs whose last claim is older than this. |
| `IMAGE_RETENTION_HOURS` | `24` | Reserved for result cleanup (see "What I'd do next"). |
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
                                                                           │ scheduler │ reaper, every minute
                                                                           └───────────┘
```

### Request flow

1. **Upload:** `POST /api/images`. Laravel validates the type (by sniffing the content, not trusting the extension) and the size. It stores the original at `uploads/{id}.{ext}`, inserts a `pending` row and pushes a `ProcessImage` message to the `images` queue in Redis. It responds **202** with `job_id`. No image decoding happens in the request: a 12 MB photo is acknowledged in well under a second.
2. **Process:** a worker pops the message. It claims the row (`processing`), decodes, auto-orients, resizes, encodes WebP at quality 80, writes `results/{id}.webp` atomically (temp file + rename), and marks the row `completed`.
3. **Poll:** `GET /api/images/{id}` returns the status, attempt count, original and result dimensions, and either `download_url` or `error {code, message}`.
4. **Download:** `GET /api/images/{id}/download` streams the WebP as `{original-name}.webp`. It returns 409 if the job isn't finished yet.

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
| **Job orphaned anyway** (all workers down past the last attempt, queue data lost) | The scheduler runs `images:reap-stale` every minute and fails `processing` rows whose last claim is older than 10 min with "Processing didn't finish in time". **`pending` rows are never reaped**: a backlog behind busy workers is normal, not a failure. |
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

### Frontend polling strategy

- The first poll is at **500 ms**. Each next delay is **×1.5**, **capped at 5 s**, with **±20 % jitter** so many open tabs don't poll in lockstep. A typical job finishes within the first few polls, and a long one costs at most one request every ~5 s.
- **Polling pauses while the tab is hidden** (Page Visibility API) and resumes instantly when you come back.
- **Network or server errors** keep backing off and show "Connection lost, retrying…", so it survives an API restart.
- After **10 minutes** it gives up with a "Still processing — check back later" message and a Refresh button.
- **Reloading the page resumes polling** for the current job (its id is kept in `localStorage`): the job lives on the server, independent of the browser.
- When the job completes, the card switches to the download state, the tab title becomes "✓ Ready", and a screen-reader live region announces it.

Polling (rather than WebSockets/SSE) matches the brief and needs no extra infrastructure. With backoff and visibility pausing, it's cheap.

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

- **Retention cleanup:** a scheduled job deleting files older than `IMAGE_RETENTION_HOURS`. The API already answers 410 Gone for expired results.
- **S3 + presigned URLs:** upload straight to object storage and download from a CDN.
- **Laravel Horizon** for queue metrics and dashboards, plus alerting on failed-job rate and queue depth.
- **Auth and per-user job lists, rate limiting, and virus scanning** of uploads.
- **Server-Sent Events** as a push channel, keeping polling as the fallback.
- **Component tests** for the React UI (MSW-mocked API).

## Repository layout

```
apps/api/        Laravel API + worker (one image, different commands)
  app/Http/        controller, request validation, resource, error shape
  app/Jobs/        ProcessImage (queue job: retry/fail policy)
  app/Images/      ImageJobRunner (claim → process → complete), ImageProcessor (the transform)
  app/Models/      ImageJob (guarded state transitions)
  app/Console/     images:reap-stale
  docker/          Caddyfile, php.ini, entrypoint
apps/web/        React SPA + nginx config
docker/          Postgres init (test database)
docs/design/     design document and implementation plan
```
