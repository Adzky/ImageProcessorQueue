# Image Processing App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a React + Laravel app where an uploaded image is acknowledged immediately with a `job_id`, processed to WebP (≤1280 px, quality 80) by a separate queue-worker container, and downloadable once complete. The whole thing runs with `docker compose up --build`.

**Architecture:** There is one Laravel codebase running in three containers. `api` serves HTTP and only stores uploads and dispatches jobs. `worker` runs `queue:work` on Redis and does all image processing. `scheduler` runs the stale-job reaper. Job state lives in Postgres, guarded by conditional updates that use the queue attempt number as a claim token. An nginx `web` container serves the React SPA and proxies `/api` to `api`.

**Tech Stack:** PHP 8.4.27+, Laravel 13.x, FrankenPHP, Intervention Image v3 (Imagick driver), Postgres 17, Redis 7, React 19 + Vite + TypeScript, pnpm, Vitest, PHPUnit, Docker Compose.

**Spec:** `docs/design/2026-11-20-image-processing-design.md`. Read it first. §2a (one-day scope) overrides the rest where they conflict.

## Global Constraints

- PHP **≥ 8.4.27** on the 8.4 line. The Dockerfile fails the build if `version_compare(PHP_VERSION, '8.4.27', '<')`.
- Laravel **13.x** (`laravel/framework:^13.0`).
- Required PHP extensions: `pcntl`, `imagick`, `pdo_pgsql`, `redis`. Entrypoints `exec` their final command.
- Upload limit: JPG/PNG/WebP, **20480 KB**. PHP `upload_max_filesize=25M`, `post_max_size=25M`. Body limit at the web servers: **26 MB**.
- Processing: longest side **≤ 1280 px**, aspect preserved, never upscale, WebP quality **80**, reject over **50,000,000 pixels**, EXIF auto-orient, strip metadata, first frame only for animations.
- Queue: connection `redis`, queue `images`, `tries=3`, `timeout=120`, `backoff=[5,15]`, `retry_after=150`. Redis runs with `--appendonly yes`.
- Lifecycle: `pending → processing → completed | failed`. Status never goes backwards. Terminal rows never change.
- Reaper: `processing` rows whose `started_at` is older than **600 s** become `failed` / `worker_lost`. `pending` rows are never reaped.
- Error JSON shape: `{"error": {"code": "...", "message": "..."}}`.
- No `.env` is needed to run. Compose provides every default, and `APP_KEY` is a fixed demo key.
- All `*.sh`, `Dockerfile` and `Caddyfile` files use LF line endings (`.gitattributes`).
- Ports: web **8080**, api **8000**.
- Frontend package manager: **pnpm**, invoked as `corepack pnpm` (no global install needed).
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A `.JPG` / `.jpeg` / uppercase-extension upload** is accepted, and the stored original uses an extension derived from the detected MIME type (`jpg`, `png`, `webp`). The test is in Task 3.
2. **A PNG with transparency** comes out as WebP with its alpha channel intact. It is not flattened onto black or white. The test is in Task 4.
3. **A very tall, narrow image** (e.g. 100×5000) gives 26×1280, never a 0-width image. The test is in Task 4.
4. **A CMYK JPEG** comes out in sRGB, with colours that aren't inverted. The test is in Task 4.
5. **A non-ASCII original filename** (e.g. `фото 1.jpg`) downloads with a valid `Content-Disposition` (ASCII fallback plus `filename*`) named `фото 1.webp`. The test is in Task 3.

---

## File Structure

```
.gitattributes, .gitignore, .env.example, docker-compose.yml, package.json, README.md
docker/postgres/init-test-db.sh            creates images_test database
apps/api/                                  Laravel 13 (create-project), plus:
  Dockerfile                               targets: base (php+ext+composer), app (code + --no-dev vendor)
  docker/Caddyfile                         FrankenPHP site on :8000, body limit 26MB
  docker/php.ini                           upload/post limits
  docker/entrypoint.sh                     wait-for-db, migrate (api role only), exec "$@"
  config/images.php                        all IMAGE_* settings
  app/Enums/ImageJobStatus.php             backed enum
  app/Enums/ImageErrorCode.php             backed enum + message()
  app/Models/ImageJob.php                  model + state-transition methods
  app/Images/ImageProcessor.php            pure transform: source path → dest path → result
  app/Images/ProcessedImage.php            readonly DTO
  app/Images/PermanentImageFailure.php     exception carrying ImageErrorCode
  app/Images/ImageJobRunner.php            claim → process → complete, given (jobId, attempt)
  app/Jobs/ProcessImage.php                thin queue job wrapping ImageJobRunner
  app/Http/Controllers/ImageJobController.php  store/show/download
  app/Http/Requests/StoreImageRequest.php
  app/Http/Resources/ImageJobResource.php
  app/Console/Commands/ReapStaleImageJobs.php
  routes/api.php, routes/console.php, bootstrap/app.php (api routing, error rendering)
  database/migrations/xxxx_create_image_jobs_table.php
  tests/Support/MakesImages.php            trait generating fixture images with Imagick
  tests/Unit/ImageJobTransitionsTest.php
  tests/Unit/ImageProcessorTest.php
  tests/Feature/UploadImageTest.php, ShowImageJobTest.php, DownloadImageTest.php
  tests/Feature/ImageJobRunnerTest.php, ProcessImageJobTest.php, ReapStaleImageJobsTest.php
apps/web/                                  Vite react-ts template, plus:
  Dockerfile, nginx.conf
  src/api/types.ts, src/api/client.ts
  src/lib/validateFile.ts, src/lib/pollWithBackoff.ts, src/lib/format.ts
  src/hooks/useJobStatus.ts
  src/components/Dropzone.tsx, JobCard.tsx, StatusTimeline.tsx
  src/App.tsx, src/App.css
  src/lib/*.test.ts
scripts/smoke.sh                           (stretch)
```

## Shared Interfaces (referenced by tasks)

**`App\Enums\ImageJobStatus`** (string): `Pending='pending'`, `Processing='processing'`, `Completed='completed'`, `Failed='failed'`; `isTerminal(): bool`.

**`App\Enums\ImageErrorCode`** (string), `message(): string`:

| case | value | message |
|---|---|---|
| CorruptImage | `corrupt_image` | "This file couldn't be read as an image. It may be corrupted." |
| UnsupportedImage | `unsupported_image` | "This image format isn't supported. Please upload a JPG, PNG or WebP." |
| DimensionsTooLarge | `dimensions_too_large` | "This image is too large to process (over 50 megapixels)." |
| RetriesExhausted | `retries_exhausted` | "We couldn't process this image after 3 attempts. Please try again." |
| WorkerLost | `worker_lost` | "Processing didn't finish in time. Please try again." |
| QueueUnavailable | `queue_unavailable` | "The processing service is temporarily unavailable. Please try again shortly." |

**`config('images.*')`**: `max_upload_kb` (20480), `max_dimension` (1280), `quality` (80), `max_pixels` (50000000), `stale_after_seconds` (600), `retention_hours` (24), `processing_delay_ms` (0), `disk` (`'images'`), `queue` (`'images'`). Each one reads `IMAGE_*` from the environment. The filesystem disk `images` is local, rooted at `storage_path('app/images')`.

**Frontend `Job` type** (`src/api/types.ts`) mirrors `GET /api/images/{id}` from spec §7. It adds `expired: boolean` and uses `type JobStatus = 'pending'|'processing'|'completed'|'failed'`.

---

### Task 1: Repository, containers, Laravel skeleton

**Files:**
- Create: `.gitattributes`, `.gitignore`, `.env.example`, `docker-compose.yml`, `package.json`, `docker/postgres/init-test-db.sh`
- Create: `apps/api/` via `composer create-project`, `apps/api/Dockerfile`, `apps/api/docker/{Caddyfile,php.ini,entrypoint.sh}`
- Modify: `apps/api/bootstrap/app.php` (add `api: __DIR__.'/../routes/api.php'`, keep `health: '/up'`), `apps/api/phpunit.xml`, `apps/api/config/filesystems.php` (add `images` disk), `apps/api/config/queue.php` (redis `retry_after` → `env('REDIS_QUEUE_RETRY_AFTER', 150)`)
- Create: `apps/api/config/images.php`, `apps/api/routes/api.php` (empty group for now)

**Interfaces:**
- Produces: `docker compose --profile test run --rm api-test [cmd]` runs any artisan/composer/test command against a bind-mounted `apps/api` with Postgres available. The default command is `sh -c "composer install --no-interaction && php artisan test"`. Later tasks use it for every backend test run.

- [ ] **Step 1: `git init`, add `.gitattributes`** with `* text=auto eol=lf` and binary rules for `*.png *.jpg *.jpeg *.webp`. Add a `.gitignore` covering `apps/api/vendor`, `apps/api/.env`, `apps/web/node_modules`, `apps/web/dist`, and `apps/api/storage/app/images`. Commit the design doc and this plan first: `docs: add design and implementation plan`.

- [ ] **Step 2: Scaffold Laravel 13**

Run: `docker run --rm -v "${PWD}/apps:/app" -w /app composer:2 create-project laravel/laravel:^13.0 api --no-install --no-scripts`
Expected: `apps/api/composer.json` requires `laravel/framework` `^13.0`. Delete the frontend scaffolding Laravel ships (`resources/js`, `resources/css`, `vite.config.js`, `package.json`). The API serves no views.

- [ ] **Step 3: Write `apps/api/Dockerfile`.** `base` is built from `dunglas/frankenphp:1-php8.4`. It runs `install-php-extensions pcntl imagick pdo_pgsql redis` and copies `composer` from `composer:2`. It then fails the build with `RUN php -r 'exit(version_compare(PHP_VERSION,"8.4.27","<") ? 1 : 0);'`, copies `docker/php.ini` to `$PHP_INI_DIR/conf.d/zz-app.ini` and `docker/Caddyfile` to `/etc/frankenphp/Caddyfile`, and sets `WORKDIR /app`. `app` is built FROM base. It runs `composer install --no-dev --no-scripts` on the lock files first (for layer caching), then copies the code, then runs `composer dump-autoload -o`, `chown` on storage, `ENTRYPOINT ["/app/docker/entrypoint.sh"]` and `CMD ["frankenphp","run","--config","/etc/frankenphp/Caddyfile"]`.
  - `Caddyfile`: global `{ frankenphp }`, site `:8000 { root * /app/public; request_body { max_size 26MB }; encode zstd gzip; php_server }`.
  - `entrypoint.sh`: wait for `pg_isready`-equivalent (loop on `php artisan db:monitor` or `nc -z postgres 5432`, 30 s max). If `RUN_MIGRATIONS=true`, run `php artisan migrate --force`. Create `storage/app/images/{uploads,results}`. `exec "$@"`.

- [ ] **Step 4: Write `docker-compose.yml`** with services `postgres` (`postgres:17-alpine`, env `POSTGRES_DB=images`, user `images`, password `secret`, mounts `./docker/postgres/init-test-db.sh` into `/docker-entrypoint-initdb.d/`, healthcheck `pg_isready -U images`), `redis` (`redis:7-alpine`, `command: redis-server --appendonly yes`, healthcheck `redis-cli ping`), `api`, `worker`, `scheduler` and `api-test`.
  - `api`, `worker` and `scheduler` use build `apps/api` with target `app`. They share an `x-api-env` anchor holding every default from spec §10, including a fixed base64 `APP_KEY` and `QUEUE_CONNECTION=redis`. They share the `images-data` volume at `/app/storage/app/images` and use `restart: unless-stopped`.
  - `api`: `RUN_MIGRATIONS=true`, port `8000:8000`, healthcheck `curl -fsS http://localhost:8000/up`, depends on healthy postgres and redis.
  - `worker`: `command: ["php","artisan","queue:work","redis","--queue=images","--tries=3","--timeout=120","--sleep=1"]`, `stop_grace_period: 130s`, depends on healthy `api`.
  - `scheduler`: `command: ["php","artisan","schedule:work"]`, depends on healthy `api`.
  - `api-test`: `profiles: [test]`, target `base`, bind-mounts `./apps/api:/app`, env `DB_DATABASE=images_test`, depends on healthy postgres. Its command is the one given under Interfaces.
  - `init-test-db.sh` runs `CREATE DATABASE images_test OWNER images;`.

- [ ] **Step 5: Configure tests.** In `phpunit.xml`, set `DB_CONNECTION=pgsql`, `DB_HOST=postgres`, `DB_DATABASE=images_test`, `DB_USERNAME=images`, `DB_PASSWORD=secret`, `QUEUE_CONNECTION=sync`, `CACHE_STORE=array`. Then add Intervention Image: `docker compose --profile test run --rm api-test composer require intervention/image:^3`.

- [ ] **Step 6: Verify**

Run: `docker compose --profile test run --rm api-test`
Expected: the default Laravel example tests PASS against Postgres.
Run: `docker compose up -d --build api worker scheduler` then `curl -fsS http://localhost:8000/up`
Expected: HTTP 200. `docker compose logs worker` shows the worker processing the `images` queue with no errors.

- [ ] **Step 7: Add root `package.json`** with `"private": true` and the scripts `"up": "docker compose up --build"`, `"test:api": "docker compose --profile test run --rm api-test"`, `"test:web": "corepack pnpm --dir apps/web test"`. Add `.env.example` listing every variable from spec §10 with its default. Commit: `chore: scaffold Laravel 13 api with compose stack (postgres, redis, worker, scheduler)`.

---

### Task 2: Job schema, enums, state transitions

**Files:**
- Create: migration `create_image_jobs_table`, `app/Enums/ImageJobStatus.php`, `app/Enums/ImageErrorCode.php`, `app/Models/ImageJob.php`
- Test: `tests/Unit/ImageJobTransitionsTest.php` (uses `RefreshDatabase`, so it needs the DB)

**Interfaces:**
- Produces on `ImageJob` (uuid PK, `$incrementing=false`, `$keyType='string'`; casts `status` → `ImageJobStatus`, timestamps → `immutable_datetime`):
  - `claim(int $attempt): bool` sets status `processing`, `attempts = $attempt` and `started_at = now()`, using `WHERE status IN (pending, processing) AND attempts < $attempt`. It returns whether a row was updated.
  - `markCompleted(int $attempt, string $resultPath, int $size, int $width, int $height, int $originalWidth, int $originalHeight): bool` uses `WHERE status = processing AND attempts = $attempt`.
  - `markFailed(ImageErrorCode $code, ?string $message = null): bool` uses `WHERE status IN (pending, processing)`. It sets `error_code`, `error_message` (defaulting to `$code->message()`) and `failed_at`.
  - All three run as a single `UPDATE` through `static::query()->whereKey($this->id)->where(...)->update([...])`, then `refresh()` on success.
- Columns: exactly as spec §7 Data model, including `expired_at`. `status` defaults to `pending` and has an index.

- [ ] **Step 1: Write failing tests.** `test_claim_moves_pending_to_processing_with_attempt` (claim(1) is true, status processing, attempts 1, started_at set). `test_claim_with_same_or_lower_attempt_is_rejected` (after claim(2), claim(2) and claim(1) are both false). `test_higher_attempt_takes_over_processing_job` (claim(1), then claim(2) is true, attempts 2, status still processing). `test_claim_rejected_on_terminal_rows` (completed and failed rows both return false). `test_complete_requires_current_owner` (claim(1), claim(2), then markCompleted(1, …) is false and markCompleted(2, …) is true). `test_mark_failed_uses_default_message_and_ignores_terminal` (the message equals `ImageErrorCode::WorkerLost->message()`, and markFailed on a completed row is false).
- [ ] **Step 2: Run** `docker compose --profile test run --rm api-test php artisan test --filter=ImageJobTransitionsTest`. Expected: FAIL (class not found).
- [ ] **Step 3: Implement** the migration, both enums and the model methods as specified in Interfaces.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): image_jobs schema with guarded state transitions`.

---

### Task 3: Upload, status and download endpoints

**Files:**
- Create: `app/Http/Controllers/ImageJobController.php`, `app/Http/Requests/StoreImageRequest.php`, `app/Http/Resources/ImageJobResource.php`, `app/Jobs/ProcessImage.php` (a stub with constructor `__construct(public string $imageJobId)` and an empty `handle()`; Task 4 fills it in)
- Modify: `routes/api.php`, `bootstrap/app.php` (exception rendering)
- Test: `tests/Feature/UploadImageTest.php`, `ShowImageJobTest.php`, `DownloadImageTest.php`, `tests/Support/MakesImages.php`

**Interfaces:**
- Consumes: `ImageJob`, `ImageJobStatus`, `ImageErrorCode` (Task 2).
- Produces: routes `POST /api/images` → `store`, `GET /api/images/{imageJob}` → `show`, `GET /api/images/{imageJob}/download` → `download`, all with `->whereUuid('imageJob')`. Also `ProcessImage::dispatch($id)->onQueue(config('images.queue'))->afterCommit()`.
- Produces `tests/Support/MakesImages.php` trait, which Task 4 reuses: `makeImage(int $w, int $h, string $format = 'jpeg', array $opts = []): string` returns the absolute path of a temp file. Options: `alpha` (bool, PNG/WebP with a transparent half), `cmyk` (bool), `orientation` (int EXIF orientation tag), `frames` (int, animated WebP). It's built with Imagick.

- [ ] **Step 1: Write failing tests** (with `Storage::fake('images')` and `Queue::fake()`):
  - `UploadImageTest`: `test_accepts_jpg_png_webp_and_returns_202` (data provider over the three formats). It asserts `202`, a JSON `job_id` that is a UUID, `status=pending`, `status_url=/api/images/{id}`, a `Location` header, a row in `pending`, a file at `uploads/{id}.{jpg|png|webp}`, and `Queue::assertPushedOn('images', ProcessImage::class)`. Also: `test_accepts_uppercase_and_jpeg_extensions` (`PHOTO.JPG` and `x.jpeg` are stored as `.jpg`); `test_rejects_file_over_20mb` (a 20481 KB `UploadedFile::fake()->create('big.jpg', 20481, 'image/jpeg')` gives `422`, `error.code=validation_failed`, and a message containing "20 MB"); `test_rejects_wrong_type` (a `.gif` gives `422` with a message containing "JPG, PNG or WebP"); `test_rejects_text_file_named_jpg` (content sniffing gives `422`); `test_queue_down_marks_failed_and_returns_503` (bind a `Dispatcher` that throws, then assert `503`, `error.code=queue_unavailable`, and the row is failed).
  - `ShowImageJobTest`: `test_pending_shape` (the exact keys from spec §7, with `result`, `download_url` and `error` null and `expired` false); `test_completed_includes_result_and_download_url`; `test_failed_includes_error`; `test_unknown_id_404` and `test_malformed_id_404` (`/api/images/not-a-uuid` gives `404` with `error.code=not_found`, never `500`).
  - `DownloadImageTest`: `test_404_unknown`; `test_409_when_not_completed` (`error.code=not_ready`); `test_410_when_expired` (`error.code=expired`); `test_streams_webp_with_filename` (`Content-Type: image/webp`, and the disposition contains `photo.webp`); `test_non_ascii_filename_has_fallback_and_utf8` (the original `фото 1.jpg` gives a disposition containing `filename*=utf-8''` and the encoded `фото 1.webp`).
- [ ] **Step 2: Run** `… api-test php artisan test --filter='UploadImageTest|ShowImageJobTest|DownloadImageTest'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `StoreImageRequest` rules, in this order so that an oversized file reports size first: `image` is `required|file|max:` + `config('images.max_upload_kb')` + `|mimes:jpg,jpeg,png,webp|mimetypes:image/jpeg,image/png,image/webp`. Use `bail` so only the first failure is reported. Custom messages: "File is larger than 20 MB." and "File must be a JPG, PNG or WebP image."
  - `store`: generate the id with `Str::uuid7()`, derive the extension from the detected MIME type, call `storeAs("uploads", "{$id}.{$ext}", 'images')`, create the row with a sanitised `original_name` (`basename`, control characters stripped), the detected MIME type and the size, then dispatch. If dispatch throws, call `markFailed(QueueUnavailable)` and respond `503`.
  - `show`: return `ImageJobResource`, unwrapped (call `JsonResource::withoutWrapping()` in a service provider).
  - `download`: check `expired_at` → 410, then status → 409, then `Storage::disk('images')->download($path, pathinfo(original_name, PATHINFO_FILENAME).'.webp', ['Content-Type' => 'image/webp'])`.
  - `bootstrap/app.php` `withExceptions`: for `api/*` requests, render `ValidationException` → 422 `validation_failed` (message = first error), `ModelNotFoundException` / `NotFoundHttpException` → 404 `not_found`, `PostTooLargeException` → 413 `file_too_large` "File is larger than 20 MB.". All of them use the shared error shape.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): upload, status and download endpoints`.

---

### Task 4: Image processing and the worker job

**Files:**
- Create: `app/Images/ImageProcessor.php`, `app/Images/ProcessedImage.php`, `app/Images/PermanentImageFailure.php`, `app/Images/ImageJobRunner.php`
- Modify: `app/Jobs/ProcessImage.php`
- Test: `tests/Unit/ImageProcessorTest.php`, `tests/Feature/ImageJobRunnerTest.php`, `tests/Feature/ProcessImageJobTest.php`

**Interfaces:**
- `final readonly class ProcessedImage { int $width; int $height; int $size; int $originalWidth; int $originalHeight; }`
- `final class PermanentImageFailure extends RuntimeException { __construct(public readonly ImageErrorCode $errorCode) }`. Its message is `$errorCode->message()`.
- `ImageProcessor::process(string $sourcePath, string $destPath): ProcessedImage` throws `PermanentImageFailure`. It writes to `"$destPath.tmp"` and then calls `rename()` to `$destPath`.
- `ImageJobRunner::run(string $imageJobId, int $attempt): void`. Its behaviour:
  - It loads the row. If the row is missing or terminal, it returns.
  - If `claim($attempt)` returns false, it returns.
  - It applies `usleep(config('images.processing_delay_ms') * 1000)`.
  - It calls `process()` on the disk paths `uploads/...` → `results/{id}.webp`, then `markCompleted(...)`.
  - It lets `PermanentImageFailure` and every other exception propagate.
- `ProcessImage implements ShouldQueue`: `$tries = 3`, `$timeout = 120`, `backoff(): array` returns `[5, 15]`. `handle(ImageJobRunner $runner)` calls `$runner->run($this->imageJobId, $this->attempts())` and catches `PermanentImageFailure $e` → `$this->fail($e)`. `failed(?Throwable $e)` finds the row and calls `markFailed($e instanceof PermanentImageFailure ? $e->errorCode : ImageErrorCode::RetriesExhausted)`. It logs the full exception with `Log::error`.

- [ ] **Step 1: Write failing `ImageProcessorTest`** using `MakesImages`:
  - `test_landscape_scaled_to_1280_wide` (4000×3000 → 1280×960).
  - `test_portrait_scaled_to_1280_tall` (3000×4000 → 960×1280).
  - `test_tall_narrow_keeps_nonzero_width` (100×5000 → 26×1280).
  - `test_small_image_not_upscaled` (800×600 → 800×600).
  - `test_output_is_webp` (`getimagesize($dest)['mime'] === 'image/webp'`).
  - `test_png_alpha_preserved` (the output pixel in the transparent half has alpha 0, read with Imagick `getImagePixelColor()->getColorValue(Imagick::COLOR_ALPHA)`).
  - `test_cmyk_converted_to_srgb` (the output colorspace is `Imagick::COLORSPACE_SRGB`, and a pure-red CMYK input still reads as red: R > 200, G < 60).
  - `test_exif_rotated_jpeg_is_upright` (a 400×200 input with orientation 6 → output 200×400).
  - `test_animated_webp_uses_first_frame` (the output has one frame).
  - `test_corrupt_file_throws_corrupt_image` (random bytes → `PermanentImageFailure` with `CorruptImage`).
  - `test_over_pixel_limit_throws` (set `config(['images.max_pixels' => 1000])`, then 100×100 → `DimensionsTooLarge`).
  - `test_no_tmp_file_left_behind`.
- [ ] **Step 2: Run** `… --filter=ImageProcessorTest`. Expected: FAIL.
- [ ] **Step 3: Implement `ImageProcessor`.**
  - Before decoding, `getimagesize()`: false → `CorruptImage`; a MIME type not in {jpeg, png, webp} → `UnsupportedImage`; `w*h > max_pixels` → `DimensionsTooLarge`.
  - Set Imagick resource limits (memory 256 MB, area = max_pixels).
  - Build an `ImageManager` with `Driver` (Imagick), `autoOrientation: true`, `decodeAnimation: false`, `strip: true`. Wrap decoder exceptions → `CorruptImage`.
  - Convert to sRGB if needed (on the core Imagick object: `transformImageColorspace(Imagick::COLORSPACE_SRGB)` when it's CMYK).
  - Call `scaleDown(width: max_dimension, height: max_dimension)`, then `toWebp(quality: config('images.quality'))->save("$dest.tmp")`, then `rename`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Write failing `ImageJobRunnerTest`** (real `images` disk via `Storage::fake('images')`, with the upload written there):
  - `test_completes_pending_job` (status completed, `results/{id}.webp` exists, result dimensions and size recorded, original dimensions recorded).
  - `test_noop_for_terminal_job` (a completed row is unchanged and no processing is done).
  - `test_noop_when_claim_lost` (a row already claimed with attempt 2 is left alone by `run($id, 2)`).
  - `test_retry_takes_over` (claimed with 1, then `run($id, 2)` completes with attempts 2).
  - `test_permanent_failure_propagates` (a corrupt upload throws `PermanentImageFailure`).

  `ProcessImageJobTest`:
  - `test_permanent_failure_fails_without_retry`: `(new ProcessImage($id))->withFakeQueueInteractions()`, `handle()`, `assertFailed()`. Then call `failed($e)` and assert the row is failed with `corrupt_image`.
  - `test_failed_hook_marks_retries_exhausted` (`failed(new RuntimeException('x'))` gives `retries_exhausted` and its message).
  - `test_job_config` (tries 3, timeout 120, `backoff()` returns `[5,15]`).
- [ ] **Step 6: Run** `… --filter='ImageJobRunnerTest|ProcessImageJobTest'`. Expected: FAIL.
- [ ] **Step 7: Implement** `ImageJobRunner` and `ProcessImage` as given under Interfaces.
- [ ] **Step 8: Run** the full suite `docker compose --profile test run --rm api-test`. Expected: all PASS.
- [ ] **Step 9: Manual end-to-end check.** Rebuild with `docker compose up -d --build api worker scheduler`. Upload with curl: `curl -F image=@<large.jpg> http://localhost:8000/api/images`. Poll `GET /api/images/{id}` until it's `completed`, then download. Expected: a WebP file whose longest side is 1280.
- [ ] **Step 10: Commit** `feat(worker): resize/compress/convert pipeline with retry-safe claims`.

---

### Task 5: Crash recovery — reaper and scheduler

**Files:**
- Create: `app/Console/Commands/ReapStaleImageJobs.php` (signature `images:reap-stale`)
- Modify: `routes/console.php` (`Schedule::command('images:reap-stale')->everyMinute()->withoutOverlapping()`)
- Test: `tests/Feature/ReapStaleImageJobsTest.php`

**Interfaces:**
- Consumes: `ImageJob::markFailed`, `ImageErrorCode::WorkerLost`, `config('images.stale_after_seconds')`.
- Produces: console output `Reaped N stale job(s).`

- [ ] **Step 1: Write failing tests.** `test_marks_old_processing_jobs_failed` (a `processing` row with `started_at` 11 min ago → `failed` / `worker_lost`). `test_ignores_recent_processing` (5 min ago → unchanged). `test_never_touches_pending` (a `pending` row created 2 h ago → unchanged). `test_outputs_count`.
- [ ] **Step 2: Run** `… --filter=ReapStaleImageJobsTest`. Expected: FAIL.
- [ ] **Step 3: Implement.** It queries `status=processing AND started_at < now()->subSeconds(stale)` and calls `markFailed(WorkerLost)` on each match.
- [ ] **Step 4: Run.** Expected: PASS. Also run `docker compose up -d --build scheduler` and check `docker compose logs scheduler` shows `images:reap-stale` running every minute.
- [ ] **Step 5: Crash demo check.** Set `IMAGE_PROCESSING_DELAY_MS=20000` on `worker` (via the shell env or `.env`). Upload, and within 20 s run `docker compose kill worker` then `docker compose start worker`. Expected: the status stays `processing`. After ~150 s it completes with `attempts=2`. Write down the exact commands you used. Task 7's README needs them.
- [ ] **Step 6: Commit** `feat(worker): reap jobs orphaned by crashed workers`.

---

### Task 6: Frontend logic — API client, validation, polling

**Files:**
- Create: `apps/web` via `corepack pnpm create vite apps/web --template react-ts`, then `corepack pnpm --dir apps/web add -D vitest jsdom @testing-library/react @testing-library/jest-dom`
- Create: `src/api/types.ts`, `src/api/client.ts`, `src/lib/validateFile.ts`, `src/lib/pollWithBackoff.ts`, `src/lib/format.ts`, `src/hooks/useJobStatus.ts`
- Test: `src/lib/validateFile.test.ts`, `src/lib/pollWithBackoff.test.ts`, `src/api/client.test.ts`
- Modify: `apps/web/package.json` scripts (`"test": "vitest run"`), `vite.config.ts` (vitest `environment: 'jsdom'`; dev server proxy `/api` → `VITE_API_PROXY ?? 'http://localhost:8000'`. Using a proxy instead of Laravel CORS is a plan-level call: it keeps dev same-origin, like production.)

**Interfaces:**
- `class ApiError extends Error { status: number; code: string }`. A network failure uses `status: 0` and `code: 'network_error'`. A `413` becomes `code: 'file_too_large'` with the message "File is larger than 20 MB.".
- `uploadImage(file: File, onProgress?: (fraction: number) => void): Promise<{ job_id: string; status: 'pending'; status_url: string }>` uses `XMLHttpRequest` (for upload progress) to `${BASE}/images`, where `BASE = import.meta.env.VITE_API_BASE_URL ?? '/api'`.
- `getJob(id: string): Promise<Job>` uses `fetch`. A non-2xx response becomes an `ApiError` built from the `error` body.
- `validateFile(file: File): string | null` returns `"File must be a JPG, PNG or WebP image."` or `"File is larger than 20 MB."` (limit `20 * 1024 * 1024` bytes). It accepts `image/jpeg`, `image/png` and `image/webp`, and uses the extension (`jpg|jpeg|png|webp`, case-insensitive) when `file.type` is empty.
- `nextDelay(attempt: number, random: () => number = Math.random): number` returns `min(5000, 500 * 1.5^attempt) * (0.8 + 0.4 * random())`.
- `pollWithBackoff<T>(fetchFn: () => Promise<T>, opts: { isDone: (v: T) => boolean; onValue: (v: T) => void; onError: (e: unknown) => void; onGiveUp: () => void; giveUpAfterMs?: number /* 600000 */; doc?: Document; random?: () => number }): () => void`. It returns a cancel function. The first fetch is after `nextDelay(0)`. A success resets the error streak but not the attempt growth. An error calls `onError` and keeps backing off. Polling stops once `isDone`. While `doc.visibilityState === 'hidden'` nothing is scheduled. On `visibilitychange` back to visible, it fetches immediately. After `giveUpAfterMs` of elapsed time it calls `onGiveUp` and stops.
- `useJobStatus(jobId: string | null): { job: Job | null; connectionLost: boolean; notFound: boolean; gaveUp: boolean; refresh: () => void }`. A 404 sets `notFound` and stops polling. `refresh` restarts polling.
- `format.ts`: `formatBytes(n: number): string` (`"18.2 MB"`, `"402 KB"`) and `percentSaved(original: number, result: number): number` (rounded integer).

- [ ] **Step 1: Write failing tests.**
  - `validateFile`: accepts jpg/png/webp, accepts `PHOTO.JPG` with an empty type, rejects `image/gif`, rejects 20 MB + 1 byte, accepts exactly 20 MB.
  - `nextDelay`: with `random = () => 0.5`, `[0,1,2]` → `[500,750,1125]`; attempt 20 → 5000; with `random = () => 0` attempt 0 → 400; with `() => 1` → 600.
  - `pollWithBackoff` (with `vi.useFakeTimers()`): stops after `isDone`; calls `onError` and keeps polling after a rejection; makes no fetch while a fake doc is hidden and fetches immediately when it becomes visible; calls `onGiveUp` after `giveUpAfterMs` and stops; cancel stops future fetches.
  - `client`: `getJob` maps `{error:{code:'not_found',message:'…'}}` with status 404 to an `ApiError` with `status 404, code 'not_found'`; `uploadImage` maps an XHR 413 to `code 'file_too_large'`. Stub `XMLHttpRequest` and `fetch` with `vi.stubGlobal`.
- [ ] **Step 2: Run** `corepack pnpm --dir apps/web test`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules as given under Interfaces, plus `useJobStatus` on top of `pollWithBackoff`. Cancel on unmount and when the `jobId` changes.
- [ ] **Step 4: Run** the same command. Expected: PASS. `corepack pnpm --dir apps/web exec tsc --noEmit` is clean.
- [ ] **Step 5: Commit** `feat(web): api client, validation and backoff polling`.

---

### Task 7: Frontend UI, web container, README

**Files:**
- Create: `src/components/Dropzone.tsx`, `src/components/JobCard.tsx`, `src/components/StatusTimeline.tsx`
- Modify: `src/App.tsx` and `src/App.css` (replace the template), `index.html` (title "Image Processor")
- Create: `apps/web/Dockerfile`, `apps/web/nginx.conf`, `README.md`
- Modify: `docker-compose.yml` (add `web`)

**Interfaces:**
- Consumes: everything Task 6 produces.
- `Dropzone({ disabled, onFile(file: File) })` does drag-and-drop plus a file input with `accept="image/jpeg,image/png,image/webp"`. It shows the hint "JPG, PNG or WebP · up to 20 MB" and runs `validateFile` inline.
- `StatusTimeline({ status })` shows the three steps Pending → Processing → Completed/Failed. The final step label is "Failed" when failed.
- `JobCard({ job, uploadProgress, connectionLost, notFound, gaveUp, onRefresh, onReset })`. It shows the filename and size, the job ID with a Copy button (`navigator.clipboard`), the timeline, the elapsed seconds and "attempt N of 3" while processing, and the "Connection lost, retrying…" banner. It also shows the ready line (`{w}×{h} · {size} (−{pct}%)` plus a Download WebP link `href={job.download_url}` with the `download` attribute). On failure it shows `job.error.message` plus a Try another image button. It also shows a "Still processing — check back later" line with a Refresh button for `gaveUp`, and "Job not found" for `notFound`.
- `App` holds `{ jobId, file, uploadError, uploadProgress }`. While a job is in flight it disables the dropzone. On completion it sets `document.title = '✓ Ready — Image Processor'` and announces "Your image is ready to download" through an `aria-live="polite"` region.

- [ ] **Step 1: Implement the components and App** to the interfaces above. Keep the styling plain CSS, neutral and responsive, with no UI library.
- [ ] **Step 2: Write the web container.** The `Dockerfile` has a `build` stage (`node:22-alpine`, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm build`) and a final `nginx:1.27-alpine` stage that copies `dist` and `nginx.conf`. `nginx.conf`: `listen 8080`, `client_max_body_size 26m`, `location /api/ { proxy_pass http://api:8000; proxy_request_buffering off; }`, SPA fallback `try_files $uri /index.html`. In compose: `web` is built from `apps/web`, port `8080:8080`, and depends on healthy `api`.
- [ ] **Step 3: Verify the whole stack from cold.** Run `docker compose down -v`, then `docker compose up --build`. Open http://localhost:8080 in the browser. Upload a large JPG (>10 MB): you see the job ID and pending → processing → completed, and the download is a WebP ≤1280 px. Upload a `.txt` renamed to `.jpg`: you get an inline error. Upload a corrupt PNG that passes the MIME check (a PNG header followed by junk): the card shows "This file couldn't be read as an image…". Hide the tab during processing and confirm in the network panel that polling pauses.
- [ ] **Step 4: Write `README.md`** with the sections in spec §11, items 1–8, including:
  - the environment variable table from spec §10;
  - test commands (`docker compose --profile test run --rm api-test`, `corepack pnpm --dir apps/web test`);
  - the crash-demo recipe from Task 5 Step 5;
  - the architecture diagram from spec §5;
  - the decisions: pnpm (and why no Turborepo), a single encode for compress plus convert, the attempt-number claim token, why pending rows aren't reaped, local volume vs S3, polling vs SSE;
  - "What I'd do next": everything cut in spec §2a, plus S3 with presigned URLs, Horizon, metrics, auth, rate limiting and virus scanning.

  Describe `retry_after` accurately: workers migrate expired reservations when they pop from the queue.
- [ ] **Step 5: Commit** `feat(web): upload UI with live status; add web container and README`.

---

### Stretch tasks (only after Tasks 1–7 pass; in this order)

**Task S1: Upload progress bar.** Pass `onProgress` from `App` into `uploadImage`, and render `<progress>` in `JobCard` while `uploadProgress < 1` and no `jobId` exists yet, labelled "Uploading… 42%". Verify by eye with a 15 MB file. Commit `feat(web): upload progress`.

**Task S2: `scripts/smoke.sh`.** It uses bash, curl and the `jq`-free `grep -o` approach. It generates a 4000×3000 JPEG (via `docker compose exec -T worker php -r` with Imagick, writing to stdout), POSTs it to `http://localhost:8080/api/images`, polls every 1 s for at most 120 s, downloads the result, and asserts the response starts with `RIFF....WEBP` and that `docker compose exec -T worker php -r 'print_r(getimagesize(...))'` reports a max dimension of 1280. It exits non-zero on any failure. Add `"smoke": "bash scripts/smoke.sh"` to the root `package.json` and a README line. Commit `test: end-to-end smoke script`.

**Task S3: Resume after reload.** Store `{ jobId, fileName, fileSize }` in `localStorage['imageProcessor.currentJob']` (wrapping every access in try/catch), restore it on mount, and clear it on `onReset`. Add a Vitest test for the storage helper `loadCurrentJob(): Stored | null` / `saveCurrentJob(s: Stored | null): void`: corrupt JSON → null, and storage that throws → null. Commit `feat(web): resume polling after reload`.

**Task S4: Retention cleanup.** Add an `images:cleanup` command, scheduled `hourly()`. Terminal jobs with `created_at < now() - retention_hours` and `expired_at IS NULL` get their files deleted (ignore missing files) and `expired_at = now()`. Tests: an old completed job becomes expired and its files are gone; a recent job is untouched; a non-terminal job is untouched. The download endpoint's 410 already exists (Task 3). In the frontend, `expired: true` shows "This result has expired — upload again". Commit `feat(api): retention cleanup`.
