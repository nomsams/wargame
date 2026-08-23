import { validateSavedGame } from "./engine.js";

export const SAVE_EXPORT_FORMAT = "wargame-browser-save";
export const SAVE_EXPORT_VERSION = 1;
export const MAX_SAVE_FILE_BYTES = 2 * 1024 * 1024;

export class SaveTransferError extends Error {
  constructor(message) {
    super(message);
    this.name = "SaveTransferError";
  }
}

export function createSaveExport(gameState, exportedAt = new Date()) {
  return {
    format: SAVE_EXPORT_FORMAT,
    exportVersion: SAVE_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    game: gameState,
  };
}

export function serializeSave(gameState, exportedAt = new Date()) {
  return `${JSON.stringify(createSaveExport(gameState, exportedAt), null, 2)}\n`;
}

export function saveFilename(gameState, exportedAt = new Date()) {
  const faction = String(gameState.playerFaction || "campaign").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const date = exportedAt.toISOString().slice(0, 10);
  return `wargame-${faction || "campaign"}-${gameState.year}-${date}.wargame.json`;
}

export function parseSaveText(text, data) {
  if (typeof text !== "string") throw new SaveTransferError("The selected save could not be read as text.");
  if (new TextEncoder().encode(text).byteLength > MAX_SAVE_FILE_BYTES) throw new SaveTransferError("That save is larger than the 2 MB safety limit.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SaveTransferError("That file is not valid JSON.");
  }

  let game = parsed;
  if (parsed?.format !== undefined) {
    if (parsed.format !== SAVE_EXPORT_FORMAT || parsed.exportVersion !== SAVE_EXPORT_VERSION) {
      throw new SaveTransferError("That file uses an unsupported Wargame save format.");
    }
    game = parsed.game;
  }

  if (!validateSavedGame(game, data)) throw new SaveTransferError("That file is incomplete, corrupted, or not a compatible Wargame save.");
  return game;
}
