// Helper for scripts/smoke.sh, run inside the worker container.
//   node scripts/smoke-image.mjs generate <w> <h>   JPEG to stdout
//   node scripts/smoke-image.mjs dims               image on stdin -> "WxH"
import sharp from "sharp";

const [command, widthArg, heightArg] = process.argv.slice(2);

if (command === "generate") {
  const width = Number(widthArg);
  const height = Number(heightArg);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    console.error("usage: smoke-image.mjs generate <width> <height>");
    process.exit(2);
  }
  // Noisy gradient so the JPEG has a realistic size (like Imagick's plasma).
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      raw[o] = (x * 215) / width + Math.random() * 40;
      raw[o + 1] = (y * 215) / height + Math.random() * 40;
      raw[o + 2] = ((x + y) * 215) / (width + height) + Math.random() * 40;
    }
  }
  const jpeg = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  process.stdout.write(jpeg);
} else if (command === "dims") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const meta = await sharp(Buffer.concat(chunks)).metadata();
  process.stdout.write(`${meta.width}x${meta.height}`);
} else {
  console.error("usage: smoke-image.mjs generate <w> <h> | dims");
  process.exit(2);
}
