<?php

namespace App\Enums;

enum ImageErrorCode: string
{
    case CorruptImage = 'corrupt_image';
    case UnsupportedImage = 'unsupported_image';
    case DimensionsTooLarge = 'dimensions_too_large';
    case RetriesExhausted = 'retries_exhausted';
    case WorkerLost = 'worker_lost';
    case QueueUnavailable = 'queue_unavailable';

    /** Human-readable message shown to the user. */
    public function message(): string
    {
        return match ($this) {
            self::CorruptImage => "This file couldn't be read as an image. It may be corrupted.",
            self::UnsupportedImage => "This image format isn't supported. Please upload a JPG, PNG or WebP.",
            self::DimensionsTooLarge => 'This image is too large to process (over 50 megapixels).',
            self::RetriesExhausted => "We couldn't process this image after 3 attempts. Please try again.",
            self::WorkerLost => "Processing didn't finish in time. Please try again.",
            self::QueueUnavailable => 'The processing service is temporarily unavailable. Please try again shortly.',
        };
    }
}
