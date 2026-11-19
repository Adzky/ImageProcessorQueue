<?php

return [
    'disk' => env('IMAGE_DISK', 'images'),
    'queue' => env('IMAGE_QUEUE', 'images'),
    'max_upload_kb' => (int) env('IMAGE_MAX_UPLOAD_KB', 20480),
    'max_dimension' => (int) env('IMAGE_MAX_DIMENSION', 1280),
    'quality' => (int) env('IMAGE_QUALITY', 80),
    'max_pixels' => (int) env('IMAGE_MAX_PIXELS', 50_000_000),
    'stale_after_seconds' => (int) env('IMAGE_STALE_AFTER_SECONDS', 600),
    'lost_after_seconds' => (int) env('IMAGE_LOST_AFTER_SECONDS', 3600),
    'retention_hours' => (int) env('IMAGE_RETENTION_HOURS', 24),
    'processing_delay_ms' => (int) env('IMAGE_PROCESSING_DELAY_MS', 0),
];
