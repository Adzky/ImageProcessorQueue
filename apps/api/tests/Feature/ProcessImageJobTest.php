<?php

namespace Tests\Feature;

use App\Enums\ImageErrorCode;
use App\Enums\ImageJobStatus;
use App\Images\PermanentImageFailure;
use App\Jobs\ProcessImage;
use App\Models\ImageJob;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Tests\Support\MakesImages;
use Tests\TestCase;

class ProcessImageJobTest extends TestCase
{
    use MakesImages;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('images');
    }

    protected function tearDown(): void
    {
        $this->tearDownMakesImages();
        parent::tearDown();
    }

    private function jobFor(string $source): ImageJob
    {
        $job = ImageJob::create([
            'original_name' => 'x.png', 'original_mime' => 'image/png', 'original_size' => 1, 'original_path' => 'tmp',
        ]);
        Storage::disk('images')->put("uploads/{$job->id}.png", file_get_contents($source));
        $job->update(['original_path' => "uploads/{$job->id}.png"]);

        return $job;
    }

    public function test_permanent_failure_fails_without_retry(): void
    {
        $job = $this->jobFor($this->makeCorruptFile());
        $queued = (new ProcessImage($job->id))->withFakeQueueInteractions();

        $queued->handle(app(\App\Images\ImageJobRunner::class));

        $queued->assertFailedWith(PermanentImageFailure::class);
        $queued->assertNotReleased();

        $queued->failed(new PermanentImageFailure(ImageErrorCode::CorruptImage));
        $job->refresh();
        $this->assertSame(ImageJobStatus::Failed, $job->status);
        $this->assertSame(ImageErrorCode::CorruptImage, $job->error_code);
    }

    public function test_successful_job_completes(): void
    {
        $job = $this->jobFor($this->makeImage(50, 50, 'png'));
        $queued = (new ProcessImage($job->id))->withFakeQueueInteractions();

        $queued->handle(app(\App\Images\ImageJobRunner::class));

        $queued->assertNotFailed();
        $this->assertSame(ImageJobStatus::Completed, $job->refresh()->status);
    }

    public function test_failed_hook_marks_retries_exhausted(): void
    {
        $job = $this->jobFor($this->makeImage(10, 10, 'png'));
        $job->claim(3);

        (new ProcessImage($job->id))->failed(new RuntimeException('disk on fire'));

        $job->refresh();
        $this->assertSame(ImageJobStatus::Failed, $job->status);
        $this->assertSame(ImageErrorCode::RetriesExhausted, $job->error_code);
        $this->assertSame(ImageErrorCode::RetriesExhausted->message(), $job->error_message);
        $this->assertStringNotContainsString('disk on fire', $job->error_message);
    }

    public function test_job_config(): void
    {
        $queued = new ProcessImage('id');

        $this->assertSame(3, $queued->tries);
        $this->assertSame(120, $queued->timeout);
        $this->assertSame([5, 15], $queued->backoff());
    }

    public function test_dispatched_through_sync_queue_end_to_end(): void
    {
        $job = $this->jobFor($this->makeImage(3000, 1500));

        ProcessImage::dispatchSync($job->id);

        $job->refresh();
        $this->assertSame(ImageJobStatus::Completed, $job->status);
        $this->assertSame([1280, 640], [$job->result_width, $job->result_height]);
    }
}
