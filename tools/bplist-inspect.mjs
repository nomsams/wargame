#!/usr/bin/env node

import fs from "node:fs";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node tools/bplist-inspect.mjs <binary-plist> [--strings]");
  process.exit(2);
}

const offsetFlag = process.argv.indexOf("--offset");
const lengthFlag = process.argv.indexOf("--length");
const file = fs.readFileSync(input);
const sliceOffset = offsetFlag >= 0 ? Number(process.argv[offsetFlag + 1]) : 0;
const sliceLength = lengthFlag >= 0 ? Number(process.argv[lengthFlag + 1]) : file.length - sliceOffset;
const buffer = file.subarray(sliceOffset, sliceOffset + sliceLength);
if (buffer.subarray(0, 8).toString("ascii") !== "bplist00") {
  throw new Error("Not an Apple binary property list");
}

const trailer = buffer.length - 32;
const offsetSize = buffer[trailer + 6];
const refSize = buffer[trailer + 7];

function readUnsigned(offset, size) {
  let value = 0n;
  for (let i = 0; i < size; i += 1) value = (value << 8n) | BigInt(buffer[offset + i]);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Integer exceeds safe JavaScript range");
  return Number(value);
}

const objectCount = readUnsigned(trailer + 8, 8);
const topObject = readUnsigned(trailer + 16, 8);
const offsetTable = readUnsigned(trailer + 24, 8);
if (objectCount > 100_000 || offsetTable >= trailer) throw new Error("Unsafe or corrupt plist trailer");

const offsets = Array.from({ length: objectCount }, (_, i) => readUnsigned(offsetTable + i * offsetSize, offsetSize));
const cache = new Map();
const active = new Set();

function readLength(info, cursor) {
  if (info < 15) return [info, cursor];
  const marker = buffer[cursor];
  if ((marker >> 4) !== 1) throw new Error("Extended length is not an integer");
  const bytes = 2 ** (marker & 15);
  return [readUnsigned(cursor + 1, bytes), cursor + 1 + bytes];
}

function readRef(offset) {
  return readUnsigned(offset, refSize);
}

function parseObject(index) {
  if (cache.has(index)) return cache.get(index);
  if (active.has(index)) return { $cycle: index };
  if (index < 0 || index >= objectCount) throw new Error(`Bad object reference ${index}`);
  active.add(index);
  const offset = offsets[index];
  const marker = buffer[offset];
  const type = marker >> 4;
  const info = marker & 15;
  let value;

  if (type === 0) {
    value = info === 8 ? false : info === 9 ? true : null;
  } else if (type === 1) {
    value = readUnsigned(offset + 1, 2 ** info);
  } else if (type === 2) {
    const bytes = 2 ** info;
    value = bytes === 4 ? buffer.readFloatBE(offset + 1) : buffer.readDoubleBE(offset + 1);
  } else if (type === 3 && info === 3) {
    const appleEpochSeconds = buffer.readDoubleBE(offset + 1);
    value = new Date(Date.UTC(2001, 0, 1) + appleEpochSeconds * 1000).toISOString();
  } else if (type === 4 || type === 5 || type === 6) {
    const [length, start] = readLength(info, offset + 1);
    if (length > 50_000_000) throw new Error("Unsafe plist payload length");
    if (type === 4) value = { $data: buffer.subarray(start, start + length).toString("base64"), $length: length };
    if (type === 5) value = buffer.subarray(start, start + length).toString("utf8");
    if (type === 6) {
      const bytes = buffer.subarray(start, start + length * 2);
      const swapped = Buffer.allocUnsafe(bytes.length);
      for (let i = 0; i < bytes.length; i += 2) { swapped[i] = bytes[i + 1]; swapped[i + 1] = bytes[i]; }
      value = swapped.toString("utf16le");
    }
  } else if (type === 8) {
    value = { $uid: readUnsigned(offset + 1, info + 1) };
  } else if (type === 10 || type === 11 || type === 12) {
    const [length, start] = readLength(info, offset + 1);
    value = Array.from({ length }, (_, i) => parseObject(readRef(start + i * refSize)));
  } else if (type === 13) {
    const [length, start] = readLength(info, offset + 1);
    const dictionary = {};
    for (let i = 0; i < length; i += 1) {
      const key = parseObject(readRef(start + i * refSize));
      dictionary[String(key)] = parseObject(readRef(start + (length + i) * refSize));
    }
    value = dictionary;
  } else {
    value = { $unsupported: marker, $offset: offset };
  }

  active.delete(index);
  cache.set(index, value);
  return value;
}

const parsed = parseObject(topObject);
const outputFlag = process.argv.indexOf("--output");
const write = (value) => {
  if (outputFlag >= 0) fs.writeFileSync(process.argv[outputFlag + 1], value);
  else process.stdout.write(value);
};
if (process.argv.includes("--strings")) {
  const found = new Set();
  const visit = (value) => {
    if (typeof value === "string") found.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => { found.add(key); visit(child); });
  };
  visit(parsed);
  write([...found].sort((a, b) => a.localeCompare(b)).join("\n") + "\n");
} else {
  write(JSON.stringify(parsed, null, 2) + "\n");
}
