import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

export type MakeImageOpts = {
  alpha?: boolean;
  cmyk?: boolean;
  orientation?: number;
  frames?: number;
  color?: string;
  noise?: boolean;
};

const dirs: string[] = [];

/** A fresh temp directory, removed by `cleanupImages()`. */
export async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'imgtest-'));
  dirs.push(dir);
  return dir;
}

export async function cleanupImages(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

async function frame(w: number, h: number, color: string, opts: MakeImageOpts): Promise<ReturnType<typeof sharp>> {
  if (opts.noise === true) {
    // Detail makes encoder quality visibly change the output size.
    return sharp({
      create: { width: w, height: h, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } },
    });
  }
  if (opts.alpha === true) {
    // Fully transparent canvas with an opaque left half.
    const half = await sharp({
      create: { width: Math.floor(w / 2), height: h, channels: 3, background: color },
    })
      .png()
      .toBuffer();
    return sharp({
      create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: half, left: 0, top: 0 }]);
  }
  return sharp({ create: { width: w, height: h, channels: 3, background: color } });
}

/** Generates a real image fixture on the fly. Returns the absolute path of a temp file. */
export async function makeImage(
  w: number,
  h: number,
  format: 'jpeg' | 'png' | 'webp' | 'gif' = 'jpeg',
  opts: MakeImageOpts = {},
): Promise<string> {
  const frames = opts.frames ?? 1;
  const color = opts.color ?? '#3366cc';
  const path = join(await makeTempDir(), `img.${format === 'jpeg' ? 'jpg' : format}`);

  if (frames > 1) {
    const buffers: Buffer[] = [];
    for (let i = 0; i < frames; i++) {
      const img = await frame(w, h, i === 0 ? color : ['#cc3333', '#33cc33'][(i - 1) % 2] ?? color, opts);
      buffers.push(await img.png().toBuffer());
    }
    await sharp(buffers, { join: { animated: true } }).toFormat(format).toFile(path);
    return path;
  }

  let pipeline = await frame(w, h, color, opts);
  if (opts.cmyk === true) pipeline = pipeline.toColourspace('cmyk');
  if (opts.orientation !== undefined) pipeline = pipeline.withMetadata({ orientation: opts.orientation });
  await writeFile(path, await pipeline.toFormat(format).toBuffer());
  return path;
}

/** A real PNG cut short and padded with junk: valid header and size, undecodable body. */
export async function makeCorruptFile(): Promise<string> {
  const png = await sharp({ create: { width: 50, height: 50, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const path = join(await makeTempDir(), 'bad.png');
  await writeFile(path, Buffer.concat([png.subarray(0, 40), randomBytes(256)]));
  return path;
}
