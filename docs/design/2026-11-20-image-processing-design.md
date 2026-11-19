# Image Processing App with Async Worker — Design

Date: 2026-11-20
Status: Draft, awaiting approval (scope trimmed to a one-day budget — see §2a)

## 1. Intent

This is a take-home assignment for a job application. The deliverable is a small, working full-stack app: a user uploads a large image, the server acknowledges it immediately with a `job_id`, a separate background worker resizes/compresses/converts it to WebP, and the frontend polls until it can offer a download (or shows a clear error).

What the reviewers are judging, and therefore what we optimise for:

1. **It runs first time** with one command (`docker compose up --build`) on a reviewer's machine, with no local PHP/Composer.
2. **The server/worker separation is obvious and realistic** — the pattern a team would actually ship for CPU-heavy work.
3. **Failure handling is thoughtful**, especially a worker dying mid-job.
4. **Code quality, tests, and a README that explains the "why".**

Polish goes into reliability, clarity and the README — not into features beyond the brief.

## 2. Goals, non-goals, anti-goals

**Goals**
- Upload JPG / PNG / WebP up to 20 MB from a React UI.
- `POST` returns `202` with `job_id` without waiting for processing.
- Worker (separate container) processes in this order: resize to max 1280 px on the longest side (aspect preserved) → encode at quality 80 → output WebP.
- Lifecycle `pending → processing → completed | failed`, never going backwards.
- Status endpoint, download endpoint.
- Frontend shows job ID, live status, download link, or an informative error; polls with exponential backoff.
- Bonus items: pnpm, single-command Docker Compose, crash recovery, tests on backend and frontend, README with architecture decisions.

**Non-goals**
- Auth / users / multi-tenancy.
- Cloud object storage (S3) — local shared volume only; README notes how to swap.
- WebSockets / SSE push (polling is required by the brief).
- Image editing options (crop, custom sizes, format choice).
- Turborepo (decided: only one JS package, so it adds nothing honest).

**Anti-goals** (would count as failure even if it "works")
- The API process doing any image processing, or blocking on it.
- A setup that needs PHP/Composer/pnpm installed locally to run, or flaky startup ordering (API booting before Postgres is ready, migrations not run).
- Jobs that can get stuck in `processing` forever after a crash.
- Over-engineering a reviewer can't understand in ~10 minutes.

## 2a. Scope for a one-day budget

The user has about one day. This section takes precedence over the rest of the document where they conflict: everything below marked **Stretch** is built only if core is done, tested and documented. Items marked **Cut** are mentioned in the README's "what I'd do next" instead.

**Core (must ship)**
- Full Docker Compose stack, single command, cold start works.
- Upload / status / download endpoints with validation and the error contract.
- `ProcessImage` worker: resize → quality 80 → WebP, pixel limit, EXIF orientation, permanent vs transient errors, attempt-number claim token, `failed()` hook.
- Crash recovery: retries via `retry_after`, `images:reap-stale` reaper, scheduler container, `IMAGE_PROCESSING_DELAY_MS` demo delay (trivial, makes the crash demo reliable).
- Frontend: dropzone with client-side validation, single current job card (job ID, 3-step timeline, attempt count, download, error), `pollWithBackoff` with cap, jitter, visibility pause, give-up.
- Backend feature + job tests (§9); frontend unit tests for `pollWithBackoff` and validation.
- README with all sections in §11.

**Stretch (in this order)**
1. Upload progress bar.
2. `scripts/smoke.sh` end-to-end check.
3. Resume the current job after page reload (store its ID in `localStorage`).
4. Retention cleanup (`images:cleanup`, `expired_at`, `410`).

**Cut**
- Multi-job list (one job at a time; uploading again replaces the card).
- Frontend component tests with MSW.
- Screenshot/GIF in README (add only if time is left at the very end).

**Commit order** (reviewers read the history): scaffold + compose → schema + model + state transitions → upload/status/download endpoints + tests → worker job + tests → reaper/scheduler + tests → frontend → README → stretch items.

## 3. Constraints

- Backend: **Laravel 13.x** (latest stable, 13.0 or newer), **PHP 8.4.27 or newer** (8.4 line). Decided by the user.
- Frontend: **React** + Vite + TypeScript, package manager **pnpm**.
- Data: **Postgres** (job records) + **Redis** (queue). Decided by the user.
- Developer machine is **Windows + Docker Desktop**; Node is installed, PHP/Composer/pnpm are not. Consequences:
  - Everything PHP runs in containers (including `composer create-project` during scaffolding, and tests).
  - Shell entrypoint scripts must use LF line endings — add `.gitattributes` with `*.sh text eol=lf` (and for Dockerfiles), or containers fail with `\r` errors.
  - pnpm via `corepack enable` if run locally; otherwise inside the Node build stage.
- The PHP image must include the `pcntl` extension (needed for `queue:work --timeout` and graceful SIGTERM), plus `imagick`, `pdo_pgsql`, `redis`. Entrypoints must `exec` the final command so PHP is PID 1's child that receives signals.
- The assignment brief is reproduced verbatim in Appendix A; it is the source of truth for grading.

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| **A** | One Laravel codebase, two containers: `api` (HTTP) and `worker` (`php artisan queue:work`), Redis queue, Postgres job table, shared storage volume | Idiomatic Laravel, uses built-in retry/timeout/failed semantics, least code; separation is by process/container rather than by codebase | **Chosen** |
| B | Laravel API + standalone Node (sharp) or Go worker talking JSON over Redis, writing Postgres directly | Separation is visually obvious, sharp is fast; but two codebases share a table, Laravel's retry/failure handling must be rebuilt, more to test, invites "why not Laravel queues?" | Rejected |
| C | Database polling worker (`SELECT … FOR UPDATE SKIP LOCKED`) | Fewer services, but Redis was already chosen and would be idle | Rejected |

Why A: it is what a Laravel team ships in production for this problem; it lets effort go to crash recovery, tests and the README. The README must make the separation explicit: the `api` container never touches image bytes beyond storing the upload; only the `worker` container has the image-processing work assigned to it, and workers scale independently (`docker compose up --scale worker=3`).

## 5. Architecture

```
 Browser (React SPA)
     │  /            static SPA
     │  /api/*       proxied
     ▼
 ┌─────────┐   HTTP    ┌──────────┐  insert row (pending)   ┌──────────┐
 │  web    │ ────────► │   api    │ ──────────────────────► │ postgres │
 │ (nginx) │           │ Laravel  │  push ProcessImage job  └──────────┘
 └─────────┘           └────┬─────┘ ──────────┐                 ▲
                            │ write upload    ▼                 │ status updates
                            ▼            ┌─────────┐   pop   ┌──┴───────┐
                     ┌──────────────┐    │  redis  │ ──────► │  worker  │ (×N)
                     │ shared volume│◄───┴─────────┘         │ queue:work│
                     │ storage/app  │◄───────────────────────┤ Imagick   │
                     └──────────────┘   read original,       └──────────┘
                                        write result         ┌──────────┐
                                                             │scheduler │ reaper + cleanup
                                                             └──────────┘
```

### Containers (`docker-compose.yml`)

| Service | Image / command | Notes |
|---|---|---|
| `postgres` | `postgres:17-alpine` | named volume; healthcheck `pg_isready` |
| `redis` | `redis:7-alpine` with `--appendonly yes` | AOF so queued jobs survive a Redis restart; healthcheck |
| `api` | built from `apps/api/Dockerfile` | entrypoint waits for healthy deps, runs `php artisan migrate --force`, then serves HTTP. `APP_KEY` is a fixed default in compose shared by api/worker/scheduler (documented as demo-only; override in production). Must be a real server (php-fpm+nginx or FrankenPHP/Octane — builder's choice), **not** `artisan serve`. |
| `worker` | same image, command `php artisan queue:work redis --queue=images --timeout=120 --tries=3 --sleep=1` | `stop_grace_period: 130s` so SIGTERM lets the current job finish; does not run migrations; `depends_on: api (healthy)` so schema exists |
| `scheduler` | same image, `php artisan schedule:work` | runs reaper (every minute) and cleanup (hourly) |
| `web` | built from `apps/web/Dockerfile` (Node stage `pnpm build` → nginx stage) | serves SPA, proxies `/api` to `api` (same origin → no CORS); `client_max_body_size 25m` |

Ports exposed to host: `web` on **8080** (the app). `api` also on **8000** for curl/debugging.

`docker compose up --build` must be the only command needed. No `.env` file required: compose provides defaults; `.env.example` documents overrides.

## 6. Repository layout

```
/
├─ apps/
│  ├─ api/        Laravel app (Dockerfile, docker/ entrypoint + php.ini + server config)
│  └─ web/        React + Vite + TS (Dockerfile, nginx.conf)
├─ docs/design/   this document
├─ scripts/smoke.sh   end-to-end check: upload → poll → download → verify WebP ≤1280px
├─ docker-compose.yml
├─ .env.example
├─ .gitattributes
├─ package.json   root pnpm scripts that wrap docker compose (up, test, smoke) — convenience only
└─ README.md
```

## 7. Backend (Laravel)

### Data model — table `image_jobs`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Laravel `HasUuids` (UUIDv7); this is the public `job_id` |
| `status` | string, indexed | `pending` \| `processing` \| `completed` \| `failed` (backed PHP enum) |
| `original_name` | string | sanitised client filename |
| `original_mime` | string | detected from content, not client header |
| `original_size` | bigint | bytes |
| `original_path` | string | `uploads/{id}.{ext}` |
| `original_width`, `original_height` | int nullable | filled by worker |
| `result_path` | string nullable | `results/{id}.webp` |
| `result_size`, `result_width`, `result_height` | nullable | |
| `attempts` | smallint default 0 | set to the queue attempt number (`$this->attempts()`) of the delivery that currently owns the job — acts as a claim token |
| `error_code` | string nullable | machine code, e.g. `corrupt_image`, `dimensions_too_large`, `worker_lost`, `retries_exhausted` |
| `error_message` | text nullable | human-readable, shown in the UI |
| `started_at`, `completed_at`, `failed_at` | timestamps nullable | `started_at` = time of the latest claim |
| `expired_at` | timestamp nullable | set when retention cleanup deletes the files; row is kept |
| `created_at`, `updated_at` | timestamps | |

### State transitions

Enforced in one place (model/service), using conditional updates so concurrent or duplicate deliveries are safe:

- **Claim** `pending → processing`: `UPDATE … SET status='processing', attempts=:n, started_at=now() WHERE id=? AND status IN ('pending','processing') AND attempts < :n`, where `:n` is this delivery's `$this->attempts()`. If 0 rows are updated, another delivery owns (or finished) the job → exit as a no-op without retrying. Laravel's Redis queue increments the attempt counter atomically on every reservation, so a genuine retry (after an exception or after `retry_after` expiry) always has a higher `:n` and can take over; a duplicate message for the same job (same or lower `:n`) cannot. Status never goes back to `pending`.
- **Complete / fail from the worker**: `… WHERE id=? AND status='processing' AND attempts=:n` — a stale worker that lost ownership can't overwrite the newer owner's outcome.
- `processing → completed`: only from `processing`.
- `processing|pending → failed`: from any non-terminal state.
- Terminal states (`completed`, `failed`) are never changed. If a duplicate delivery finds a terminal row, the job exits as a no-op.

### Endpoints

All JSON responses use a consistent shape; errors are `{ "error": { "code": "...", "message": "..." } }`.

**`POST /api/images`** — multipart field `image`
- Validation: required file; `mimes:jpg,jpeg,png,webp` (content-sniffed) + `mimetypes:image/jpeg,image/png,image/webp`; `max:20480` KB. Failures → `422` with a specific message ("File must be JPG, PNG or WebP", "File is larger than 20 MB").
- PHP limits set above 20 MB and equal to each other (`upload_max_filesize=25M`, `post_max_size=25M`) so files of 20–~25 MB get Laravel's friendly 20 MB `422`, and anything bigger trips `post_max_size` first → Laravel `PostTooLargeException` → `413`. Web servers in both `web` and `api` set `client_max_body_size 26m`. Frontend maps `413`, and Laravel's generic "failed to upload" `422`, to the same "larger than 20 MB" message.
- Route constraint `whereUuid('id')` on all `{id}` routes so malformed ids return `404`, not a Postgres cast error (`500`).
- Stores original to `uploads/{id}.{ext}`, inserts row `pending`, dispatches `ProcessImage($id)` on queue `images` **after commit**.
- If dispatch throws (Redis down): mark row `failed` with `queue_unavailable`, return `503`.
- Response `202 Accepted`:
  ```json
  { "job_id": "…", "status": "pending", "status_url": "/api/images/…", "created_at": "…" }
  ```
  plus `Location` header.

**`GET /api/images/{id}`**
- `404` for unknown or malformed id.
- `200`:
  ```json
  {
    "job_id": "…", "status": "processing", "attempts": 1,
    "original": { "name": "photo.jpg", "mime": "image/jpeg", "size": 18234567, "width": 6000, "height": 4000 },
    "result":   { "size": 402311, "width": 1280, "height": 853 },      // null until completed
    "download_url": "/api/images/…/download",                         // null until completed
    "error": { "code": "corrupt_image", "message": "…" },              // null unless failed
    "created_at": "…", "started_at": "…", "completed_at": null, "failed_at": null
  }
  ```

**`GET /api/images/{id}/download`**
- `404` unknown; `409` with message if not `completed`; `410` if `expired_at` is set (files removed by retention cleanup). The status endpoint keeps `status: completed` but returns `download_url: null` and `"expired": true` for such jobs.
- `200` streams `image/webp`, `Content-Disposition: attachment; filename="{original-basename}.webp"`.

### The worker job — `ProcessImage`

Config: `$tries = 3`, `$timeout = 120`, `backoff = [5, 15]` (two retries), Redis connection `retry_after = 150` (must exceed timeout so a live job is never handed out twice). Queue name `images`.

Steps, in order:
1. Load row; if terminal → return (idempotent).
2. Claim with the attempt-number token (conditional update above); if the claim fails → return.
3. Read original from shared storage with Intervention Image v3 (Imagick driver). Before decoding, check pixel dimensions (`getimagesize`/Imagick ping) — reject over **50 megapixels** as `dimensions_too_large` (decompression-bomb guard). Set Imagick resource limits too.
4. Auto-orient from EXIF, strip metadata.
5. Resize: `scaleDown` so the longest side ≤ 1280 px, aspect preserved, **never upscale** smaller images.
6. Encode WebP at quality 80. (Compression and conversion are one encode step — encoding twice would lose quality twice. README explains this reading of "compress to 80% then convert to WebP".) Animated GIF-like inputs (animated WebP/APNG): first frame only — documented.
7. Write to a temp file, then atomic rename to `results/{id}.webp` (a crash never leaves a half-written result that looks valid).
8. Transition to `completed` with result size/dimensions.

Error classes:
- **Permanent** (corrupt/undecodable file, unsupported content, too many pixels): `$this->fail()` immediately — no retry — with a specific `error_code`/`error_message`.
- **Transient** (storage I/O, DB connection, unexpected exception): throw; Laravel retries with backoff. UI shows "Retrying (attempt 2 of 3)" from `attempts`.
- `failed(Throwable $e)` hook: marks row `failed` with `retries_exhausted` (or the permanent code) and a user-safe message; full exception goes to logs only.

### Crash recovery (bonus item — make it demonstrable)

| Scenario | What happens |
|---|---|
| Worker gets SIGTERM (deploy, `docker compose stop`) | `queue:work` finishes the current job, then exits (grace period 130 s). |
| Worker is SIGKILLed / container dies mid-job | The job stays in Redis's reserved set. Once `retry_after` (150 s) has passed, the next worker that polls the queue migrates expired reservations back to the queue (Laravel does this on pop — Redis itself does nothing) and re-reserves it with a higher attempt number; it re-claims the row, status remains `processing`. After 3 attempts Laravel fails it → `failed()` → row `failed` (`retries_exhausted`). Worker has `restart: unless-stopped`. |
| Job lost entirely / all workers down past the last attempt | Scheduled `images:reap-stale` (every minute): rows in `processing` whose latest claim (`started_at`) is older than **10 min** — far beyond one attempt's 120 s timeout + 150 s retry window — are marked `failed` with `worker_lost` / "Processing didn't finish in time — please try again." **`pending` rows are never reaped**: a backlog behind busy workers is normal, and Redis AOF protects queued messages. |
| Duplicate delivery | Attempt-number claim token + idempotent early return (see State transitions). |

README includes a "try it" recipe: upload a big image, `docker compose kill worker` while processing, `docker compose start worker`, watch it recover.

A debug-only way to make the crash demo reliable (images process fast): env `IMAGE_PROCESSING_DELAY_MS` (default 0) adds an artificial sleep inside the job. Documented as demo-only.

### Retention

Scheduled `images:cleanup` (hourly): for terminal jobs older than `IMAGE_RETENTION_HOURS` (default 24), delete the original and result files and set `expired_at`. Rows are kept (they're tiny and make "expired" distinguishable from "never existed"). Originals of `completed` jobs may be deleted right after success — builder's call.

## 8. Frontend (React + Vite + TS, pnpm)

Single page, no router. Plain CSS or CSS modules (no UI library needed; builder may use a small one if preferred). Clean, neutral look.

```
┌──────────────────────────────────────────────────────┐
│  Image Processor                                     │
│  ┌────────────────────────────────────────────────┐  │
│  │   Drop an image here or  [Choose file]         │  │
│  │   JPG, PNG or WebP · up to 20 MB               │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  photo.jpg · 18.2 MB                                 │
│  Job 0193…a7f2  [copy]                               │
│  ● Pending ── ● Processing ── ○ Completed            │
│  Processing… 4 s (attempt 1 of 3)                    │
│                                                      │
│  ✓ Ready: 1280×853 · 402 KB (−97%)  [Download WebP]  │
│  ✗ Failed: This file isn't a valid image. [Try again]│
└──────────────────────────────────────────────────────┘
```

Behaviour:
- **Client-side validation** of type and size before upload (instant feedback); server remains the authority.
- **Upload progress bar** (XHR `upload.onprogress`) — a 20 MB upload is visible time, and it distinguishes "uploading" (client) from `pending` (server).
- After `202`, show job ID (copyable) and a 3-step status timeline.
- **Multiple jobs**: each upload adds a card to a list (newest first). Job IDs persisted in `localStorage`, so reloading the page resumes polling — demonstrates the job lives on the server, independent of the browser.
- **Polling strategy** (a small, tested `pollWithBackoff` module, used via a `useJobStatus` hook):
  - first poll after 500 ms, delay × 1.5 each time, capped at 5 s, ±20 % jitter;
  - stop on `completed` / `failed`;
  - pause while the tab is hidden (Page Visibility API), poll immediately on return;
  - network / 5xx errors: keep backing off, show "Connection lost, retrying…"; `404` → "Job not found"; `expired: true` → "This result has expired — upload again";
  - give up after 10 minutes → "Still processing — check back later" with a manual refresh button.
- **Notify on completion**: card switches to Ready state, tab title shows "✓ Ready", and an `aria-live` region announces it.
- **Error messages** map `error.code` to clear text, falling back to the server's `message`. Upload-time errors (422/413/503/network) shown inline at the dropzone.
- API base path `/api` (same origin via nginx); `VITE_API_BASE_URL` override for running Vite dev server against `localhost:8000` (then Laravel CORS allows `localhost:5173`).

## 9. Testing

**Backend (PHPUnit or Pest, run via `docker compose run --rm api php artisan test`)**
- Upload: accepts each of JPG/PNG/WebP; rejects >20 MB, wrong type, a `.jpg`-named text file (content sniffing); returns `202` with `job_id`; `Queue::fake()` asserts `ProcessImage` dispatched on `images`; row is `pending`.
- Status: shape for each state; 404 for unknown/malformed id.
- Download: 404 / 409 / 410 / 200 with correct headers.
- Claim token: duplicate delivery with same attempt number is a no-op; higher attempt number takes over; stale owner's completion is rejected.
- `ProcessImage` with real fixture images: landscape and portrait larger than 1280 → longest side exactly 1280, aspect preserved; small image not upscaled; output is valid WebP; EXIF-rotated JPEG comes out upright; corrupt file → `failed` with `corrupt_image`, no retry; terminal row → no-op; re-claim on retry increments `attempts` and keeps `processing`.
- `failed()` hook sets `retries_exhausted`.
- Reaper marks stale `processing` rows `failed`, ignores fresh ones and all `pending` rows.
- Cleanup sets `expired_at` and removes files.
- Test DB: **Postgres** (a separate `images_test` database created by a Postgres init script), so UUID casting and conditional updates behave as in production.

**Frontend (Vitest + Testing Library + MSW)**
- `pollWithBackoff`: delay sequence, cap, stop on terminal, pause/resume on visibility, error backoff (fake timers).
- Client validation (type, size).
- Job card renders pending → processing → completed (download link) and failed (message) from mocked API.

**End-to-end smoke** — `scripts/smoke.sh` against the running stack: generate/upload a large image, poll, download, assert WebP and ≤1280 px. README shows how to run it.

## 10. Configuration (env vars, all with compose defaults)

| Var | Default | Purpose |
|---|---|---|
| `APP_KEY` | fixed demo key in compose | Laravel encryption key — must be overridden outside the demo |
| `APP_ENV` / `APP_DEBUG` | `production` / `false` | |
| `DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | `pgsql`, `postgres`, `5432`, `images`, `images`, `secret` | |
| `REDIS_HOST`, `REDIS_PORT` | `redis`, `6379` | |
| `QUEUE_CONNECTION` | `redis` | |
| `IMAGE_MAX_UPLOAD_KB` | `20480` | upload limit |
| `IMAGE_MAX_DIMENSION` | `1280` | longest side |
| `IMAGE_QUALITY` | `80` | WebP quality |
| `IMAGE_MAX_PIXELS` | `50000000` | decompression-bomb guard |
| `IMAGE_STALE_AFTER_SECONDS` | `600` | reaper threshold |
| `IMAGE_RETENTION_HOURS` | `24` | cleanup |
| `IMAGE_PROCESSING_DELAY_MS` | `0` | demo-only artificial delay |
| `VITE_API_BASE_URL` | `/api` | frontend build-time |

## 11. README contents

1. What it is + 30-second demo flow (with a screenshot/GIF if time allows).
2. Quick start: `docker compose up --build` → open http://localhost:8080.
3. Running tests (backend, frontend, smoke).
4. Environment variables (table above).
5. Architecture: diagram, request flow, why queue + separate worker container, why Redis + Postgres (each one's job), why the API never processes images, scaling workers.
6. Failure handling & crash-recovery demo recipe.
7. Polling strategy and why (backoff, visibility pause, give-up).
8. Decisions & trade-offs: pnpm over bun (and why no Turborepo), single encode step for compress+convert, local volume vs S3, polling vs SSE, what I'd do next in production (S3 + presigned URLs, Horizon, metrics, auth, rate limiting, virus scanning).

## 12. Decisions summary

**Decided by the user:** take-home context; about one day of time; pnpm (not bun); no Turborepo; Postgres + Redis; Approach A.

**Also decided by the user:** Laravel 13.x, PHP 8.4.27+.

**My calls (open to correction):** Intervention Image v3 / Imagick; UUIDv7 job ids; retries stay in `processing`, with the queue attempt number as a claim token; 3 tries / 120 s timeout / 150 s retry_after / backoff 5 s, 15 s; 50 MP limit; reaper at 10 min for `processing` only; 24 h retention that keeps rows and marks them expired; fixed demo `APP_KEY`; single-origin nginx proxy; the core / stretch / cut split in §2a; one job at a time in the UI; backoff 500 ms ×1.5 cap 5 s, 10 min give-up; demo delay env var; Postgres test database; `docs/design/` location; root `package.json` convenience scripts; git repo initialised with meaningful incremental commits (reviewers read history).

## 13. Left to the builder

- HTTP server inside `api` (php-fpm+nginx vs FrankenPHP) — must be production-style.
- Pest vs PHPUnit; CSS approach; exact component breakdown.
- Exact Dockerfile layering, as long as cold `docker compose up --build` works and is reasonably fast.
- Exact error-message wording (must be specific and human).

## Appendix A — Assignment brief (verbatim requirements)

**1. Interactive Frontend** — Build a UI where the user can upload an image (JPG, PNG, or WebP, max 20MB). After upload, display the job ID and current processing status. Poll the job status periodically and update the UI accordingly. When the job is complete, provide a download link for the processed image. When the job fails, display a clear and informative error message. Use React frontend framework.

**2. Backend with Functionality** — Accept image uploads from the frontend. Immediately return a response containing a job_id; do not wait for processing to finish. Delegate the processing task to the background worker. Expose an endpoint to check job status by job_id. Expose an endpoint to download the processed image. Use Laravel.

**3. Background Worker** — Process the image asynchronously with the following operations, in order: Resize to a maximum of 1280px on the longest side, preserving aspect ratio; Compress to 80% quality; Convert to WebP format. Use any approach: queues, database polling, or other mechanisms. The solution will be evaluated on how well it fits the task. Job lifecycle must follow this sequence: pending → processing → completed / failed.

**4. Use Case / Scenario** — Present a clear, working end-to-end flow: a user uploads a large image, the system acknowledges it immediately, processes it in the background, and notifies the frontend when it is ready to download. The app must demonstrate a clear separation between the server (which delegates) and the worker (which executes), reflecting a realistic production pattern for CPU-intensive or time-consuming tasks.

**Bonus Points** — Use bun/pnpm and turborepo if possible; state the reasons. Docker Compose setup that runs the entire stack with a single command. Graceful handling of worker crashes or failures mid-process. Efficient polling strategy on the frontend (e.g., exponential backoff). Unit or integration tests for any layer. Clear explanation of architectural decisions in the README.

**README** — must include: setup instructions, required environment variables, and a brief explanation of architectural decisions made.

Endpoint paths and response shapes are not prescribed by the brief; those in §7 are our design.
