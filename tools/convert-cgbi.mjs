#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node tools/convert-cgbi.mjs <input.png|directory> <output.png|directory>");
  process.exit(2);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let k = 0; k < 8; k += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function convertPng(source) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (!source.subarray(0, 8).equals(signature)) throw new Error("Not a PNG file");
  const chunks = [];
  for (let cursor = 8; cursor + 12 <= source.length;) {
    const length = source.readUInt32BE(cursor);
    const type = source.subarray(cursor + 4, cursor + 8).toString("ascii");
    const data = source.subarray(cursor + 8, cursor + 8 + length);
    chunks.push({ type, data });
    cursor += 12 + length;
    if (type === "IEND") break;
  }
  if (!chunks.some(({ type }) => type === "CgBI")) return source;

  const ihdr = chunks.find(({ type }) => type === "IHDR")?.data;
  if (!ihdr) throw new Error("PNG is missing IHDR");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`Unsupported CgBI format: depth=${bitDepth}, color=${colorType}, interlace=${interlace}`);
  }

  const packed = Buffer.concat(chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data));
  const filtered = zlib.inflateRawSync(packed);
  const stride = width * 4;
  if (filtered.length !== (stride + 1) * height) throw new Error("Unexpected decoded PNG length");
  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * (stride + 1);
    const targetRow = y * stride;
    const filter = filtered[sourceRow];
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceRow + 1 + x];
      const left = x >= 4 ? pixels[targetRow + x - 4] : 0;
      const above = y > 0 ? pixels[targetRow + x - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[targetRow + x - stride - 4] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? above
            : filter === 3 ? Math.floor((left + above) / 2)
              : filter === 4 ? paeth(left, above, upperLeft)
                : (() => { throw new Error(`Unsupported PNG filter ${filter}`); })();
      pixels[targetRow + x] = (raw + predictor) & 0xff;
    }
  }

  for (let i = 0; i < pixels.length; i += 4) {
    const blue = pixels[i];
    const green = pixels[i + 1];
    const red = pixels[i + 2];
    const alpha = pixels[i + 3];
    pixels[i] = alpha ? Math.min(255, Math.round(red * 255 / alpha)) : 0;
    pixels[i + 1] = alpha ? Math.min(255, Math.round(green * 255 / alpha)) : 0;
    pixels[i + 2] = alpha ? Math.min(255, Math.round(blue * 255 / alpha)) : 0;
  }

  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const metadata = chunks.filter(({ type }) => !["CgBI", "IHDR", "IDAT", "IEND"].includes(type));
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    ...metadata.map(({ type, data }) => chunk(type, data)),
    chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
    chunk("IEND"),
  ]);
}

function convertFile(sourcePath, destinationPath) {
  const converted = convertPng(fs.readFileSync(sourcePath));
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, converted);
}

const stats = fs.statSync(input);
if (stats.isFile()) {
  convertFile(input, output);
} else {
  let converted = 0;
  for (const entry of fs.readdirSync(input, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".png") continue;
    convertFile(path.join(input, entry.name), path.join(output, entry.name));
    converted += 1;
  }
  console.log(`Normalized ${converted} PNG assets into ${output}`);
}
