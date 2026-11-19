<?php

namespace Tests\Feature;

use App\Enums\ImageJobStatus;
use App\Images\ImageJobRunner;
use App\Images\ImageProcessor;
use App\Images\PermanentImageFailure;
use App\Models\ImageJob;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\Support\MakesImages;
use Tests\TestCase;

class ImageJobRunnerTest extends TestCase
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

    private function pendingJob(?string $source = null): ImageJob
    {
        $source ??= $this->makeImage(2000, 1000);
        $job = ImageJob::create([
            'original_name' => 'photo.jpg',
            'original_mime' => 'image/jpeg',
            'original_size' => filesize($source),
            'original_path' => 'uploads/pending.jpg',
        ]);
        $path = "uploads/{$job->id}.jpg";
        Storage::disk('images')->put($path, file_get_contents($source));
        $job->update(['original_path' => $path]);

        return $job;
    }

    private function runner(): ImageJobRunner
    {
        return app(ImageJobRunner::class);
    }

    public function test_completes_pending_job(): void
    {
        $job = $this->pendingJob();

        $this->runner()->run($job->id, 1);

        $job->refresh();
        $this->assertSame(ImageJobStatus::Completed, $job->status);
        $this->assertSame(1, $job->attempts);
        $this->assertSame("results/{$job->id}.webp", $job->result_path);
        Storage::disk('images')->assertExists($job->result_path);
        $this->assertSame([1280, 640], [$job->result_width, $job->result_height]);
        $this->assertSame([2000, 1000], [$job->original_width, $job->original_height]);
        $this->assertSame(Storage::disk('images')->size($job->result_path), $job->result_size);
    }

    public function test_noop_for_missing_job(): void
    {
        $this->runner()->run('0193a000-0000-7000-8000-000000000000', 1);

        $this->assertSame(0, ImageJob::count());
    }

    public function test_noop_for_terminal_job(): void
    {
        $job = $this->pendingJob();
        $job->update(['status' => ImageJobStatus::Completed]);
        $this->mock(ImageProcessor::class)->shouldNotReceive('process');

        $this->runner()->run($job->id, 1);

        $this->assertSame(ImageJobStatus::Completed, $job->refresh()->status);
        $this->assertSame(0, $job->attempts);
    }

    public function test_noop_when_claim_lost(): void
    {
        $job = $this->pendingJob();
        $job->claim(2);
        $this->mock(ImageProcessor::class)->shouldNotReceive('process');

        $this->runner()->run($job->id, 2);

        $this->assertSame(ImageJobStatus::Processing, $job->refresh()->status);
    }

    public function test_retry_takes_over(): void
    {
        $job = $this->pendingJob();
        $job->claim(1); // first delivery "crashed" mid-processing

        $this->runner()->run($job->id, 2);

        $job->refresh();
        $this->assertSame(ImageJobStatus::Completed, $job->status);
        $this->assertSame(2, $job->attempts);
    }

    public function test_permanent_failure_propagates(): void
    {
        $job = $this->pendingJob($this->makeCorruptFile());

        $this->expectException(PermanentImageFailure::class);

        $this->runner()->run($job->id, 1);
    }

    public function test_processing_delay_is_applied(): void
    {
        config(['images.processing_delay_ms' => 300]);
        $job = $this->pendingJob($this->makeImage(10, 10));

        $start = microtime(true);
        $this->runner()->run($job->id, 1);

        $this->assertGreaterThanOrEqual(0.3, microtime(true) - $start);
    }
}
