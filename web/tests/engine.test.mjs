import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  availableUpgrades,
  buyWorldUpgrade,
  cancelAction,
  endTurn,
  newGame,
  queueBuy,
  queueMove,
  useSpyAction,
  validateSavedGame,
} from "../src/engine.js";

const dataUrl = new URL("../data/game-data.json", import.meta.url);
const data = JSON.parse(fs.readFileSync(fileURLToPath(dataUrl), "utf8"));
const USA = "UNITED STATES OF AMERICA";

test("recovered archive contains the complete original board", () => {
  assert.equal(data.factions.length, 6);
  assert.equal(data.countries.length, 91);
  assert.equal(data.map.countries.length, 91);
  assert.equal(data.map.vertices.length, 5542);
  assert.equal(data.map.indices.length, 14670);
  assert.deepEqual(data.map.countries.map((country) => country.name), data.countries.map((country) => country.name));
  assert.ok(data.map.indices.every((index) => index >= 0 && index < data.map.vertices.length));
});

test("new campaigns preserve faction and starting-country data", () => {
  const state = newGame(data, { playerFaction: USA, heroName: "Ada", seed: 42 });
  assert.equal(Object.keys(state.factions).length, 6);
  assert.equal(Object.keys(state.countries).length, 91);
  assert.equal(Object.values(state.countries).filter((country) => country.owner === USA).length, 3);
  assert.equal(state.countries.UNITED_STATES.units.troops, 50);
  assert.equal(state.countries.ALASKA.units.ships, 30);
  assert.equal(state.factions[USA].general.name, "Ada");
  assert.equal(state.factions[USA].cash, 50);
});

test("queued purchases reserve cash and can be cancelled with a refund", () => {
  const state = newGame(data, { playerFaction: USA, seed: 12 });
  const startingCash = state.factions[USA].cash;
  queueBuy(data, state, USA, "UNITED_STATES", "troops", 1);
  assert.equal(state.queue.length, 1);
  assert.ok(state.factions[USA].cash < startingCash);
  cancelAction(state, state.queue[0].id);
  assert.equal(state.queue.length, 0);
  assert.equal(state.factions[USA].cash, startingCash);
});

test("move orders honor recovered adjacency", () => {
  const state = newGame(data, { playerFaction: USA, seed: 15 });
  queueMove(data, state, USA, "UNITED_STATES", "CANADA", "troops", 5);
  assert.equal(state.queue[0].type, "move");
  assert.equal(state.queue[0].to, "CANADA");
});

test("original faction upgrade bitfields expose the expected research", () => {
  const state = newGame(data, { playerFaction: USA, seed: 8 });
  assert.deepEqual(availableUpgrades(data, state, USA, "world").map((upgrade) => upgrade.id), [12, 17]);
  assert.deepEqual(availableUpgrades(data, state, USA, "country", "UNITED_STATES").map((upgrade) => upgrade.id), [0, 1, 6, 15]);
});

test("Manhattan Project grants exactly two recovered tactical warheads", () => {
  const state = newGame(data, { playerFaction: USA, seed: 9 });
  state.factions[USA].cash = 2000;
  buyWorldUpgrade(data, state, USA, 12);
  assert.equal(state.factions[USA].nukes, 2);
  assert.ok(state.factions[USA].worldUpgrades.includes(12));
  assert.equal(state.factions[USA].cash, 1000);
});

test("espionage is immediate and intelligence persists", () => {
  const state = newGame(data, { playerFaction: USA, seed: 10 });
  useSpyAction(data, state, USA, "intelligence", "CZECHOSLOVAKIA");
  assert.ok(state.intel.includes(`${USA}:CZECHOSLOVAKIA`));
  assert.equal(state.queue.length, 0);
});

test("end turn resolves orders, runs AI, pays income, and autosave shape remains valid", () => {
  const state = newGame(data, { playerFaction: USA, difficulty: "easy", seed: 1 });
  queueMove(data, state, USA, "UNITED_STATES", "CANADA", "troops", 5);
  endTurn(data, state);
  assert.equal(state.year, 2011);
  assert.equal(state.queue.length, 0);
  assert.ok(state.factions[USA].cash > 50);
  assert.equal(validateSavedGame(JSON.parse(JSON.stringify(state)), data), true);
});
