export type ImageErrorCode =
  | 'corrupt_image'
  | 'unsupported_image'
  | 'dimensions_too_large'
  | 'retries_exhausted'
  | 'worker_lost'
  | 'queue_unavailable';

const messages: Record<ImageErrorCode, string> = {
  corrupt_image: "This file couldn't be read as an image. It may be corrupted.",
  unsupported_image: "This image format isn't supported. Please upload a JPG, PNG or WebP.",
  dimensions_too_large: 'This image is too large to process (over 50 megapixels).',
  retries_exhausted: "We couldn't process this image after 3 attempts. Please try again.",
  worker_lost: "Processing didn't finish in time. Please try again.",
  queue_unavailable: 'The processing service is temporarily unavailable. Please try again shortly.',
};

export function errorMessage(code: ImageErrorCode): string {
  return messages[code];
}

/** A failure that retrying cannot fix. */
export class PermanentImageFailure extends Error {
  readonly code: ImageErrorCode;

  constructor(code: ImageErrorCode) {
    super(errorMessage(code));
    this.name = 'PermanentImageFailure';
    this.code = code;
  }
}
