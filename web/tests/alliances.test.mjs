import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { availableUnitCount, canBuyIn, countryDefense, diplomacyOrder, endTurn, newGame, queueMove, unitCost, validateSavedGame } from "../src/engine.js";
import { allianceBetween, isSupplied } from "../src/diplomacy.js";
import { REGIONAL_SCENARIO, scenarioData } from "../src/scenario.js";
import { parseSaveText, serializeSave } from "../src/save-transfer.js";

const board = JSON.parse(readFileSync(new URL("../data/game-data.json", import.meta.url)));
const allHuman = board.factions.map(({ factionName }) => factionName);
const [, EDF, REICH] = allHuman;

test("joint conquest assigns ownership by surviving troops and retains allied defenders", () => {
  const state = newGame(board, { playerFaction: EDF, alliances: true, seed: 21 });
  diplomacyOrder(board, state, EDF, "propose", REICH);
  diplomacyOrder(board, state, REICH, "accept", EDF);
  state.countries.BELGIUM.units.troops = 0;
  state.countries.FRANCE.units.troops = state.countries.GERMANY.units.troops = 40;
  queueMove(board, state, EDF, "FRANCE", "BELGIUM", "troops", 12);
  queueMove(board, state, REICH, "GERMANY", "BELGIUM", "troops", 30);
  const events = [];
  endTurn(board, state, events, allHuman);
  const belgium = state.countries.BELGIUM;
  assert.equal(belgium.owner, REICH);
  assert.ok(belgium.visitors[EDF].troops > 0);
  assert.ok(availableUnitCount(state, EDF, "BELGIUM", "troops") > 0);
  assert.equal(events.filter(({ country }) => country === "BELGIUM").length, 2);
  assert.equal(state.lastReplay.events.filter(({ country }) => country === "BELGIUM").length, 2);
  belgium.upgrades.push(1);
  assert.equal(canBuyIn(board, state, REICH, "BELGIUM"), true);
  assert.equal(canBuyIn(board, state, EDF, "BELGIUM"), false);
  const withVisitors = countryDefense(board, state, "BELGIUM");
  const capital = board.factions.find(({ factionName }) => factionName === EDF).capitalCountry;
  const homeBefore = state.countries[capital].units.troops;
  diplomacyOrder(board, state, EDF, "end", REICH);
  assert.ok(countryDefense(board, state, "BELGIUM") < withVisitors);
  assert.ok(state.countries[capital].units.troops > homeBefore);
  assert.ok(validateSavedGame(state, board));
});

test("an AI faction can accept an alliance and send requested support", () => {
  const state = newGame(board, { playerFaction: EDF, alliances: true, seed: 11 });
  diplomacyOrder(board, state, EDF, "propose", REICH);
  endTurn(board, state, [], allHuman.filter((name) => name !== REICH));
  assert.ok(allianceBetween(state, EDF, REICH));
  state.countries.FRANCE.units.troops = 20;
  state.countries.GERMANY.units.troops = 50;
  diplomacyOrder(board, state, EDF, "support", REICH, "FRANCE");
  endTurn(board, state, [], allHuman.filter((name) => name !== REICH));
  assert.ok(state.countries.FRANCE.visitors[REICH].troops > 0);
  assert.equal(state.countries.FRANCE.owner, EDF);
});

test("isolated purchases cost more and a stronger adjacent fleet cuts sea supply", () => {
  const state = newGame(board, { playerFaction: EDF, alliances: true, seed: 5 });
  const usa = allHuman[0];
  const japan = allHuman.at(-1);
  state.countries.MONGOLIA.owner = EDF;
  state.countries.MONGOLIA.upgrades.push(1);
  assert.equal(isSupplied(board, state, EDF, "MONGOLIA"), false);
  assert.ok(unitCost(board, state, EDF, "MONGOLIA", "troops") > unitCost(board, state, EDF, "FRANCE", "troops"));
  state.diplomacy.alliances.push({ members: [EDF, japan], locked: false });
  assert.equal(isSupplied(board, state, EDF, "MONGOLIA"), true);

  state.countries.SWEDEN.owner = EDF;
  state.countries.SWEDEN.units.ships = 3;
  state.countries.FRANCE.units.ships = 4;
  for (const name of ["GERMANY", "ITALY", "SPAIN", "BELGIUM", "SWITZERLAND"]) state.countries[name].units.ships = 0;
  state.countries.NORWAY.owner = usa;
  state.countries.NORWAY.units.ships = 1;
  assert.equal(isSupplied(board, state, EDF, "SWEDEN"), true);
  state.countries.NORWAY.units.ships = 5;
  assert.equal(isSupplied(board, state, EDF, "SWEDEN"), false);
});

test("the optional regional board preserves the original data and round-trips its saves", () => {
  const data = scenarioData(board, REGIONAL_SCENARIO);
  const game = newGame(data, { scenario: REGIONAL_SCENARIO, playerFaction: "GREATER ISRAEL", alliances: true, seed: 42 });
  assert.equal(game.countries.SYRIA.owner, "GREATER ISRAEL");
  assert.equal(game.countries.SAUDI_ARABIA.owner, "GREATER ISRAEL");
  assert.equal(game.countries.YEMEN.owner, "IRANIAN COALITION");
  assert.equal(game.countries.IRAN.owner, "IRANIAN COALITION");
  assert.equal(board.countries.find(({ name }) => name === "SAUDI_ARABIA").faction, "THE GREAT KHALIFA");
  assert.deepEqual(parseSaveText(serializeSave(game), board), game);
});

test("a unit specialization affects only its own unit type", () => {
  const campaign = () => newGame(board, { playerFaction: EDF, seed: 49 });
  const state = campaign();
  const country = state.countries.FRANCE;
  country.units = { troops: 20, ships: 0, planes: 0, missiles: 0, commandos: 0 };
  const troopsDefense = countryDefense(board, state, "FRANCE");
  state.factions[EDF].unitUpgrades.push("advanced-battleship");
  assert.equal(countryDefense(board, state, "FRANCE"), troopsDefense);
  state.factions[EDF].unitUpgrades.push("kevlar-vest");
  assert.equal(countryDefense(board, state, "FRANCE"), troopsDefense * 1.25);

  function troopAttack(upgrades) {
    const game = campaign();
    game.factions[EDF].unitUpgrades.push(...upgrades);
    queueMove(board, game, EDF, "FRANCE", "BELGIUM", "troops", 15);
    const events = [];
    endTurn(board, game, events, allHuman);
    return events[0].attackScore;
  }
  const regular = troopAttack([]);
  assert.equal(troopAttack(["advanced-battleship", "multi-warhead-missile"]), regular);
  assert.ok(troopAttack(["advanced-assault-rifle"]) > regular);
});
