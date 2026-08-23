import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("every statically referenced original asset exists", () => {
  const files = ["index.html", "styles.css", "src/config.js", "src/app.js"];
  const references = new Set();
  const patterns = [
    /assets\/([A-Za-z0-9_. -]+\.(?:png|jpg))/g,
    /asset\("([^"]+)"\)/g,
    /asset\('([^']+)'\)/g,
    /(?:flag|icon|image):\s*"([^"]+\.png)"/g,
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) references.add(match[1]);
    }
  }
  const missing = [...references].filter((name) => !fs.existsSync(path.join(root, "assets", name)));
  assert.deepEqual(missing, []);
  assert.ok(references.size >= 35, `expected at least 35 original asset references, saw ${references.size}`);
});

test("all shipped PNGs use the standard PNG signature, not Apple's CgBI chunk", () => {
  const files = fs.readdirSync(path.join(root, "assets")).filter((name) => name.endsWith(".png"));
  assert.equal(files.length, 534);
  for (const name of files) {
    const bytes = fs.readFileSync(path.join(root, "assets", name));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", name);
    assert.notEqual(bytes.subarray(12, 16).toString("ascii"), "CgBI", name);
  }
});

test("preserved combat sounds are browser-native PCM wave files", () => {
  const audioRoot = path.join(root, "assets", "audio");
  const expected = ["marchSound.wav", "attack1Sound.wav", "attack2Sound.wav", "attack3Sound.wav", "attack4Sound.wav", "attackFailed.wav"];
  assert.deepEqual(fs.readdirSync(audioRoot).sort(), expected.sort());
  for (const name of expected) {
    const bytes = fs.readFileSync(path.join(audioRoot, name));
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF", name);
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE", name);
    assert.equal(bytes.readUInt16LE(20), 1, `${name} must use PCM`);
    assert.equal(bytes.readUInt16LE(22), 1, `${name} must be mono`);
    assert.equal(bytes.readUInt32LE(24), 44100, `${name} sample rate`);
    assert.ok(bytes.length > 100000, `${name} should contain decoded audio`);
  }
});
