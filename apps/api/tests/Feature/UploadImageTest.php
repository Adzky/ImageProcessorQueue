<?php

namespace Tests\Feature;

use App\Enums\ImageErrorCode;
use App\Enums\ImageJobStatus;
use App\Jobs\ProcessImage;
use App\Models\ImageJob;
use Illuminate\Contracts\Bus\Dispatcher;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\DataProvider;
use RuntimeException;
use Tests\Support\MakesImages;
use Tests\TestCase;

class UploadImageTest extends TestCase
{
    use MakesImages;
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('images');
        Queue::fake();
    }

    protected function tearDown(): void
    {
        $this->tearDownMakesImages();
        parent::tearDown();
    }

    private function upload(string $path, string $clientName)
    {
        return $this->post('/api/images', [
            'image' => new UploadedFile($path, $clientName, null, null, true),
        ], ['Accept' => 'application/json']);
    }

    public static function formats(): array
    {
        return [
            'jpeg' => ['jpeg', 'photo.jpg', 'jpg', 'image/jpeg'],
            'png' => ['png', 'photo.png', 'png', 'image/png'],
            'webp' => ['webp', 'photo.webp', 'webp', 'image/webp'],
        ];
    }

    #[DataProvider('formats')]
    public function test_accepts_jpg_png_webp_and_returns_202(string $format, string $name, string $ext, string $mime): void
    {
        $response = $this->upload($this->makeImage(64, 48, $format), $name);

        $response->assertStatus(202)->assertJsonPath('status', 'pending');
        $id = $response->json('job_id');
        $this->assertTrue(Str::isUuid($id));
        $response->assertJsonPath('status_url', "/api/images/{$id}");
        $response->assertHeader('Location', "/api/images/{$id}");

        $job = ImageJob::findOrFail($id);
        $this->assertSame(ImageJobStatus::Pending, $job->status);
        $this->assertSame($name, $job->original_name);
        $this->assertSame($mime, $job->original_mime);
        $this->assertSame("uploads/{$id}.{$ext}", $job->original_path);
        Storage::disk('images')->assertExists("uploads/{$id}.{$ext}");

        Queue::assertPushedOn('images', ProcessImage::class, fn (ProcessImage $j) => $j->imageJobId === $id);
    }

    public function test_accepts_uppercase_and_jpeg_extensions(): void
    {
        foreach (['PHOTO.JPG', 'x.jpeg'] as $name) {
            $response = $this->upload($this->makeImage(10, 10, 'jpeg'), $name)->assertStatus(202);
            $id = $response->json('job_id');
            Storage::disk('images')->assertExists("uploads/{$id}.jpg");
        }
    }

    public function test_rejects_file_over_20mb(): void
    {
        $response = $this->post('/api/images', [
            'image' => UploadedFile::fake()->create('big.jpg', 20481, 'image/jpeg'),
        ], ['Accept' => 'application/json']);

        $response->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->assertStringContainsString('20 MB', $response->json('error.message'));
        $this->assertSame(0, ImageJob::count());
        Queue::assertNothingPushed();
    }

    public function test_rejects_wrong_type(): void
    {
        $gif = tempnam(sys_get_temp_dir(), 'gif').'.gif';
        $im = new \Imagick;
        $im->newImage(10, 10, 'red');
        $im->setImageFormat('gif');
        $im->writeImage($gif);

        $response = $this->upload($gif, 'anim.gif');
        @unlink($gif);

        $response->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->assertStringContainsString('JPG, PNG or WebP', $response->json('error.message'));
    }

    public function test_rejects_text_file_named_jpg(): void
    {
        $txt = tempnam(sys_get_temp_dir(), 'txt');
        file_put_contents($txt, str_repeat('not an image ', 100));

        $response = $this->upload($txt, 'sneaky.jpg');
        @unlink($txt);

        $response->assertStatus(422);
        $this->assertStringContainsString('JPG, PNG or WebP', $response->json('error.message'));
    }

    public function test_missing_file_is_rejected(): void
    {
        $this->post('/api/images', [], ['Accept' => 'application/json'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');
    }

    public function test_queue_down_marks_failed_and_returns_503(): void
    {
        $this->mock(Dispatcher::class, function ($mock) {
            $mock->shouldReceive('dispatch')->andThrow(new RuntimeException('redis down'));
        });

        $response = $this->upload($this->makeImage(10, 10, 'png'), 'a.png');

        $response->assertStatus(503)->assertJsonPath('error.code', 'queue_unavailable');
        $job = ImageJob::sole();
        $this->assertSame(ImageJobStatus::Failed, $job->status);
        $this->assertSame(ImageErrorCode::QueueUnavailable, $job->error_code);
    }
}
