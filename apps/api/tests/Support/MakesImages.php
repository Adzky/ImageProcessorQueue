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
            $frame = new Imagick;
            $frame->newImage($w, $h, new ImagickPixel($i === 0 ? $color : '#cc3333'));
            if (! empty($opts['alpha'])) {
                // Left half opaque, right half fully transparent.
                $frame->setImageAlphaChannel(Imagick::ALPHACHANNEL_SET);
                $draw = new \ImagickDraw;
                $draw->setFillColor(new ImagickPixel('transparent'));
                $draw->rectangle(intdiv($w, 2), 0, $w, $h);
                $frame->setImageCompose(Imagick::COMPOSITE_COPY);
                $frame->drawImage($draw);
                $frame->setImageAlphaChannel(Imagick::ALPHACHANNEL_ACTIVATE);
            }
            $frame->setImageFormat($format);
            $im->addImage($frame);
        }

        if (! empty($opts['cmyk'])) {
            $im->transformImageColorspace(Imagick::COLORSPACE_CMYK);
        }
        if (isset($opts['orientation'])) {
            $im->setImageOrientation($opts['orientation']);
        }

        $path = tempnam(sys_get_temp_dir(), 'img').'.'.($format === 'jpeg' ? 'jpg' : $format);
        $im->setImageFormat($format);
        $frames > 1 ? $im->writeImages($path, true) : $im->writeImage($path);
        $this->madeImages[] = $path;

        return $path;
    }

    protected function makeCorruptFile(string $extension = 'png'): string
    {
        $path = tempnam(sys_get_temp_dir(), 'bad').'.'.$extension;
        // A PNG signature followed by junk: passes MIME sniffing, fails decoding.
        file_put_contents($path, "\x89PNG\r\n\x1a\n".random_bytes(512));
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
