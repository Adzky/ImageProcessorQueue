<?php

namespace Tests\Feature;

use App\Enums\ImageJobStatus;
use App\Models\ImageJob;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\TestCase;

class DownloadImageTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('images');
    }

    private function completedJob(string $originalName = 'photo.jpg'): ImageJob
    {
        $job = ImageJob::create([
            'original_name' => $originalName,
            'original_mime' => 'image/jpeg',
            'original_size' => 100,
            'original_path' => 'uploads/x.jpg',
        ]);
        $path = "results/{$job->id}.webp";
        Storage::disk('images')->put($path, 'RIFF0000WEBPVP8 fake');
        $job->claim(1);
        $job->markCompleted(1, $path, 20, 10, 10, 10, 10);

        return $job;
    }

    public function test_404_unknown(): void
    {
        $this->get('/api/images/'.Str::uuid7().'/download')
            ->assertNotFound()
            ->assertJsonPath('error.code', 'not_found');
    }

    public function test_409_when_not_completed(): void
    {
        $job = ImageJob::create([
            'original_name' => 'a.jpg', 'original_mime' => 'image/jpeg', 'original_size' => 1, 'original_path' => 'uploads/a.jpg',
        ]);

        $this->get("/api/images/{$job->id}/download")
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'not_ready');
    }

    public function test_410_when_expired(): void
    {
        $job = $this->completedJob();
        $job->update(['expired_at' => now()]);

        $this->get("/api/images/{$job->id}/download")
            ->assertStatus(410)
            ->assertJsonPath('error.code', 'expired');
    }

    public function test_streams_webp_with_filename(): void
    {
        $job = $this->completedJob('photo.jpg');

        $response = $this->get("/api/images/{$job->id}/download");

        $response->assertOk();
        $response->assertHeader('Content-Type', 'image/webp');
        $this->assertStringContainsString('attachment', $response->headers->get('Content-Disposition'));
        $this->assertStringContainsString('photo.webp', $response->headers->get('Content-Disposition'));
        $this->assertSame('RIFF0000WEBPVP8 fake', $response->streamedContent());
    }

    public function test_non_ascii_filename_has_fallback_and_utf8(): void
    {
        $job = $this->completedJob('фото 1.jpg');

        $disposition = $this->get("/api/images/{$job->id}/download")->assertOk()->headers->get('Content-Disposition');

        $this->assertStringContainsString("filename*=utf-8''", $disposition);
        $this->assertStringContainsString(rawurlencode('фото 1.webp'), $disposition);
        $this->assertMatchesRegularExpression('/filename="[\x20-\x7e]+\.webp"/', $disposition);
    }
}
