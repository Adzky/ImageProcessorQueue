<?php

namespace Tests\Feature;

use App\Enums\ImageErrorCode;
use App\Enums\ImageJobStatus;
use App\Models\ImageJob;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ReapStaleImageJobsTest extends TestCase
{
    use RefreshDatabase;

    private function job(ImageJobStatus $status, ?\DateTimeInterface $startedAt, ?\DateTimeInterface $createdAt = null, int $attempts = 3): ImageJob
    {
        $job = ImageJob::create([
            'original_name' => 'a.jpg', 'original_mime' => 'image/jpeg', 'original_size' => 1, 'original_path' => 'uploads/a.jpg',
            'status' => $status,
            'attempts' => $status === ImageJobStatus::Processing ? $attempts : 0,
            'started_at' => $startedAt,
        ]);
        if ($createdAt) {
            $job->forceFill(['created_at' => $createdAt])->saveQuietly();
        }

        return $job;
    }

    public function test_marks_old_processing_jobs_failed(): void
    {
        $job = $this->job(ImageJobStatus::Processing, now()->subMinutes(11));

        $this->artisan('images:reap-stale')->assertSuccessful();

        $job->refresh();
        $this->assertSame(ImageJobStatus::Failed, $job->status);
        $this->assertSame(ImageErrorCode::WorkerLost, $job->error_code);
    }

    public function test_keeps_job_whose_retry_is_still_queued(): void
    {
        // Attempt 1 crashed 11 min ago; its retry is waiting behind a backlog in Redis.
        $job = $this->job(ImageJobStatus::Processing, now()->subMinutes(11), attempts: 1);

        $this->artisan('images:reap-stale')->assertSuccessful();

        $this->assertSame(ImageJobStatus::Processing, $job->refresh()->status);
    }

    public function test_reaps_early_attempt_after_lost_threshold(): void
    {
        // No retry has shown up for over an hour: the queue message is gone.
        $job = $this->job(ImageJobStatus::Processing, now()->subMinutes(61), attempts: 1);

        $this->artisan('images:reap-stale')->assertSuccessful();

        $this->assertSame(ImageErrorCode::WorkerLost, $job->refresh()->error_code);
    }

    public function test_ignores_recent_processing(): void
    {
        $job = $this->job(ImageJobStatus::Processing, now()->subMinutes(5));

        $this->artisan('images:reap-stale')->assertSuccessful();

        $this->assertSame(ImageJobStatus::Processing, $job->refresh()->status);
    }

    public function test_never_touches_pending(): void
    {
        $job = $this->job(ImageJobStatus::Pending, null, now()->subHours(2));

        $this->artisan('images:reap-stale')->assertSuccessful();

        $this->assertSame(ImageJobStatus::Pending, $job->refresh()->status);
    }

    public function test_never_touches_terminal(): void
    {
        $job = $this->job(ImageJobStatus::Completed, now()->subHours(2));

        $this->artisan('images:reap-stale')->assertSuccessful();

        $this->assertSame(ImageJobStatus::Completed, $job->refresh()->status);
    }

    public function test_respects_configured_threshold(): void
    {
        config(['images.stale_after_seconds' => 60]);
        $job = $this->job(ImageJobStatus::Processing, now()->subMinutes(2));

        $this->artisan('images:reap-stale')->assertSuccessful();

        $this->assertSame(ImageJobStatus::Failed, $job->refresh()->status);
    }

    public function test_outputs_count(): void
    {
        $this->job(ImageJobStatus::Processing, now()->subMinutes(20));
        $this->job(ImageJobStatus::Processing, now()->subMinutes(30));
        $this->job(ImageJobStatus::Processing, now());

        $this->artisan('images:reap-stale')
            ->expectsOutputToContain('Reaped 2 stale job(s).')
            ->assertSuccessful();
    }

    public function test_is_scheduled_every_minute(): void
    {
        $event = collect(app(Schedule::class)->events())
            ->first(fn ($e) => str_contains($e->command ?? '', 'images:reap-stale'));

        $this->assertNotNull($event, 'images:reap-stale is not scheduled');
        $this->assertSame('* * * * *', $event->expression);
    }
}
