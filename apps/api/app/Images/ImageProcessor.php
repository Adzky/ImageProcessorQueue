<?php

namespace App\Images;

use App\Enums\ImageErrorCode;
use Imagick;
use Intervention\Image\Drivers\Imagick\Driver;
use Intervention\Image\Exceptions\DecoderException;
use Intervention\Image\ImageManager;
use Intervention\Image\Interfaces\ImageInterface;

/**
 * The CPU-heavy transform. Runs only inside the queue worker.
 *
 *   1. resize so the longest side is at most `images.max_dimension` (aspect kept, never upscaled)
 *   2. compress at `images.quality`
 *   3. convert to WebP
 *
 * Steps 2 and 3 are a single encode: compressing to JPEG/PNG first and then re-encoding as
 * WebP would lose quality twice for no benefit.
 */
class ImageProcessor
{
    private const SUPPORTED = ['image/jpeg', 'image/png', 'image/webp'];

    public function process(string $sourcePath, string $destPath): ProcessedImage
    {
        [$originalWidth, $originalHeight] = $this->inspect($sourcePath);

        $image = $this->decode($sourcePath);
        $this->ensureSrgb($image);

        // Report the displayed (EXIF-oriented) size of the original, not the stored one.
        $originalWidth = $image->width();
        $originalHeight = $image->height();

        $max = (int) config('images.max_dimension');
        $image->scaleDown(width: $max, height: $max);

        // Write next to the destination, then rename: a crash mid-write never leaves a
        // truncated file under the final name.
        $tmpPath = $destPath.'.tmp';
        try {
            $image->toWebp(quality: (int) config('images.quality'))->save($tmpPath);
            if (! rename($tmpPath, $destPath)) {
                throw new \RuntimeException("Could not move processed image into place: {$destPath}");
            }
        } finally {
            if (is_file($tmpPath)) {
                @unlink($tmpPath);
            }
        }

        clearstatcache(true, $destPath);

        return new ProcessedImage(
            width: $image->width(),
            height: $image->height(),
            size: (int) filesize($destPath),
            originalWidth: $originalWidth,
            originalHeight: $originalHeight,
        );
    }

    /**
     * Cheap header-only check before decoding anything: rejects unreadable files,
     * unsupported formats and decompression bombs.
     *
     * @return array{int, int}
     */
    private function inspect(string $path): array
    {
        $info = @getimagesize($path);
        if ($info === false) {
            throw new PermanentImageFailure(ImageErrorCode::CorruptImage);
        }
        if (! in_array($info['mime'] ?? null, self::SUPPORTED, true)) {
            throw new PermanentImageFailure(ImageErrorCode::UnsupportedImage);
        }

        [$width, $height] = $info;
        if ($width * $height > (int) config('images.max_pixels')) {
            throw new PermanentImageFailure(ImageErrorCode::DimensionsTooLarge);
        }

        return [$width, $height];
    }

    private function decode(string $path): ImageInterface
    {
        Imagick::setResourceLimit(Imagick::RESOURCETYPE_MEMORY, 256 * 1024 * 1024);
        Imagick::setResourceLimit(Imagick::RESOURCETYPE_AREA, (int) config('images.max_pixels'));

        $manager = new ImageManager(new Driver,
            autoOrientation: true,
            decodeAnimation: false,
            strip: true,
        );

        try {
            return $manager->read($path);
        } catch (DecoderException|\ImagickException $e) {
            throw new PermanentImageFailure(ImageErrorCode::CorruptImage, $e);
        }
    }

    private function ensureSrgb(ImageInterface $image): void
    {
        $native = $image->core()->native();
        if ($native instanceof Imagick && $native->getImageColorspace() === Imagick::COLORSPACE_CMYK) {
            $native->transformImageColorspace(Imagick::COLORSPACE_SRGB);
        }
    }
}
