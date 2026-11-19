<?php

use App\Http\ApiError;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Exceptions\PostTooLargeException;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $isApi = fn (Request $request) => $request->is('api/*');

        $exceptions->shouldRenderJsonWhen(fn (Request $request) => $isApi($request) || $request->expectsJson());

        // Every API error uses the same {"error": {"code", "message"}} shape.
        $exceptions->render(function (ValidationException $e, Request $request) use ($isApi) {
            if ($isApi($request)) {
                return ApiError::response('validation_failed', collect($e->errors())->flatten()->first() ?? 'Invalid request.', 422, [
                    'fields' => $e->errors(),
                ]);
            }
        });

        $exceptions->render(function (PostTooLargeException $e, Request $request) use ($isApi) {
            if ($isApi($request)) {
                return ApiError::response('file_too_large', 'File is larger than 20 MB.', 413);
            }
        });

        $exceptions->render(function (NotFoundHttpException $e, Request $request) use ($isApi) {
            if ($isApi($request)) {
                return ApiError::response('not_found', 'Job not found.', 404);
            }
        });

        $exceptions->render(function (Throwable $e, Request $request) use ($isApi) {
            if (! $isApi($request) || config('app.debug')) {
                return null;
            }
            $status = $e instanceof HttpExceptionInterface ? $e->getStatusCode() : 500;

            return ApiError::response(
                $status >= 500 ? 'internal_error' : 'http_error',
                $status >= 500 ? 'Something went wrong on our side. Please try again.' : ($e->getMessage() ?: 'Request failed.'),
                $status,
            );
        });
    })->create();
