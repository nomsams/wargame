#!/usr/bin/env node

import fs from "node:fs";

const input = process.argv[2];
const minimum = Number(process.argv[3] || 4);
if (!input) {
  console.error("Usage: node tools/extract-strings.mjs <file> [minimum-length]");
  process.exit(2);
}

const bytes = fs.readFileSync(input);
const strings = new Set();

for (let i = 0; i < bytes.length;) {
  let end = i;
  while (end < bytes.length && bytes[end] >= 0x20 && bytes[end] <= 0x7e) end += 1;
  if (end - i >= minimum) strings.add(bytes.subarray(i, end).toString("ascii"));
  i = Math.max(end + 1, i + 1);
}

for (let i = 0; i + 1 < bytes.length;) {
  let end = i;
  while (end + 1 < bytes.length && bytes[end] >= 0x20 && bytes[end] <= 0x7e && bytes[end + 1] === 0) end += 2;
  if ((end - i) / 2 >= minimum) {
    const chars = [];
    for (let cursor = i; cursor < end; cursor += 2) chars.push(String.fromCharCode(bytes[cursor]));
    strings.add(chars.join(""));
  }
  i = Math.max(end + 2, i + 2);
}

process.stdout.write([...strings].join("\n") + "\n");
