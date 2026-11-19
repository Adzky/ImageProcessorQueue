<?php

namespace App\Http\Resources;

use App\Enums\ImageJobStatus;
use App\Models\ImageJob;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin ImageJob */
class ImageJobResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        $completed = $this->status === ImageJobStatus::Completed;
        $expired = $this->expired_at !== null;

        return [
            'job_id' => $this->id,
            'status' => $this->status->value,
            'attempts' => $this->attempts,
            'original' => [
                'name' => $this->original_name,
                'mime' => $this->original_mime,
                'size' => $this->original_size,
                'width' => $this->original_width,
                'height' => $this->original_height,
            ],
            'result' => $completed ? [
                'size' => $this->result_size,
                'width' => $this->result_width,
                'height' => $this->result_height,
            ] : null,
            'download_url' => $completed && ! $expired ? "/api/images/{$this->id}/download" : null,
            'error' => $this->status === ImageJobStatus::Failed ? [
                'code' => $this->error_code?->value,
                'message' => $this->error_message,
            ] : null,
            'expired' => $expired,
            'created_at' => $this->created_at?->toJSON(),
            'started_at' => $this->started_at?->toJSON(),
            'completed_at' => $this->completed_at?->toJSON(),
            'failed_at' => $this->failed_at?->toJSON(),
        ];
    }
}
