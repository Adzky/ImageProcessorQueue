<?php

namespace App\Jobs;

use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

class ProcessImage implements ShouldQueue
{
    use Queueable;

    public function __construct(public string $imageJobId) {}

    public function handle(): void
    {
        // Implemented in Task 4.
    }
}
