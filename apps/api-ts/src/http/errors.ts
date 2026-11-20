import type { FastifyReply } from 'fastify';

/** The single error shape every endpoint returns: {"error": {"code", "message", ...extra}}. */
export function apiError(
  reply: FastifyReply,
  code: string,
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
): FastifyReply {
  return reply.code(status).send({ error: { code, message, ...extra } });
}

export const TOO_LARGE_MESSAGE = 'File is larger than 20 MB.';
export const TYPE_MESSAGE = 'File must be a JPG, PNG or WebP image.';
export const MISSING_MESSAGE = 'Please choose an image to upload.';
export const NOT_FOUND_MESSAGE = 'Job not found.';
export const INTERNAL_MESSAGE = 'Something went wrong on our side. Please try again.';

export function validationFailed(reply: FastifyReply, message: string): FastifyReply {
  return apiError(reply, 'validation_failed', message, 422, { fields: { image: [message] } });
}
