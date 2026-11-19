<?php

namespace App\Images;

final readonly class ProcessedImage
{
    public function __construct(
        public int $width,
        public int $height,
        public int $size,
        public int $originalWidth,
        public int $originalHeight,
    ) {}
}
