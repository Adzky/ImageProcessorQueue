<?php

namespace App\Http;

use Illuminate\Http\JsonResponse;

/** The single error shape every API endpoint returns: {"error": {"code", "message"}}. */
final class ApiError
{
    public static function response(string $code, string $message, int $status, array $extra = []): JsonResponse
    {
        return new JsonResponse(['error' => ['code' => $code, 'message' => $message] + $extra], $status);
    }
}
