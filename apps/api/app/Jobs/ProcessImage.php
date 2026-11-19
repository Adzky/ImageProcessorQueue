<?php

namespace App\Jobs;

use App\Enums\ImageErrorCode;
use App\Images\ImageJobRunner;
use App\Images\PermanentImageFailure;
use App\Models\ImageJob;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Queue job consumed by the `worker` container only.
 *
 * - Transient errors (I/O, DB) are rethrown so Laravel retries with backoff.
 * - Permanent errors (bad input) fail immediately: retrying can't fix them.
 * - If the worker process dies mid-job, the Redis reservation expires after `retry_after`
 *   and a worker re-reserves it with a higher attempt number, which lets it re-claim the row.
 */
class ProcessImage implements ShouldQueue
{
    use Queueable;

    public int $tries = 3;

    public int $timeout = 120;

    public function __construct(public string $imageJobId) {}

    /** @return list<int> seconds to wait before retry 1 and retry 2 */
    public function backoff(): array
    {
        return [5, 15];
    }

    public function handle(ImageJobRunner $runner): void
    {
        try {
            $runner->run($this->imageJobId, $this->attempts());
        } catch (PermanentImageFailure $e) {
            $this->fail($e);
        }
    }

    /** Called once the job is given up on: permanent failure, retries exhausted, or timeout. */
    public function failed(?Throwable $e): void
    {
        $code = $e instanceof PermanentImageFailure ? $e->errorCode : ImageErrorCode::RetriesExhausted;

        ImageJob::find($this->imageJobId)?->markFailed($code);

        Log::error('Image job failed', [
            'job_id' => $this->imageJobId,
            'error_code' => $code->value,
            'exception' => $e,
        ]);
    }
}
