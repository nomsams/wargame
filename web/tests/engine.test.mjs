import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  availableUnitCount,
  availableUpgrades,
  buyWorldUpgrade,
  cancelAction,
  endTurn,
  maxPurchasableUnits,
  newGame,
  queueBuy,
  queueMove,
  queueUpgrade,
  useSpyAction,
  useStrategicWeapon,
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

test("corrupted browser saves are rejected before they can enter the UI", () => {
  const state = newGame(data, { playerFaction: USA, seed: 43 });
  assert.equal(validateSavedGame(state, data), true);
  const missingFaction = structuredClone(state);
  delete missingFaction.factions[USA];
  assert.equal(validateSavedGame(missingFaction, data), false);
  const invalidGarrison = structuredClone(state);
  invalidGarrison.countries.UNITED_STATES.units.troops = -1;
  assert.equal(validateSavedGame(invalidGarrison, data), false);
  const invalidQueue = structuredClone(state);
  invalidQueue.queue.push({ id: "tampered", type: "move", faction: USA, from: "UNITED_STATES", to: "NOWHERE", unitType: "troops", quantity: 1 });
  assert.equal(validateSavedGame(invalidQueue, data), false);
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

test("purchase and move quantities must be positive whole numbers", () => {
  const state = newGame(data, { playerFaction: USA, seed: 13 });
  const startingCash = state.factions[USA].cash;
  assert.throws(() => queueBuy(data, state, USA, "UNITED_STATES", "troops", "not-a-number"), /positive whole number/);
  assert.throws(() => queueBuy(data, state, USA, "UNITED_STATES", "troops", 1.5), /positive whole number/);
  assert.throws(() => queueMove(data, state, USA, "UNITED_STATES", "CANADA", "troops", Infinity), /positive whole number/);
  assert.equal(state.factions[USA].cash, startingCash);
  assert.equal(state.queue.length, 0);
});

test("queued purchases count toward the commando cap", () => {
  const state = newGame(data, { playerFaction: USA, seed: 14 });
  state.factions[USA].cash = 100000;
  const capacity = maxPurchasableUnits(data, state, USA, "UNITED_STATES", "commandos");
  assert.ok(capacity > 0);
  queueBuy(data, state, USA, "UNITED_STATES", "commandos", capacity);
  assert.equal(maxPurchasableUnits(data, state, USA, "UNITED_STATES", "commandos"), 0);
  assert.throws(() => queueBuy(data, state, USA, "UNITED_STATES", "commandos", 1), /commando limit/);
});

test("move orders honor recovered adjacency", () => {
  const state = newGame(data, { playerFaction: USA, seed: 15 });
  queueMove(data, state, USA, "UNITED_STATES", "CANADA", "troops", 5);
  assert.equal(state.queue[0].type, "move");
  assert.equal(state.queue[0].to, "CANADA");
});

test("the available garrison excludes units committed to earlier orders", () => {
  const state = newGame(data, { playerFaction: USA, seed: 16 });
  queueMove(data, state, USA, "UNITED_STATES", "CANADA", "troops", 49);
  assert.equal(availableUnitCount(state, USA, "UNITED_STATES", "troops"), 1);
  assert.throws(() => queueMove(data, state, USA, "UNITED_STATES", "MEXICO", "troops", 2), /uncommitted units/);
});

test("original faction upgrade bitfields expose the expected research", () => {
  const state = newGame(data, { playerFaction: USA, seed: 8 });
  assert.deepEqual(availableUpgrades(data, state, USA, "world").map((upgrade) => upgrade.id), [12, 17]);
  assert.deepEqual(availableUpgrades(data, state, USA, "country", "UNITED_STATES").map((upgrade) => upgrade.id), [0, 1, 6, 15]);
});

test("a country upgrade cannot be queued and charged twice", () => {
  const state = newGame(data, { playerFaction: USA, seed: 17 });
  state.factions[USA].cash = 10000;
  queueUpgrade(data, state, USA, "UNITED_STATES", 0);
  assert.ok(!availableUpgrades(data, state, USA, "country", "UNITED_STATES").some((upgrade) => upgrade.id === 0));
  const reservedCash = state.factions[USA].cash;
  assert.throws(() => queueUpgrade(data, state, USA, "UNITED_STATES", 0), /unavailable or already built/);
  assert.equal(state.factions[USA].cash, reservedCash);
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

test("an immediate strategic strike can complete the campaign", () => {
  const state = newGame(data, { playerFaction: USA, objective: "destroyer", seed: 11 });
  for (const country of Object.values(state.countries)) if (country.owner !== USA) country.owner = null;
  state.countries.CZECHOSLOVAKIA.owner = "UNION OF SOVIET SOCIALIST REPUBLICS";
  state.factions[USA].worldUpgrades.push(12);
  state.factions[USA].nukes = 1;
  useStrategicWeapon(state, USA, "nuke", "CZECHOSLOVAKIA");
  assert.equal(state.status, "victory");
  assert.equal(state.winner, USA);
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
