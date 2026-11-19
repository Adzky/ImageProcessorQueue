<?php

namespace Tests\Feature;

use App\Enums\ImageErrorCode;
use App\Enums\ImageJobStatus;
use App\Models\ImageJob;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class CleanupImageJobsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('images');
    }

    private function job(ImageJobStatus $status, \DateTimeInterface $createdAt): ImageJob
    {
        $job = ImageJob::create([
            'original_name' => 'a.jpg', 'original_mime' => 'image/jpeg', 'original_size' => 1,
            'original_path' => 'uploads/tmp.jpg',
        ]);
        $job->forceFill([
            'status' => $status,
            'original_path' => "uploads/{$job->id}.jpg",
            'result_path' => $status === ImageJobStatus::Completed ? "results/{$job->id}.webp" : null,
            'created_at' => $createdAt,
        ])->saveQuietly();

        Storage::disk('images')->put($job->original_path, 'orig');
        if ($job->result_path) {
            Storage::disk('images')->put($job->result_path, 'webp');
        }

        return $job;
    }

    public function test_expires_old_completed_jobs_and_deletes_files(): void
    {
        $job = $this->job(ImageJobStatus::Completed, now()->subHours(25));

        $this->artisan('images:cleanup')->assertSuccessful();

        $job->refresh();
        $this->assertNotNull($job->expired_at);
        $this->assertSame(ImageJobStatus::Completed, $job->status);
        Storage::disk('images')->assertMissing("uploads/{$job->id}.jpg");
        Storage::disk('images')->assertMissing("results/{$job->id}.webp");
        $this->getJson("/api/images/{$job->id}/download")->assertStatus(410);
    }

    public function test_expires_old_failed_jobs(): void
    {
        $job = $this->job(ImageJobStatus::Failed, now()->subHours(30));

        $this->artisan('images:cleanup')->assertSuccessful();

        $this->assertNotNull($job->refresh()->expired_at);
        Storage::disk('images')->assertMissing($job->original_path);
    }

    public function test_leaves_recent_jobs_alone(): void
    {
        $job = $this->job(ImageJobStatus::Completed, now()->subHours(23));

        $this->artisan('images:cleanup')->assertSuccessful();

        $this->assertNull($job->refresh()->expired_at);
        Storage::disk('images')->assertExists($job->result_path);
    }

    public function test_never_touches_unfinished_jobs(): void
    {
        $pending = $this->job(ImageJobStatus::Pending, now()->subDays(3));
        $processing = $this->job(ImageJobStatus::Processing, now()->subDays(3));

        $this->artisan('images:cleanup')->assertSuccessful();

        $this->assertNull($pending->refresh()->expired_at);
        $this->assertNull($processing->refresh()->expired_at);
        Storage::disk('images')->assertExists($pending->original_path);
    }

    public function test_tolerates_missing_files_and_is_idempotent(): void
    {
        $job = $this->job(ImageJobStatus::Completed, now()->subHours(48));
        Storage::disk('images')->delete($job->result_path);

        $this->artisan('images:cleanup')->expectsOutputToContain('Expired 1 job(s).')->assertSuccessful();
        $this->artisan('images:cleanup')->expectsOutputToContain('Expired 0 job(s).')->assertSuccessful();
    }

    public function test_is_scheduled_hourly(): void
    {
        $event = collect(app(Schedule::class)->events())
            ->first(fn ($e) => str_contains($e->command ?? '', 'images:cleanup'));

        $this->assertNotNull($event, 'images:cleanup is not scheduled');
        $this->assertSame('0 * * * *', $event->expression);
    }
}
