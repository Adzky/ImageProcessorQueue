<?php

namespace App\Images;

use App\Models\ImageJob;
use Illuminate\Support\Facades\Storage;

/**
 * Executes one delivery of an image job: claim → process → complete.
 *
 * Kept separate from the queue job class so the lifecycle can be tested with explicit
 * attempt numbers. Exceptions propagate; ProcessImage decides retry vs. fail.
 */
class ImageJobRunner
{
    public function __construct(private readonly ImageProcessor $processor) {}

    public function run(string $imageJobId, int $attempt): void
    {
        $job = ImageJob::find($imageJobId);

        if ($job === null || $job->status->isTerminal()) {
            return; // already finished (duplicate delivery) or deleted
        }

        if (! $job->claim($attempt)) {
            return; // another delivery owns this job
        }

        if (($delay = (int) config('images.processing_delay_ms')) > 0) {
            usleep($delay * 1000); // demo-only: widens the window for the crash-recovery demo
        }

        $disk = Storage::disk(config('images.disk'));
        $resultPath = "results/{$job->id}.webp";
        $disk->makeDirectory('results');

        $result = $this->processor->process($disk->path($job->original_path), $disk->path($resultPath));

        $job->markCompleted(
            $attempt,
            $resultPath,
            $result->size,
            $result->width,
            $result->height,
            $result->originalWidth,
            $result->originalHeight,
        );
    }
}
