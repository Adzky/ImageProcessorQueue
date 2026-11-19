<?php

namespace App\Console\Commands;

use App\Enums\ImageErrorCode;
use App\Enums\ImageJobStatus;
use App\Models\ImageJob;
use Illuminate\Console\Command;

/**
 * Safety net for jobs whose worker died and that the queue can no longer recover
 * (e.g. every worker was down until after the last attempt). A single attempt can't
 * run longer than the 120 s timeout + 150 s retry window, so a claim older than
 * `images.stale_after_seconds` (default 600 s) is definitely abandoned.
 *
 * Pending jobs are never reaped: a backlog behind busy workers is normal.
 */
class ReapStaleImageJobs extends Command
{
    protected $signature = 'images:reap-stale';

    protected $description = 'Fail image jobs stuck in "processing" after their worker died';

    public function handle(): int
    {
        $reaped = 0;

        ImageJob::query()
            ->where('status', ImageJobStatus::Processing->value)
            ->where('started_at', '<', now()->subSeconds((int) config('images.stale_after_seconds')))
            ->each(function (ImageJob $job) use (&$reaped) {
                if ($job->markFailed(ImageErrorCode::WorkerLost)) {
                    $reaped++;
                }
            });

        $this->info("Reaped {$reaped} stale job(s).");

        return self::SUCCESS;
    }
}
