<?php

namespace App\Models;

use App\Enums\ImageErrorCode;
use App\Enums\ImageJobStatus;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

/**
 * A single image-processing job.
 *
 * Every state change is one conditional UPDATE, so concurrent or duplicate queue
 * deliveries can never move a job backwards or overwrite another delivery's outcome.
 * `attempts` stores the queue attempt number of the delivery that owns the job.
 *
 * @property string $id
 * @property ImageJobStatus $status
 * @property int $attempts
 */
class ImageJob extends Model
{
    use HasUuids;

    protected $guarded = [];

    protected $attributes = [
        'status' => 'pending',
        'attempts' => 0,
    ];

    protected function casts(): array
    {
        return [
            'status' => ImageJobStatus::class,
            'error_code' => ImageErrorCode::class,
            'attempts' => 'integer',
            'original_size' => 'integer',
            'original_width' => 'integer',
            'original_height' => 'integer',
            'result_size' => 'integer',
            'result_width' => 'integer',
            'result_height' => 'integer',
            'started_at' => 'immutable_datetime',
            'completed_at' => 'immutable_datetime',
            'failed_at' => 'immutable_datetime',
            'expired_at' => 'immutable_datetime',
            'created_at' => 'immutable_datetime',
            'updated_at' => 'immutable_datetime',
        ];
    }

    /**
     * Take ownership for queue attempt $attempt. A retry (higher attempt) may take over a
     * job left in `processing` by a crashed worker; a duplicate (same/lower attempt) may not.
     */
    public function claim(int $attempt): bool
    {
        return $this->transition(
            fn (Builder $q) => $q
                ->whereIn('status', [ImageJobStatus::Pending->value, ImageJobStatus::Processing->value])
                ->where('attempts', '<', $attempt),
            [
                'status' => ImageJobStatus::Processing->value,
                'attempts' => $attempt,
                'started_at' => now(),
            ],
        );
    }

    /** Only the delivery that currently owns the job may complete it. */
    public function markCompleted(
        int $attempt,
        string $resultPath,
        int $size,
        int $width,
        int $height,
        int $originalWidth,
        int $originalHeight,
    ): bool {
        return $this->transition(
            fn (Builder $q) => $q
                ->where('status', ImageJobStatus::Processing->value)
                ->where('attempts', $attempt),
            [
                'status' => ImageJobStatus::Completed->value,
                'result_path' => $resultPath,
                'result_size' => $size,
                'result_width' => $width,
                'result_height' => $height,
                'original_width' => $originalWidth,
                'original_height' => $originalHeight,
                'completed_at' => now(),
            ],
        );
    }

    /** Fail a non-terminal job. Terminal jobs are never changed. */
    public function markFailed(ImageErrorCode $code, ?string $message = null): bool
    {
        return $this->transition(
            fn (Builder $q) => $q
                ->whereIn('status', [ImageJobStatus::Pending->value, ImageJobStatus::Processing->value]),
            [
                'status' => ImageJobStatus::Failed->value,
                'error_code' => $code->value,
                'error_message' => $message ?? $code->message(),
                'failed_at' => now(),
            ],
        );
    }

    /**
     * @param  callable(Builder): Builder  $guard
     */
    private function transition(callable $guard, array $values): bool
    {
        $values['updated_at'] = now();

        $updated = $guard(static::query()->whereKey($this->getKey()))->update($values) === 1;

        if ($updated) {
            $this->refresh();
        }

        return $updated;
    }
}
