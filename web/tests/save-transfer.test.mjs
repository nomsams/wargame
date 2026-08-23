import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { newGame } from "../src/engine.js";
import {
  MAX_SAVE_FILE_BYTES,
  SAVE_EXPORT_FORMAT,
  SaveTransferError,
  createSaveExport,
  parseSaveText,
  saveFilename,
  serializeSave,
} from "../src/save-transfer.js";

const data = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../data/game-data.json", import.meta.url)), "utf8"));
const USA = "UNITED STATES OF AMERICA";

test("portable saves round-trip through the versioned JSON envelope", () => {
  const state = newGame(data, { playerFaction: USA, heroName: "Portable General", seed: 912 });
  state.year = 2018;
  const exportedAt = new Date("2026-08-23T12:00:00.000Z");
  const document = createSaveExport(state, exportedAt);

  assert.equal(document.format, SAVE_EXPORT_FORMAT);
  assert.equal(document.exportedAt, exportedAt.toISOString());
  assert.deepEqual(parseSaveText(serializeSave(state, exportedAt), data), state);
  assert.equal(saveFilename(state, exportedAt), "wargame-united-states-of-america-2018-2026-08-23.wargame.json");
});

test("import remains compatible with raw browser-save JSON", () => {
  const state = newGame(data, { playerFaction: USA, seed: 913 });
  assert.deepEqual(parseSaveText(JSON.stringify(state), data), state);
});

test("unsafe, incompatible, malformed, and oversized imports are rejected", () => {
  const state = newGame(data, { playerFaction: USA, seed: 914 });
  const incompatible = { ...createSaveExport(state), exportVersion: 99 };
  assert.throws(() => parseSaveText(JSON.stringify(incompatible), data), SaveTransferError);
  assert.throws(() => parseSaveText("not json", data), SaveTransferError);
  assert.throws(() => parseSaveText(JSON.stringify({ ...state, countries: {} }), data), SaveTransferError);
  assert.throws(() => parseSaveText(" ".repeat(MAX_SAVE_FILE_BYTES + 1), data), /2 MB safety limit/);
});
