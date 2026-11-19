<?php

namespace Tests\Feature;

use App\Enums\ImageErrorCode;
use App\Enums\ImageJobStatus;
use App\Models\ImageJob;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class ShowImageJobTest extends TestCase
{
    use RefreshDatabase;

    private function makeJob(array $attributes = []): ImageJob
    {
        return ImageJob::create(array_merge([
            'original_name' => 'photo.jpg',
            'original_mime' => 'image/jpeg',
            'original_size' => 18234567,
            'original_path' => 'uploads/x.jpg',
        ], $attributes))->refresh();
    }

    public function test_pending_shape(): void
    {
        $job = $this->makeJob();

        $this->getJson("/api/images/{$job->id}")
            ->assertOk()
            ->assertExactJsonStructure([
                'job_id', 'status', 'attempts',
                'original' => ['name', 'mime', 'size', 'width', 'height'],
                'result', 'download_url', 'error', 'expired',
                'created_at', 'started_at', 'completed_at', 'failed_at',
            ])
            ->assertJson([
                'job_id' => $job->id,
                'status' => 'pending',
                'attempts' => 0,
                'original' => ['name' => 'photo.jpg', 'mime' => 'image/jpeg', 'size' => 18234567, 'width' => null, 'height' => null],
                'result' => null,
                'download_url' => null,
                'error' => null,
                'expired' => false,
            ]);
    }

    public function test_completed_includes_result_and_download_url(): void
    {
        $job = $this->makeJob();
        $job->claim(1);
        $job->markCompleted(1, "results/{$job->id}.webp", 402311, 1280, 853, 6000, 4000);

        $this->getJson("/api/images/{$job->id}")
            ->assertOk()
            ->assertJson([
                'status' => 'completed',
                'attempts' => 1,
                'original' => ['width' => 6000, 'height' => 4000],
                'result' => ['size' => 402311, 'width' => 1280, 'height' => 853],
                'download_url' => "/api/images/{$job->id}/download",
                'error' => null,
            ])
            ->assertJsonPath('completed_at', fn ($v) => is_string($v));
    }

    public function test_failed_includes_error(): void
    {
        $job = $this->makeJob();
        $job->markFailed(ImageErrorCode::CorruptImage);

        $this->getJson("/api/images/{$job->id}")
            ->assertOk()
            ->assertJson([
                'status' => 'failed',
                'download_url' => null,
                'error' => ['code' => 'corrupt_image', 'message' => ImageErrorCode::CorruptImage->message()],
            ]);
    }

    public function test_expired_completed_job_has_no_download_url(): void
    {
        $job = $this->makeJob(['status' => ImageJobStatus::Completed, 'expired_at' => now()]);

        $this->getJson("/api/images/{$job->id}")
            ->assertOk()
            ->assertJson(['status' => 'completed', 'expired' => true, 'download_url' => null]);
    }

    public function test_unknown_id_404(): void
    {
        $this->getJson('/api/images/'.Str::uuid7())
            ->assertNotFound()
            ->assertJsonPath('error.code', 'not_found');
    }

    public function test_malformed_id_404(): void
    {
        $this->getJson('/api/images/not-a-uuid')
            ->assertNotFound()
            ->assertJsonPath('error.code', 'not_found');
    }
}
