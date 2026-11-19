<?php

namespace App\Http\Controllers;

use App\Enums\ImageErrorCode;
use App\Enums\ImageJobStatus;
use App\Http\ApiError;
use App\Http\Requests\StoreImageRequest;
use App\Http\Resources\ImageJobResource;
use App\Jobs\ProcessImage;
use App\Models\ImageJob;
use Illuminate\Contracts\Bus\Dispatcher;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/**
 * The API only accepts, records and delegates. It never decodes or transforms image data:
 * that happens exclusively in the queue worker (App\Jobs\ProcessImage).
 */
class ImageJobController extends Controller
{
    private const EXTENSIONS = [
        'image/jpeg' => 'jpg',
        'image/png' => 'png',
        'image/webp' => 'webp',
    ];

    public function store(StoreImageRequest $request, Dispatcher $bus): JsonResponse
    {
        $file = $request->file('image');
        $mime = $file->getMimeType(); // sniffed from content, not the client header
        $id = (string) Str::uuid7();
        $path = $file->storeAs('uploads', "{$id}.".self::EXTENSIONS[$mime], config('images.disk'));

        $job = ImageJob::create([
            'id' => $id,
            'original_name' => $this->sanitiseName($file->getClientOriginalName()),
            'original_mime' => $mime,
            'original_size' => $file->getSize(),
            'original_path' => $path,
        ]);

        try {
            $bus->dispatch((new ProcessImage($id))->onQueue(config('images.queue'))->afterCommit());
        } catch (Throwable $e) {
            Log::error('Failed to enqueue image job', ['job_id' => $id, 'exception' => $e]);
            $job->markFailed(ImageErrorCode::QueueUnavailable);

            return ApiError::response(
                ImageErrorCode::QueueUnavailable->value,
                ImageErrorCode::QueueUnavailable->message(),
                Response::HTTP_SERVICE_UNAVAILABLE,
                ['job_id' => $id],
            );
        }

        $statusUrl = "/api/images/{$id}";

        return new JsonResponse([
            'job_id' => $id,
            'status' => ImageJobStatus::Pending->value,
            'status_url' => $statusUrl,
            'created_at' => $job->created_at?->toJSON(),
        ], Response::HTTP_ACCEPTED, ['Location' => $statusUrl]);
    }

    public function show(ImageJob $imageJob): ImageJobResource
    {
        return new ImageJobResource($imageJob);
    }

    public function download(ImageJob $imageJob): Response
    {
        if ($imageJob->expired_at !== null) {
            return ApiError::response('expired', 'This result has expired. Please upload the image again.', Response::HTTP_GONE);
        }

        if ($imageJob->status !== ImageJobStatus::Completed) {
            return ApiError::response('not_ready', "This image isn't ready yet (status: {$imageJob->status->value}).", Response::HTTP_CONFLICT);
        }

        $filename = pathinfo($imageJob->original_name, PATHINFO_FILENAME).'.webp';

        return Storage::disk(config('images.disk'))->download($imageJob->result_path, $filename, [
            'Content-Type' => 'image/webp',
        ]);
    }

    private function sanitiseName(string $name): string
    {
        $name = basename(str_replace('\\', '/', $name));
        $name = preg_replace('/[\x00-\x1F\x7F]/u', '', $name) ?? '';

        return Str::limit($name !== '' ? $name : 'image', 200, '');
    }
}
