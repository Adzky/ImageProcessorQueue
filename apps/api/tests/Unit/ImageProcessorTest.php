<?php

namespace Tests\Unit;

use App\Enums\ImageErrorCode;
use App\Images\ImageProcessor;
use App\Images\PermanentImageFailure;
use Imagick;
use Tests\Support\MakesImages;
use Tests\TestCase;

class ImageProcessorTest extends TestCase
{
    use MakesImages;

    private string $dest;

    protected function setUp(): void
    {
        parent::setUp();
        $this->dest = tempnam(sys_get_temp_dir(), 'out').'.webp';
        @unlink($this->dest);
    }

    protected function tearDown(): void
    {
        @unlink($this->dest);
        @unlink($this->dest.'.tmp');
        $this->tearDownMakesImages();
        parent::tearDown();
    }

    private function process(string $source): \App\Images\ProcessedImage
    {
        return app(ImageProcessor::class)->process($source, $this->dest);
    }

    private function assertPermanentFailure(ImageErrorCode $expected, string $source): void
    {
        try {
            $this->process($source);
            $this->fail('Expected PermanentImageFailure');
        } catch (PermanentImageFailure $e) {
            $this->assertSame($expected, $e->errorCode);
            $this->assertSame($expected->message(), $e->getMessage());
        }
        $this->assertFileDoesNotExist($this->dest);
    }

    public function test_landscape_scaled_to_1280_wide(): void
    {
        $result = $this->process($this->makeImage(4000, 3000));

        $this->assertSame([1280, 960], [$result->width, $result->height]);
        $this->assertSame([4000, 3000], [$result->originalWidth, $result->originalHeight]);
        $this->assertSame([1280, 960], array_slice(getimagesize($this->dest), 0, 2));
        $this->assertSame(filesize($this->dest), $result->size);
    }

    public function test_portrait_scaled_to_1280_tall(): void
    {
        $result = $this->process($this->makeImage(3000, 4000, 'png'));

        $this->assertSame([960, 1280], [$result->width, $result->height]);
    }

    public function test_tall_narrow_keeps_nonzero_width(): void
    {
        $result = $this->process($this->makeImage(100, 5000, 'png'));

        $this->assertSame([26, 1280], [$result->width, $result->height]);
    }

    public function test_small_image_not_upscaled(): void
    {
        $result = $this->process($this->makeImage(800, 600));

        $this->assertSame([800, 600], [$result->width, $result->height]);
    }

    public function test_output_is_webp(): void
    {
        $this->process($this->makeImage(50, 50, 'png'));

        $this->assertSame('image/webp', getimagesize($this->dest)['mime']);
    }

    public function test_quality_setting_is_applied(): void
    {
        // WebP doesn't record its quality, so prove the setting reaches the encoder by size.
        $source = $this->makeImage(600, 400, 'png', ['noise' => true]);
        $sizeAt = function (int $quality) use ($source): int {
            config(['images.quality' => $quality]);

            return $this->process($source)->size;
        };

        $this->assertSame(80, (int) config('images.quality'));
        $at80 = $sizeAt(80);
        $this->assertLessThan($at80, $sizeAt(30));
        $this->assertGreaterThan($at80, $sizeAt(100));
    }

    public function test_png_alpha_preserved(): void
    {
        $this->process($this->makeImage(200, 100, 'png', ['alpha' => true]));

        $out = new Imagick($this->dest);
        $this->assertTrue((bool) $out->getImageAlphaChannel());
        $this->assertEqualsWithDelta(0.0, $out->getImagePixelColor(180, 50)->getColorValue(Imagick::COLOR_ALPHA), 0.01);
        $this->assertEqualsWithDelta(1.0, $out->getImagePixelColor(20, 50)->getColorValue(Imagick::COLOR_ALPHA), 0.01);
    }

    public function test_cmyk_converted_to_srgb(): void
    {
        $this->process($this->makeImage(100, 100, 'jpeg', ['cmyk' => true, 'color' => '#ff0000']));

        $out = new Imagick($this->dest);
        $this->assertSame(Imagick::COLORSPACE_SRGB, $out->getImageColorspace());
        $pixel = $out->getImagePixelColor(50, 50)->getColor();
        $this->assertGreaterThan(200, $pixel['r']);
        $this->assertLessThan(60, $pixel['g']);
    }

    public function test_exif_rotated_jpeg_is_upright(): void
    {
        // Orientation 6 = "rotate 90° CW to display": stored 400x200, displayed 200x400.
        $result = $this->process($this->makeImage(400, 200, 'jpeg', ['orientation' => Imagick::ORIENTATION_RIGHTTOP]));

        $this->assertSame([200, 400], [$result->width, $result->height]);
    }

    public function test_metadata_is_stripped(): void
    {
        $this->process($this->makeImage(400, 200, 'jpeg', ['orientation' => Imagick::ORIENTATION_RIGHTTOP]));

        $out = new Imagick($this->dest);
        $this->assertSame([], $out->getImageProperties('exif:*'));
    }

    public function test_animated_webp_uses_first_frame(): void
    {
        $this->process($this->makeImage(64, 64, 'webp', ['frames' => 3]));

        $this->assertSame(1, (new Imagick($this->dest))->getNumberImages());
    }

    public function test_corrupt_file_throws_corrupt_image(): void
    {
        $this->assertPermanentFailure(ImageErrorCode::CorruptImage, $this->makeCorruptFile());
    }

    public function test_random_bytes_throw_corrupt_image(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'rnd');
        file_put_contents($path, random_bytes(1024));

        try {
            $this->assertPermanentFailure(ImageErrorCode::CorruptImage, $path);
        } finally {
            @unlink($path);
        }
    }

    public function test_unsupported_format_throws(): void
    {
        $gif = tempnam(sys_get_temp_dir(), 'gif').'.gif';
        $im = new Imagick;
        $im->newImage(10, 10, 'red');
        $im->setImageFormat('gif');
        $im->writeImage($gif);

        try {
            $this->assertPermanentFailure(ImageErrorCode::UnsupportedImage, $gif);
        } finally {
            @unlink($gif);
        }
    }

    public function test_over_pixel_limit_throws(): void
    {
        config(['images.max_pixels' => 1000]);

        $this->assertPermanentFailure(ImageErrorCode::DimensionsTooLarge, $this->makeImage(100, 100));
    }

    public function test_no_tmp_file_left_behind(): void
    {
        $this->process($this->makeImage(100, 100));

        $this->assertFileExists($this->dest);
        $this->assertFileDoesNotExist($this->dest.'.tmp');
    }
}
