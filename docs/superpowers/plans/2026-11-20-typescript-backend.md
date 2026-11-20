# TypeScript (Fastify) Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second, independent backend in strict TypeScript (`apps/api-ts`) that behaves the same as the Laravel one behind the unchanged React frontend, run with `docker compose -f docker-compose.ts.yml up --build`.

**Architecture:** One Node image, three commands: `server.js` (Fastify HTTP API), `worker.js` (BullMQ consumer that runs sharp), `scheduler.js` (reaper every minute, cleanup hourly). Postgres holds `image_jobs`. Every state change is one conditional UPDATE keyed on a claim token (`job.attemptsStarted`). Its own compose project on host ports 8081/8001 reuses `apps/web` as is.

**Tech Stack:** Node 24, pnpm (corepack), TypeScript 5 strict, ESM, Fastify 5, @fastify/multipart, BullMQ 5 + ioredis, sharp, file-type, Drizzle ORM + drizzle-kit + pg, zod (config and route schemas), croner (scheduler), pino, Vitest, typescript-eslint.

**Spec:** `docs/superpowers/specs/2026-11-20-typescript-backend-design.md`

## Global Constraints

- `tsconfig`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `module`/`moduleResolution` `NodeNext`. No `any`, no `@ts-ignore`/`@ts-expect-error`, no `as` casts on external data (parse with zod instead). ESLint `strictTypeChecked` must pass.
- Env vars and defaults are the same as `apps/api/config/images.php`: `IMAGE_MAX_UPLOAD_KB=20480`, `IMAGE_MAX_DIMENSION=1280`, `IMAGE_QUALITY=80`, `IMAGE_MAX_PIXELS=50000000`, `IMAGE_STALE_AFTER_SECONDS=600`, `IMAGE_LOST_AFTER_SECONDS=3600`, `IMAGE_RETENTION_HOURS=24`, `IMAGE_PROCESSING_DELAY_MS=0`, plus `DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD`, `REDIS_HOST/REDIS_PORT`, `LOG_LEVEL`, `RUN_MIGRATIONS`. Storage root `IMAGE_STORAGE_PATH=/app/storage/images` (subdirs `uploads/`, `results/`).
- Queue name `images`. `MAX_TRIES = 3`. Retry backoff 5 s then 15 s. Per-attempt limit 120 s. `stop_grace_period: 130s`.
- Every error response is `{"error": {"code", "message", ...extra}}`. All user-facing strings are copied verbatim from `apps/api` (`ImageErrorCode::message()`, `StoreImageRequest::messages()`, `bootstrap/app.php`, `ImageJobController`).
- Timestamps in JSON are formatted like Laravel's `toJSON()`: `2026-11-20T10:00:00.000000Z` (UTC, six fractional digits). DB columns are `timestamp(0) without time zone` in UTC; containers run with `TZ=UTC`.
- The TS API service is named `api` and listens on `:8000` inside its compose project (the web nginx proxies to `http://api:8000`). Host ports: web **8081**, API **8001**. Compose project `name: image-processor-ts`.
- No changes to `apps/api` or `apps/web` source.

## Review Focus

1. **Redis down at upload time** → the upload returns 503 `queue_unavailable` within ~2 s and the row is `failed`, not a hung request. Test in Task 5.
2. **Worker killed mid-job, then redelivered by BullMQ as stalled** → the redelivery has a higher `attemptsStarted`, takes over the row, and the attempt count shown never exceeds 3. Test in Task 4 (simulated by calling the processor with attempt 2 on a row left `processing` at 1, and with attempt 4).
3. **Upload of 20–26 MB sent straight to :8001 (no nginx)** → 422 "File is larger than 20 MB.", and above 26 MB → 413 `file_too_large`; the partial temp file is deleted. Test in Task 5.
4. **Client disconnects mid-upload** → no orphaned file in `uploads/` and no row inserted. Test in Task 5 (abort a streamed inject).
5. **Original filename with path separators, control characters or 300 characters** → stored name is sanitised exactly like `sanitiseName` (basename, control chars stripped, ≤200 chars, `image` fallback). Test in Task 5.

---

### Task 1: Scaffold `apps/api-ts`, config, test infrastructure

**Files:**
- Create: `apps/api-ts/package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `tsconfig.build.json`, `eslint.config.js`, `vitest.config.ts`, `.dockerignore`, `.gitignore`, `Dockerfile`
- Create: `apps/api-ts/src/config.ts`
- Create: `docker-compose.ts.yml` (only `postgres`, `redis`, `api-test` for now)
- Test: `apps/api-ts/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` and `type Config = { maxUploadBytes: number; maxDimension: number; quality: number; maxPixels: number; staleAfterSeconds: number; lostAfterSeconds: number; retentionHours: number; processingDelayMs: number; storagePath: string; db: { host: string; port: number; database: string; user: string; password: string }; redis: { host: string; port: number }; logLevel: string; runMigrations: boolean }`. `maxUploadBytes = IMAGE_MAX_UPLOAD_KB * 1024`.
- Produces: `package.json` scripts `build` (tsc -p tsconfig.build.json → `dist/`), `typecheck`, `lint`, `test` (vitest run), `db:generate`.

- [ ] **Step 1: Write the failing test** `test/config.test.ts`:
  - `loadConfig({})` returns `maxUploadBytes: 20480 * 1024`, `maxDimension: 1280`, `quality: 80`, `maxPixels: 50_000_000`, `staleAfterSeconds: 600`, `lostAfterSeconds: 3600`, `retentionHours: 24`, `processingDelayMs: 0`, `runMigrations: false`.
  - `loadConfig({ IMAGE_QUALITY: '55', RUN_MIGRATIONS: 'true' })` gives `quality: 55`, `runMigrations: true`.
  - `loadConfig({ IMAGE_QUALITY: 'abc' })` throws.
- [ ] **Step 2: Implement `loadConfig`** with a zod schema using `z.coerce.number().int()` and defaults.
- [ ] **Step 3: Dockerfile.** `node:24-alpine`. Target `base`: corepack enable, `pnpm install --frozen-lockfile` (dev deps included; used by `api-test`). Target `app`: build, prune to prod deps, `ENV TZ=UTC NODE_ENV=production`, create `/app/storage/images/{uploads,results}`, run as `node`, default `CMD ["node","dist/server.js"]`.
- [ ] **Step 4: `docker-compose.ts.yml`** with `name: image-processor-ts`; `postgres` and `redis` copied from `docker-compose.yml` (postgres mounts `./docker/postgres/init-test-db.sh`, which creates `images_test`); `api-test` under profile `test`, built from `./apps/api-ts` target `base`, mounts `./apps/api-ts:/app` plus an anonymous volume for `/app/node_modules`, `environment: { DB_HOST: postgres, DB_DATABASE: images_test, REDIS_HOST: redis, TZ: UTC }`, command `sh -c "pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test"`, depends on both healthy.
- [ ] **Step 5: Run** `docker compose -f docker-compose.ts.yml --profile test run --rm api-test`. Expected: typecheck and lint clean, `config.test.ts` 3 passing.
- [ ] **Step 6: Commit** `feat(api-ts): scaffold strict TypeScript backend and config`

---

### Task 2: Database schema and the job state machine

**Files:**
- Create: `apps/api-ts/src/db/schema.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `drizzle.config.ts`, `src/db/migrations/*` (generated)
- Create: `apps/api-ts/src/jobs/status.ts`, `src/jobs/errors.ts`, `src/jobs/repository.ts`, `src/jobs/time.ts`
- Create: `apps/api-ts/test/support/db.ts`
- Test: `apps/api-ts/test/jobs/repository.test.ts`, `test/jobs/time.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1).
- Produces:
  - `imageJobs` Drizzle table with the same columns, types and defaults as `apps/api/database/migrations/2026_11_20_000000_create_image_jobs_table.php` (uuid `id` PK, `status` varchar(16) default `'pending'` indexed, `attempts` smallint default 0, timestamps `timestamp(0)` mode `date`, `created_at`/`updated_at` not null default now). `type ImageJob = typeof imageJobs.$inferSelect`.
  - `createDb(config: Config): { db: Db; close(): Promise<void> }`; `runMigrations(db: Db): Promise<void>`.
  - `const JobStatus = { Pending: 'pending', Processing: 'processing', Completed: 'completed', Failed: 'failed' } as const`, `type JobStatus`, `isTerminal(s: JobStatus): boolean`.
  - `ImageErrorCode` (`'corrupt_image' | 'unsupported_image' | 'dimensions_too_large' | 'retries_exhausted' | 'worker_lost' | 'queue_unavailable'`), `errorMessage(code): string` with the exact strings from `ImageErrorCode.php`, `class PermanentImageFailure extends Error { readonly code: ImageErrorCode }` (message = `errorMessage(code)`).
  - `JobRepository` class, constructed with `Db`: `insert(row: NewJob): Promise<ImageJob>`, `find(id: string): Promise<ImageJob | undefined>`, `claim(id, attempt: number): Promise<boolean>`, `markCompleted(id, attempt, result: CompletedResult): Promise<boolean>`, `markFailed(id, code: ImageErrorCode, message?: string): Promise<boolean>`. `CompletedResult = { resultPath: string; size: number; width: number; height: number; originalWidth: number; originalHeight: number }`. Each mutation is one `UPDATE ... WHERE id = ? AND <guard> RETURNING id`, sets `updated_at`, and returns whether one row changed. Guards are exactly those in `ImageJob.php`.
  - `toLaravelJson(d: Date | null): string | null` → `YYYY-MM-DDTHH:MM:SS.000000Z`.
  - Test helper `test/support/db.ts`: `testDb()` (migrates once, `TRUNCATE image_jobs` before each test), `makeJob(overrides?: Partial<NewJob>): Promise<ImageJob>` (defaults `original_name 'photo.jpg'`, `mime 'image/jpeg'`, `size 18234567`, `path 'uploads/<id>.jpg'`).

- [ ] **Step 1: Write the failing tests**, ported one-for-one from `apps/api/tests/Unit/ImageJobTransitionsTest.php` and the transition cases in Feature tests: `new job defaults to pending with attempts 0`, `claim moves pending to processing with attempt` (status, attempts=1, started_at set), `claim with same or lower attempt is rejected`, `higher attempt takes over processing job`, `claim rejected on terminal rows`, `complete requires current owner` (attempt 1 cannot complete after attempt 2 claimed; attempt 2 can), `mark failed works from pending`, `mark failed uses default message and ignores terminal`, `status is terminal`. Plus `toLaravelJson(new Date('2026-11-20T10:00:00Z')) === '2026-11-20T10:00:00.000000Z'` and `toLaravelJson(null) === null`.
- [ ] **Step 2: Run** the api-test command. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** schema, `pnpm db:generate` to produce the migration SQL, client, `runMigrations` (drizzle `migrate()`), status, errors, repository, time helper.
- [ ] **Step 4: Run** the api-test command. Expected: all repository and time tests PASS.
- [ ] **Step 5: Commit** `feat(api-ts): image_jobs schema and claim-token state machine`

---

### Task 3: Image processor (sharp)

**Files:**
- Create: `apps/api-ts/src/images/processor.ts`
- Create: `apps/api-ts/test/support/images.ts`
- Test: `apps/api-ts/test/images/processor.test.ts`

**Interfaces:**
- Consumes: `Config`, `PermanentImageFailure`, `ImageErrorCode` (Task 2).
- Produces: `processImage(source: string, dest: string, opts: { maxDimension: number; quality: number; maxPixels: number; timeoutSeconds: number }): Promise<ProcessedImage>`; `type ProcessedImage = { width: number; height: number; size: number; originalWidth: number; originalHeight: number }`.
- Produces (test support): `makeImage(w, h, format: 'jpeg' | 'png' | 'webp' | 'gif', opts?: { alpha?: boolean; cmyk?: boolean; orientation?: number; frames?: number; color?: string; noise?: boolean }): Promise<string>` (temp file path) and `makeCorruptFile(): Promise<string>`, built with sharp (`toColourspace('cmyk')`, `withExif({ IFD0: { Orientation } })`/`withMetadata({ orientation })`, `sharp([...], { join: { animated: true } })` for frames).

- [ ] **Step 1: Write the failing tests**, ported from `apps/api/tests/Unit/ImageProcessorTest.php` with the same values:
  - `landscape scaled to 1280 wide`: 4000×3000 jpeg → result `{width:1280,height:960}`, `{originalWidth:4000, originalHeight:3000}`, file metadata 1280×960, `size === stat(dest).size`.
  - `portrait scaled to 1280 tall`: 3000×4000 → 960×1280. `tall narrow keeps nonzero width`: 100×5000 → 26×1280. `small image not upscaled`: 800×600 → 800×600.
  - `output is webp` (metadata format `webp`). `quality setting is applied`: noisy image, size at q30 < q80 < q100.
  - `png alpha preserved`: 200×100 alpha png → output has alpha; pixel (180,50) alpha ≈ 0, (20,50) alpha ≈ 255.
  - `cmyk converted to srgb`: red CMYK jpeg → output space `srgb`, pixel r>200, g<60.
  - `exif rotated jpeg is upright`: 400×200 with orientation 6 → result 200×400, original reported 200×400.
  - `metadata is stripped`: output metadata has no `exif`. `animated webp uses first frame`: 2 frames → output `pages` is 1 (or undefined).
  - `corrupt file throws corrupt_image`, `random bytes throw corrupt_image`, `unsupported format throws` (gif → `unsupported_image`), `over pixel limit throws` (`maxPixels: 5000`, 100×100 → `dimensions_too_large`); each asserts the `code`, the exact message, and that `dest` does not exist.
  - `no tmp file left behind`: after success `dest` exists and `dest + '.tmp'` does not.
- [ ] **Step 2: Run** the api-test command. Expected: FAIL.
- [ ] **Step 3: Implement `processImage`** per the spec's pipeline: `sharp(source).metadata()` in try/catch → `corrupt_image`; format not in `jpeg|png|webp` → `unsupported_image`; `width*height > maxPixels` → `dimensions_too_large`; then `sharp(source, { limitInputPixels: maxPixels, failOn: 'error', pages: 1 }).rotate().toColourspace('srgb').resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true }).webp({ quality }).timeout({ seconds: timeoutSeconds }).toFile(tmp)`; decode errors from this second call also map to `corrupt_image`; rename tmp → dest, unlink tmp in `finally`. Original dimensions are the post-orientation ones (swap when EXIF orientation ≥ 5).
- [ ] **Step 4: Run.** Expected: all processor tests PASS.
- [ ] **Step 5: Commit** `feat(api-ts): sharp image pipeline`

---

### Task 4: Runner and BullMQ worker

**Files:**
- Create: `apps/api-ts/src/images/runner.ts`, `src/queue.ts`, `src/worker.ts`, `src/jobs/process-job.ts`
- Test: `apps/api-ts/test/images/runner.test.ts`, `test/jobs/process-job.test.ts`

**Interfaces:**
- Consumes: `JobRepository`, `processImage`, `Config`, errors.
- Produces:
  - `MAX_TRIES = 3`, `BACKOFF_MS = [5000, 15000] as const`, `QUEUE_NAME = 'images'`.
  - `runImageJob(deps: { repo: JobRepository; config: Config; process?: typeof processImage }, id: string, attempt: number): Promise<void>` — mirrors `ImageJobRunner::run`: missing or terminal → return; `claim` false → return; sleep `processingDelayMs`; process `uploads/...` → `results/{id}.webp`; `markCompleted`.
  - `handleDelivery(deps, data: { imageJobId: string }, attempt: number): Promise<void>` — the BullMQ processor body: if `attempt > MAX_TRIES`, `markFailed('retries_exhausted')` and throw `UnrecoverableError`; run; on `PermanentImageFailure` → `markFailed(e.code)` and throw `UnrecoverableError`; on any other error, if `attempt >= MAX_TRIES` → `markFailed('retries_exhausted')` and throw `UnrecoverableError`, else rethrow (BullMQ retries).
  - `createQueue(config): Queue<{ imageJobId: string }>` — producer connection with `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `connectTimeout: 2000`. `enqueue(queue, id): Promise<void>` adds with `{ jobId: id, attempts: MAX_TRIES + 1, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: 1000 }` and rejects after 2 s.
  - `src/worker.ts`: `new Worker(QUEUE_NAME, job => handleDelivery(deps, job.data, job.attemptsStarted), { connection, concurrency: 1, maxStalledCount: MAX_TRIES, settings: { backoffStrategy: (attemptsMade) => BACKOFF_MS[attemptsMade - 1] ?? 15000 } })`; `SIGTERM`/`SIGINT` → `await worker.close()` then exit. Logs failures with `job_id` and `error_code`.
  - Note for the README (Task 8): `attempts: MAX_TRIES + 1` is only a ceiling; the 3-delivery limit is enforced in `handleDelivery` because BullMQ's `attemptsMade` doesn't count stalls.

- [ ] **Step 1: Write the failing tests**, ported from `ImageJobRunnerTest.php` and `ProcessImageJobTest.php`:
  - Runner: `completes pending job` (real fixture via `makeImage`; row completed, result file exists, sizes stored), `noop for missing job`, `noop for terminal job`, `noop when claim lost` (row at attempts 2, run with 1 → untouched, `process` not called), `retry takes over` (row processing at 1, run with 2 → completed, attempts 2), `permanent failure propagates`, `processing delay is applied` (delay 50 ms → elapsed ≥ 50).
  - Delivery: `successful job completes`, `permanent failure fails without retry` (throws `UnrecoverableError`; row `corrupt_image`), `transient error on attempt 1 rethrows and leaves row processing`, `transient error on attempt 3 marks retries_exhausted` (message "We couldn't process this image after 3 attempts. Please try again."), `fourth start marks retries_exhausted without processing`.
  - `end to end through a real queue`: enqueue against test Redis, start a `Worker` in-test, await completion, row `completed`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** runner, `handleDelivery`, queue helpers, worker entry.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api-ts): BullMQ worker with claim-token retries`

---

### Task 5: HTTP API (Fastify)

**Files:**
- Create: `apps/api-ts/src/http/app.ts`, `src/http/errors.ts`, `src/http/routes/images.ts`, `src/http/upload.ts`, `src/http/resource.ts`, `src/server.ts`
- Test: `apps/api-ts/test/http/upload.test.ts`, `test/http/show.test.ts`, `test/http/download.test.ts`

**Interfaces:**
- Consumes: `JobRepository`, `enqueue`, `Config`, `toLaravelJson`, errors.
- Produces:
  - `buildApp(deps: { config: Config; repo: JobRepository; enqueue: (id: string) => Promise<void> }): FastifyInstance` (tests pass a fake `enqueue`).
  - `apiError(reply, code: string, message: string, status: number, extra?: Record<string, unknown>)`.
  - `toResource(job: ImageJob): ImageJobResource` — same keys and nulling rules as `ImageJobResource.php`.
  - `sanitiseName(name: string): string` — same rules as the controller.
  - `src/server.ts`: load config, optionally `runMigrations`, `listen({ host: '0.0.0.0', port: 8000 })`, close on SIGTERM.

- [ ] **Step 1: Write the failing tests** (Fastify `inject`, multipart bodies built with `form-data` or a small helper), ported from `UploadImageTest.php`, `ShowImageJobTest.php`, `DownloadImageTest.php`:
  - Upload: `accepts jpg, png, webp and returns 202` (body `{job_id, status:'pending', status_url:'/api/images/<id>', created_at}`, `Location` header equal to `status_url`, file at `uploads/<id>.<ext>`, row pending, `enqueue` called with id); `accepts uppercase and .jpeg extensions` (ext from sniffed type: `jpg`); `missing file is rejected` (422 `validation_failed`, message "Please choose an image to upload.", `fields.image[0]` same); `rejects file over 20 MB` (20 MB + 1 byte → 422 "File is larger than 20 MB."); `rejects wrong type` and `rejects text file named .jpg` (422 "File must be a JPG, PNG or WebP image."); `queue down marks failed and returns 503` (fake `enqueue` rejects → 503 `queue_unavailable`, message "The processing service is temporarily unavailable. Please try again shortly.", `error.job_id` set, row `failed`).
  - Review Focus tests: `body over 26 MB returns 413 file_too_large` ("File is larger than 20 MB."); `over-limit upload leaves no file in uploads/`; `aborted upload leaves no file and no row`; `name is sanitised` (`'../../etc/pa\u0001sswd.jpg'` → `'passwd.jpg'`, 300 chars → 200, `'\u0001'` → `'image'`); `real Redis down returns 503 within 2.5 s` (use `createQueue` pointed at an unused port).
  - Show: `pending shape` (exact key set and values from the PHP test, incl. `original.size 18234567`, `created_at` matching `/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000000Z$/`); `completed includes result and download_url`; `failed includes error`; `expired completed job has no download_url` (`expired: true`); `unknown id 404` and `malformed id 404` (`not_found`, "Job not found.").
  - Download: `streams webp with filename` (200, `Content-Type: image/webp`, disposition contains `attachment` and `photo.webp`, body equals the stored bytes); `non-ASCII filename has fallback and utf8` (`фото 1.jpg` → contains `filename*=utf-8''` + `encodeURIComponent('фото 1.webp')`, and matches `/filename="[\x20-\x7e]+\.webp"/`); `409 when not completed` ("This image isn't ready yet (status: pending)."); `410 when expired` ("This result has expired. Please upload the image again."); `404 unknown`.
  - `GET /up` → 200.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `onRequest` hook: `content-length` > 26 MiB → 413 before reading. Register `@fastify/multipart` with `limits: { fileSize: maxUploadBytes, files: 1 }`; stream the part to `uploads/<uuidv7>.part`; if `file.truncated` → delete, 422 size message; sniff with `fileTypeFromFile`; not jpeg/png/webp → delete, 422 type message; rename to final ext; insert; `enqueue`; on error `markFailed('queue_unavailable')` → 503. Request aborts delete the `.part` file. UUID route param validated with a zod uuid schema; failure → 404. Custom `setErrorHandler`/`setNotFoundHandler` produce the shared error shape (500 → `internal_error`, "Something went wrong on our side. Please try again."). Download sets `Content-Disposition: attachment; filename="<ascii fallback>"; filename*=utf-8''<encoded>` (ASCII fallback: replace non-printable-ASCII with `_`, matching Symfony's behaviour) and streams the file.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api-ts): Fastify upload, status and download endpoints`

---

### Task 6: Scheduler — reaper and retention cleanup

**Files:**
- Create: `apps/api-ts/src/maintenance/reap-stale.ts`, `src/maintenance/cleanup.ts`, `src/scheduler.ts`
- Test: `apps/api-ts/test/maintenance/reap-stale.test.ts`, `test/maintenance/cleanup.test.ts`, `test/maintenance/scheduler.test.ts`

**Interfaces:**
- Consumes: `JobRepository`, `Db`, `Config`, `MAX_TRIES`.
- Produces: `reapStaleJobs(deps, now?: Date): Promise<number>`; `cleanupExpiredJobs(deps, now?: Date): Promise<number>`; `SCHEDULE = { reap: '* * * * *', cleanup: '0 * * * *' } as const`; `startScheduler(deps): { stop(): void }` using croner with `protect: true` (no overlap).

- [ ] **Step 1: Write the failing tests**, ported from `ReapStaleImageJobsTest.php` and `CleanupImageJobsTest.php`:
  - Reap: `marks old processing jobs failed` (attempts 3, started 601 s ago → `worker_lost`, "Processing didn't finish in time. Please try again."); `ignores recent processing`; `keeps job whose retry is still queued` (attempts 1, started 601 s ago → untouched); `reaps early attempt after lost threshold` (attempts 1, 3601 s ago → failed); `never touches pending`; `never touches terminal`; `respects configured threshold`; `outputs count` (returns number reaped).
  - Cleanup: `expires old completed jobs and deletes files` (created 25 h ago → both files gone, `expired_at` set); `expires old failed jobs`; `leaves recent jobs alone`; `never touches unfinished jobs`; `tolerates missing files and is idempotent` (second run returns 0).
  - Scheduler: `SCHEDULE.reap` is every minute, `SCHEDULE.cleanup` is hourly.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with the same WHERE clauses as the PHP commands; cleanup's per-row update guarded by `expired_at IS NULL`; missing files ignored (`ENOENT`).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api-ts): stale-job reaper and retention cleanup`

---

### Task 7: Full compose stack and a smoke test for both backends

**Files:**
- Modify: `docker-compose.ts.yml` (add `api`, `worker`, `scheduler`, `web`)
- Create: `apps/api-ts/scripts/smoke-image.mjs`
- Modify: `scripts/smoke.sh`, `package.json` (root)

**Interfaces:**
- Consumes: entries `dist/server.js`, `dist/worker.js`, `dist/scheduler.js`.
- Produces: `smoke-image.mjs generate <w> <h>` (JPEG to stdout) and `smoke-image.mjs dims` (reads stdin, prints `WxH`), copied into the image. Root scripts `up:ts`, `down:ts`, `test:api-ts`, `smoke:ts`.

- [ ] **Step 1: Compose services.** Shared `x-api-env` with the same `IMAGE_*`/`DB_*`/`REDIS_*` defaults as `docker-compose.yml` plus `TZ: UTC`. `api` (host `8001:8000`, `RUN_MIGRATIONS: "true"`, healthcheck `wget -qO- http://localhost:8000/up`), `worker` (`node dist/worker.js`, `stop_grace_period: 130s`, depends on api healthy), `scheduler` (`node dist/scheduler.js`), all sharing volume `images-data:/app/storage/images`; `web` built from `./apps/web` on `8081:8080`. Own volumes `postgres-data`, `redis-data`, `images-data` (namespaced by project name).
- [ ] **Step 2: Smoke script.** Add `COMPOSE="${COMPOSE:-docker compose}"`; detect the stack by `$COMPOSE exec -T worker node -v` succeeding; replace both `php` steps with `node scripts/smoke-image.mjs generate 4000 3000` and `... dims` for the TS stack, keeping the PHP lines for Laravel.
- [ ] **Step 3: Run** `docker compose -f docker-compose.ts.yml up -d --build`, then `BASE_URL=http://localhost:8081 COMPOSE="docker compose -f docker-compose.ts.yml" bash scripts/smoke.sh`. Expected: `PASS: ... byte WebP, 1280x960`.
- [ ] **Step 4: Run** the Laravel stack at the same time (`docker compose up -d --build`) and `bash scripts/smoke.sh`. Expected: `PASS` for both, no port clash.
- [ ] **Step 5: Crash check.** With `IMAGE_PROCESSING_DELAY_MS=8000`, upload, `docker compose -f docker-compose.ts.yml kill worker` while `processing`, start it again. Expected: the job completes with `attempts` 2.
- [ ] **Step 6: Commit** `feat(api-ts): compose stack and shared smoke test`

---

### Task 8: README with separate Laravel and Fastify sections

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Restructure** as the spec's Docs section says: shared top (what it does, state diagram, HTTP API contract, frontend, "pick a backend" with both commands and ports); **Laravel backend** section (move today's Laravel-specific content in, unchanged in substance); **Fastify backend** section with the same headings (quick start, tests, env vars, architecture, why BullMQ/sharp/Drizzle, decisions incl. `attemptsStarted` as claim token and the 3-delivery cap, `apps/api-ts` layout); a **Laravel vs Fastify** comparison table (HTTP, validation, queue, retries/claim token, timeout, image library, ORM/migrations, scheduler, tests).
- [ ] **Step 2: Check** every command in the README runs as written (the ones from Task 7 steps 3–4 and both test commands).
- [ ] **Step 3: Commit** `docs: separate README sections for Laravel and Fastify backends`
