<?php

namespace Tests\Support;

use Imagick;
use ImagickPixel;

/**
 * Generates real image fixtures on the fly with Imagick, so tests don't depend on
 * committed binaries and every edge case is explicit in code.
 */
trait MakesImages
{
    /** @var list<string> */
    private array $madeImages = [];

    /**
     * @param  'jpeg'|'png'|'webp'  $format
     * @param  array{alpha?: bool, cmyk?: bool, orientation?: int, frames?: int, color?: string}  $opts
     * @return string absolute path of a temp file
     */
    protected function makeImage(int $w, int $h, string $format = 'jpeg', array $opts = []): string
    {
        $frames = $opts['frames'] ?? 1;
        $color = $opts['color'] ?? '#3366cc';

        $im = new Imagick;
        for ($i = 0; $i < $frames; $i++) {
            $fill = new ImagickPixel($i === 0 ? $color : '#cc3333');
            $frame = new Imagick;
            if (! empty($opts['alpha'])) {
                // Fully transparent canvas with an opaque left half.
                $frame->newImage($w, $h, new ImagickPixel('transparent'));
                $half = new Imagick;
                $half->newImage(intdiv($w, 2), $h, $fill);
                $frame->compositeImage($half, Imagick::COMPOSITE_OVER, 0, 0);
            } else {
                $frame->newImage($w, $h, $fill);
            }
            if (! empty($opts['noise'])) {
                // Detail makes encoder quality visibly change the output size.
                $frame->addNoiseImage(Imagick::NOISE_GAUSSIAN);
            }
            $frame->setImageFormat($format);
            $im->addImage($frame);
        }

        if (! empty($opts['cmyk'])) {
            $im->transformImageColorspace(Imagick::COLORSPACE_CMYK);
        }

        $path = tempnam(sys_get_temp_dir(), 'img').'.'.($format === 'jpeg' ? 'jpg' : $format);
        $im->setImageFormat($format);
        $frames > 1 ? $im->writeImages($path, true) : $im->writeImage($path);

        if (isset($opts['orientation'])) {
            // Imagick doesn't write the EXIF orientation tag into JPEGs, so inject a minimal
            // EXIF APP1 segment (little-endian TIFF, one IFD entry: 0x0112 Orientation).
            $tiff = "II\x2a\x00\x08\x00\x00\x00"
                ."\x01\x00"
                ."\x12\x01\x03\x00\x01\x00\x00\x00".pack('v', $opts['orientation'])."\x00\x00"
                ."\x00\x00\x00\x00";
            $payload = "Exif\x00\x00".$tiff;
            $jpeg = file_get_contents($path);
            file_put_contents($path, "\xFF\xD8\xFF\xE1".pack('n', strlen($payload) + 2).$payload.substr($jpeg, 2));
        }

        $this->madeImages[] = $path;

        return $path;
    }

    /** A real PNG cut short and padded with junk: valid header and size, undecodable body. */
    protected function makeCorruptFile(): string
    {
        $png = new Imagick;
        $png->newImage(50, 50, new ImagickPixel('red'));
        $png->setImageFormat('png');

        $path = tempnam(sys_get_temp_dir(), 'bad').'.png';
        file_put_contents($path, substr($png->getImageBlob(), 0, 40).random_bytes(256));
        $this->madeImages[] = $path;

        return $path;
    }

    protected function tearDownMakesImages(): void
    {
        foreach ($this->madeImages as $path) {
            @unlink($path);
        }
        $this->madeImages = [];
    }
}
