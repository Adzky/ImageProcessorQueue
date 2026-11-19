<?php

namespace App\Console\Commands;

use App\Enums\ImageJobStatus;
use App\Models\ImageJob;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Storage;

/**
 * Deletes the files of finished jobs older than `images.retention_hours` and marks the
 * rows expired. Rows are kept (they're tiny) so the API can answer 410 Gone instead of
 * 404, telling the user the result existed but has been removed.
 */
class CleanupImageJobs extends Command
{
    protected $signature = 'images:cleanup';

    protected $description = 'Delete files of finished image jobs past the retention period';

    public function handle(): int
    {
        $disk = Storage::disk(config('images.disk'));
        $expired = 0;

        ImageJob::query()
            ->whereIn('status', [ImageJobStatus::Completed->value, ImageJobStatus::Failed->value])
            ->whereNull('expired_at')
            ->where('created_at', '<', now()->subHours((int) config('images.retention_hours')))
            ->each(function (ImageJob $job) use ($disk, &$expired) {
                $disk->delete(array_filter([$job->original_path, $job->result_path]));

                $expired += ImageJob::query()
                    ->whereKey($job->id)
                    ->whereNull('expired_at')
                    ->update(['expired_at' => now(), 'updated_at' => now()]);
            });

        $this->info("Expired {$expired} job(s).");

        return self::SUCCESS;
    }
}
