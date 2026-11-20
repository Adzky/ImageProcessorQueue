import { randomBytes } from 'node:crypto';
import { access, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processImage } from '../../src/images/processor.js';
import { errorMessage, type ImageErrorCode, PermanentImageFailure } from '../../src/jobs/errors.js';
import { cleanupImages, makeApng, makeCorruptFile, makeImage, makeTempDir } from '../support/images.js';

const base = { maxDimension: 1280, quality: 80, maxPixels: 50_000_000, timeoutSeconds: 30 };

let dest: string;

beforeEach(async () => {
  dest = join(await makeTempDir(), 'out.webp');
});
afterEach(cleanupImages);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function expectFailure(code: ImageErrorCode, source: string, opts = base): Promise<void> {
  const err = await processImage(source, dest, opts).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PermanentImageFailure);
  if (!(err instanceof PermanentImageFailure)) return;
  expect(err.code).toBe(code);
  expect(err.message).toBe(errorMessage(code));
  expect(await exists(dest)).toBe(false);
  expect(await exists(dest + '.tmp')).toBe(false);
}

describe('processImage', () => {
  it('scales landscape to 1280 wide', async () => {
    const result = await processImage(await makeImage(4000, 3000), dest, base);

    expect([result.width, result.height]).toEqual([1280, 960]);
    expect([result.originalWidth, result.originalHeight]).toEqual([4000, 3000]);
    const meta = await sharp(dest).metadata();
    expect([meta.width, meta.height]).toEqual([1280, 960]);
    expect(result.size).toBe((await stat(dest)).size);
  });

  it('scales portrait to 1280 tall', async () => {
    const result = await processImage(await makeImage(3000, 4000, 'png'), dest, base);
    expect([result.width, result.height]).toEqual([960, 1280]);
  });

  it('keeps nonzero width for tall narrow images', async () => {
    const result = await processImage(await makeImage(100, 5000, 'png'), dest, base);
    expect([result.width, result.height]).toEqual([26, 1280]);
  });

  it('does not upscale small images', async () => {
    const result = await processImage(await makeImage(800, 600), dest, base);
    expect([result.width, result.height]).toEqual([800, 600]);
  });

  it('processes an APNG as its first frame in a single-page WebP', async () => {
    const result = await processImage(await makeApng(60, 40), dest, base);

    expect([result.width, result.height]).toEqual([60, 40]);
    const meta = await sharp(dest).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.pages ?? 1).toBe(1);
    // Frame 1 is blue (#3366cc); frame 2 would be red.
    const { data } = await sharp(dest).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeLessThan(100);
    expect(data[2]).toBeGreaterThan(150);
  });

  it('outputs webp', async () => {
    await processImage(await makeImage(50, 50, 'png'), dest, base);
    expect((await sharp(dest).metadata()).format).toBe('webp');
  });

  it('applies the quality setting', async () => {
    // WebP doesn't record its quality, so prove the setting reaches the encoder by size.
    const source = await makeImage(600, 400, 'png', { noise: true });
    const sizeAt = async (quality: number): Promise<number> =>
      (await processImage(source, dest, { ...base, quality })).size;

    const at80 = await sizeAt(80);
    expect(await sizeAt(30)).toBeLessThan(at80);
    expect(await sizeAt(100)).toBeGreaterThan(at80);
  });

  it('preserves png alpha', async () => {
    await processImage(await makeImage(200, 100, 'png', { alpha: true }), dest, base);

    expect((await sharp(dest).metadata()).hasAlpha).toBe(true);
    const { data, info } = await sharp(dest).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number): number => data[(y * info.width + x) * info.channels + 3] ?? -1;
    expect(alphaAt(180, 50)).toBeLessThan(3);
    expect(alphaAt(20, 50)).toBeGreaterThan(252);
  });

  it('converts cmyk to srgb', async () => {
    const source = await makeImage(100, 100, 'jpeg', { cmyk: true, color: '#ff0000' });
    expect((await sharp(source).metadata()).space).toBe('cmyk');

    await processImage(source, dest, base);

    expect((await sharp(dest).metadata()).space).toBe('srgb');
    const { data, info } = await sharp(dest).raw().toBuffer({ resolveWithObject: true });
    const at = (50 * info.width + 50) * info.channels;
    expect(data[at] ?? 0).toBeGreaterThan(200);
    expect(data[at + 1] ?? 255).toBeLessThan(60);
  });

  it('rotates exif-oriented jpegs upright', async () => {
    // Orientation 6 = "rotate 90 CW to display": stored 400x200, displayed 200x400.
    const source = await makeImage(400, 200, 'jpeg', { orientation: 6 });
    expect((await sharp(source).metadata()).orientation).toBe(6);

    const result = await processImage(source, dest, base);

    expect([result.width, result.height]).toEqual([200, 400]);
    expect([result.originalWidth, result.originalHeight]).toEqual([200, 400]);
  });

  it('strips metadata', async () => {
    await processImage(await makeImage(400, 200, 'jpeg', { orientation: 6 }), dest, base);

    const meta = await sharp(dest).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('uses the first frame of an animated webp', async () => {
    const source = await makeImage(64, 64, 'webp', { frames: 3 });
    expect((await sharp(source, { pages: -1 }).metadata()).pages).toBe(3);

    await processImage(source, dest, base);

    expect((await sharp(dest, { pages: -1 }).metadata()).pages ?? 1).toBe(1);
  });

  it('throws corrupt_image for a truncated file', async () => {
    await expectFailure('corrupt_image', await makeCorruptFile());
  });

  it('throws corrupt_image for random bytes', async () => {
    const path = join(await makeTempDir(), 'rnd.bin');
    await writeFile(path, randomBytes(1024));
    await expectFailure('corrupt_image', path);
  });

  it('throws unsupported_image for gif', async () => {
    await expectFailure('unsupported_image', await makeImage(10, 10, 'gif'));
  });

  it('throws dimensions_too_large over the pixel limit', async () => {
    await expectFailure('dimensions_too_large', await makeImage(100, 100), { ...base, maxPixels: 5000 });
  });

  it('leaves no tmp file behind on success', async () => {
    await processImage(await makeImage(100, 100), dest, base);
    expect(await exists(dest)).toBe(true);
    expect(await exists(dest + '.tmp')).toBe(false);
  });

  it('leaves neither dest nor tmp when encoding fails', async () => {
    // Header parses fine, but the body is cut off mid-stream so the decode/encode fails.
    const png = await sharp({
      create: { width: 200, height: 200, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 50 } },
    })
      .png()
      .toBuffer();
    const path = join(await makeTempDir(), 'trunc.png');
    await writeFile(path, png.subarray(0, Math.floor(png.length / 2)));

    await expectFailure('corrupt_image', path);
  });

  it('does not wrap a timeout in PermanentImageFailure', async () => {
    // Large, incompressible, kept at full size so the 1 s budget is reliably exceeded.
    const big = await sharp({
      create: { width: 6000, height: 6000, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 60 } },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const path = join(await makeTempDir(), 'big.png');
    await writeFile(path, big);

    const err = await processImage(path, dest, {
      ...base,
      maxDimension: 6000,
      quality: 100,
      timeoutSeconds: 1,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentImageFailure);
    expect(err instanceof Error ? err.message : '').toMatch(/^timeout:/);
    expect(await exists(dest)).toBe(false);
    expect(await exists(dest + '.tmp')).toBe(false);
  }, 60_000);

  it('does not wrap a filesystem error in PermanentImageFailure', async () => {
    const missing = join(await makeTempDir(), 'no-such-dir', 'out.webp');

    const err = await processImage(await makeImage(100, 100), missing, base).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentImageFailure);
  });
});
