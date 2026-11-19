<?php

namespace Tests\Unit;

use App\Enums\ImageErrorCode;
use App\Enums\ImageJobStatus;
use App\Models\ImageJob;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ImageJobTransitionsTest extends TestCase
{
    use RefreshDatabase;

    private function makeJob(array $attributes = []): ImageJob
    {
        return ImageJob::create(array_merge([
            'original_name' => 'photo.jpg',
            'original_mime' => 'image/jpeg',
            'original_size' => 1234,
            'original_path' => 'uploads/x.jpg',
        ], $attributes));
    }

    public function test_new_job_defaults_to_pending(): void
    {
        $job = $this->makeJob()->refresh();

        $this->assertSame(ImageJobStatus::Pending, $job->status);
        $this->assertSame(0, $job->attempts);
    }

    public function test_claim_moves_pending_to_processing_with_attempt(): void
    {
        $job = $this->makeJob();

        $this->assertTrue($job->claim(1));
        $this->assertSame(ImageJobStatus::Processing, $job->status);
        $this->assertSame(1, $job->attempts);
        $this->assertNotNull($job->started_at);
    }

    public function test_claim_with_same_or_lower_attempt_is_rejected(): void
    {
        $job = $this->makeJob();
        $job->claim(2);

        $this->assertFalse($job->claim(2));
        $this->assertFalse($job->claim(1));
        $this->assertSame(2, $job->refresh()->attempts);
    }

    public function test_higher_attempt_takes_over_processing_job(): void
    {
        $job = $this->makeJob();
        $job->claim(1);

        $this->assertTrue($job->claim(2));
        $this->assertSame(2, $job->attempts);
        $this->assertSame(ImageJobStatus::Processing, $job->status);
    }

    public function test_claim_rejected_on_terminal_rows(): void
    {
        $completed = $this->makeJob(['status' => ImageJobStatus::Completed]);
        $failed = $this->makeJob(['status' => ImageJobStatus::Failed]);

        $this->assertFalse($completed->claim(1));
        $this->assertFalse($failed->claim(1));
        $this->assertSame(ImageJobStatus::Completed, $completed->refresh()->status);
        $this->assertSame(ImageJobStatus::Failed, $failed->refresh()->status);
    }

    public function test_complete_requires_current_owner(): void
    {
        $job = $this->makeJob();
        $job->claim(1);
        $job->claim(2);

        $this->assertFalse($job->markCompleted(1, 'results/x.webp', 100, 1280, 960, 4000, 3000));
        $this->assertSame(ImageJobStatus::Processing, $job->refresh()->status);

        $this->assertTrue($job->markCompleted(2, 'results/x.webp', 100, 1280, 960, 4000, 3000));
        $this->assertSame(ImageJobStatus::Completed, $job->status);
        $this->assertSame('results/x.webp', $job->result_path);
        $this->assertSame(100, $job->result_size);
        $this->assertSame(1280, $job->result_width);
        $this->assertSame(960, $job->result_height);
        $this->assertSame(4000, $job->original_width);
        $this->assertSame(3000, $job->original_height);
        $this->assertNotNull($job->completed_at);
    }

    public function test_mark_failed_uses_default_message_and_ignores_terminal(): void
    {
        $job = $this->makeJob();
        $job->claim(1);

        $this->assertTrue($job->markFailed(ImageErrorCode::WorkerLost));
        $this->assertSame(ImageJobStatus::Failed, $job->status);
        $this->assertSame(ImageErrorCode::WorkerLost, $job->error_code);
        $this->assertSame(ImageErrorCode::WorkerLost->message(), $job->error_message);
        $this->assertNotNull($job->failed_at);

        $completed = $this->makeJob(['status' => ImageJobStatus::Completed]);
        $this->assertFalse($completed->markFailed(ImageErrorCode::WorkerLost));
        $this->assertSame(ImageJobStatus::Completed, $completed->refresh()->status);
    }

    public function test_mark_failed_works_from_pending(): void
    {
        $job = $this->makeJob();

        $this->assertTrue($job->markFailed(ImageErrorCode::QueueUnavailable, 'custom'));
        $this->assertSame('custom', $job->error_message);
    }

    public function test_status_is_terminal(): void
    {
        $this->assertFalse(ImageJobStatus::Pending->isTerminal());
        $this->assertFalse(ImageJobStatus::Processing->isTerminal());
        $this->assertTrue(ImageJobStatus::Completed->isTerminal());
        $this->assertTrue(ImageJobStatus::Failed->isTerminal());
    }
}
