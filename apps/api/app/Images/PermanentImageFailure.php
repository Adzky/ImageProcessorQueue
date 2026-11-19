<?php

namespace App\Images;

use App\Enums\ImageErrorCode;
use RuntimeException;
use Throwable;

/**
 * A failure that retrying cannot fix (corrupt or unsupported input, too many pixels).
 * The worker fails the job immediately instead of retrying.
 */
final class PermanentImageFailure extends RuntimeException
{
    public function __construct(public readonly ImageErrorCode $errorCode, ?Throwable $previous = null)
    {
        parent::__construct($errorCode->message(), 0, $previous);
    }
}
