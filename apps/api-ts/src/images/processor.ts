import { rename, unlink } from 'node:fs/promises';
import sharp from 'sharp';
import { PermanentImageFailure } from '../jobs/errors.js';

export type ProcessedImage = {
  width: number;
  height: number;
  size: number;
  originalWidth: number;
  originalHeight: number;
};

export type ProcessOptions = {
  maxDimension: number;
  quality: number;
  maxPixels: number;
  timeoutSeconds: number;
};

const SUPPORTED = new Set(['jpeg', 'png', 'webp']);

/**
 * The CPU-heavy transform: resize so the longest side is at most `maxDimension` (aspect kept,
 * never upscaled), then encode once as WebP at `quality`. Compressing to JPEG/PNG first and
 * re-encoding would lose quality twice for no benefit.
 */
export async function processImage(
  source: string,
  dest: string,
  opts: ProcessOptions,
): Promise<ProcessedImage> {
  const { originalWidth, originalHeight } = await inspect(source, opts.maxPixels);

  // Write next to the destination, then rename: a crash mid-write never leaves a
  // truncated file under the final name.
  const tmp = dest + '.tmp';
  try {
    const info = await sharp(source, { limitInputPixels: opts.maxPixels, failOn: 'error', pages: 1 })
      .rotate() // apply EXIF orientation; output metadata is stripped by default
      .toColourspace('srgb')
      .resize(opts.maxDimension, opts.maxDimension, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: opts.quality })
      .timeout({ seconds: opts.timeoutSeconds })
      .toFile(tmp)
      .catch((e: unknown) => {
        throw classify(e);
      });
    await rename(tmp, dest);
    return { width: info.width, height: info.height, size: info.size, originalWidth, originalHeight };
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * Cheap header-only check before decoding anything: rejects unreadable files,
 * unsupported formats and decompression bombs. Reports the displayed (EXIF-oriented) size.
 */
async function inspect(
  source: string,
  maxPixels: number,
): Promise<{ originalWidth: number; originalHeight: number }> {
  const meta = await sharp(source, { failOn: 'error' })
    .metadata()
    .catch(() => {
      throw new PermanentImageFailure('corrupt_image');
    });
  if (!SUPPORTED.has(meta.format)) throw new PermanentImageFailure('unsupported_image');
  if (meta.width * meta.height > maxPixels) throw new PermanentImageFailure('dimensions_too_large');

  const swapped = (meta.orientation ?? 1) >= 5;
  return {
    originalWidth: swapped ? meta.height : meta.width,
    originalHeight: swapped ? meta.width : meta.height,
  };
}

/**
 * libvips/sharp messages that mean the input itself can't be decoded. Observed:
 * "Input file has corrupt header", "Input file contains unsupported image format",
 * "vipspng: libpng read error", "VipsJpeg: premature end of JPEG image".
 */
const DECODE_FAILURE = /corrupt|unsupported image format|read error|premature end|truncated|decode error/i;

/**
 * Only clear decode failures are permanent (like the PHP DecoderException). Everything else,
 * including timeouts ("timeout: 100% complete ...") and write errors, is rethrown unchanged
 * so the queue retries it.
 */
function classify(e: unknown): unknown {
  if (e instanceof Error && !/^timeout:/i.test(e.message) && DECODE_FAILURE.test(e.message)) {
    return new PermanentImageFailure('corrupt_image');
  }
  return e;
}
