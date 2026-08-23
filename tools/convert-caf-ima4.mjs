#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
  1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660,
  4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635,
  13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

function parseCaf(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "caff") throw new Error("Not a Core Audio Format file.");
  const chunks = new Map();
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const declaredSize = Number(buffer.readBigInt64BE(offset + 4));
    const start = offset + 12;
    const size = declaredSize < 0 ? buffer.length - start : declaredSize;
    if (!Number.isSafeInteger(size) || start + size > buffer.length) throw new Error(`Invalid ${type} chunk.`);
    chunks.set(type, buffer.subarray(start, start + size));
    offset = start + size;
  }
  const description = chunks.get("desc");
  const audio = chunks.get("data");
  if (!description || !audio || description.length < 32 || audio.length < 4) throw new Error("CAF is missing required audio chunks.");
  const format = description.toString("ascii", 8, 12);
  const channels = description.readUInt32BE(24);
  const bytesPerPacket = description.readUInt32BE(16);
  const framesPerPacket = description.readUInt32BE(20);
  if (format !== "ima4" || channels !== 1 || bytesPerPacket !== 34 || framesPerPacket !== 64) {
    throw new Error(`Unsupported CAF stream: ${format}, ${channels} channel(s), ${bytesPerPacket} bytes/packet.`);
  }
  const packetTable = chunks.get("pakt");
  const validFrames = packetTable?.length >= 16 ? Number(packetTable.readBigInt64BE(8)) : 0;
  return { sampleRate: description.readDoubleBE(0), data: audio.subarray(4), validFrames };
}

function decodePacket(packet, output, outputOffset) {
  const header = packet.readUInt16BE(0);
  let predictor = header & 0xff80;
  if (predictor & 0x8000) predictor -= 0x10000;
  let stepIndex = Math.min(88, header & 0x7f);
  let cursor = outputOffset;
  for (let byteIndex = 2; byteIndex < 34; byteIndex += 1) {
    const packed = packet[byteIndex];
    for (const nibble of [packed & 0x0f, packed >>> 4]) {
      const step = STEP_TABLE[stepIndex];
      let difference = step >>> 3;
      if (nibble & 1) difference += step >>> 2;
      if (nibble & 2) difference += step >>> 1;
      if (nibble & 4) difference += step;
      predictor += nibble & 8 ? -difference : difference;
      predictor = Math.max(-32768, Math.min(32767, predictor));
      stepIndex = Math.max(0, Math.min(88, stepIndex + INDEX_TABLE[nibble]));
      output[cursor] = predictor;
      cursor += 1;
    }
  }
}

function wavFromCaf(buffer) {
  const caf = parseCaf(buffer);
  const packetCount = Math.floor(caf.data.length / 34);
  const decoded = new Int16Array(packetCount * 64);
  for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
    decodePacket(caf.data.subarray(packetIndex * 34, packetIndex * 34 + 34), decoded, packetIndex * 64);
  }
  const frameCount = caf.validFrames > 0 ? Math.min(decoded.length, caf.validFrames) : decoded.length;
  const dataSize = frameCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(caf.sampleRate, 24); wav.writeUInt32LE(caf.sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < frameCount; index += 1) wav.writeInt16LE(decoded[index], 44 + index * 2);
  return { wav, sampleRate: caf.sampleRate, frameCount };
}

const [inputName, outputName] = process.argv.slice(2);
if (!inputName || !outputName) {
  console.error("Usage: node tools/convert-caf-ima4.mjs input.caf output.wav");
  process.exit(1);
}

const result = wavFromCaf(fs.readFileSync(inputName));
fs.mkdirSync(path.dirname(outputName), { recursive: true });
fs.writeFileSync(outputName, result.wav);
console.log(`${path.basename(inputName)} -> ${path.basename(outputName)} (${(result.frameCount / result.sampleRate).toFixed(2)}s)`);
