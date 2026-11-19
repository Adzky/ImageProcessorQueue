<?php

namespace App\Console\Commands;

use App\Enums\ImageErrorCode;
use App\Enums\ImageJobStatus;
use App\Jobs\ProcessImage;
use App\Models\ImageJob;
use Illuminate\Console\Command;
use Illuminate\Database\Eloquent\Builder;

/**
 * Safety net for jobs whose worker died and that the queue will not recover.
 *
 * - On the final attempt, no retry is coming: a claim older than `images.stale_after_seconds`
 *   (default 600 s, well beyond the 120 s timeout + 150 s retry window) is abandoned.
 * - On earlier attempts a retry is still queued and may just be waiting behind a backlog, so
 *   the row is only reaped after `images.lost_after_seconds` (default 1 h), when the queue
 *   message itself must have been lost.
 *
 * Pending jobs are never reaped: a backlog behind busy workers is normal.
 */
class ReapStaleImageJobs extends Command
{
    protected $signature = 'images:reap-stale';

    protected $description = 'Fail image jobs stuck in "processing" after their worker died';

    public function handle(): int
    {
        $stale = now()->subSeconds((int) config('images.stale_after_seconds'));
        $lost = now()->subSeconds((int) config('images.lost_after_seconds'));
        $reaped = 0;

        ImageJob::query()
            ->where('status', ImageJobStatus::Processing->value)
            ->where(fn (Builder $q) => $q
                ->where(fn (Builder $final) => $final
                    ->where('attempts', '>=', ProcessImage::MAX_TRIES)
                    ->where('started_at', '<', $stale))
                ->orWhere('started_at', '<', $lost))
            ->each(function (ImageJob $job) use (&$reaped) {
                if ($job->markFailed(ImageErrorCode::WorkerLost)) {
                    $reaped++;
                }
            });

        $this->info("Reaped {$reaped} stale job(s).");

        return self::SUCCESS;
    }
}
