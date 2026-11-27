import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  availableBoardingCapacity,
  availableUnitCount,
  availableUpgrades,
  boardTroops,
  buyWorldUpgrade,
  canBuyIn,
  cancelAction,
  awardedMedals,
  availableUnitUpgrades,
  buyUnitUpgrade,
  chooseNavalDoctrine,
  countryDefense,
  countryResourceBonus,
  endTurn,
  maxPurchasableUnits,
  migrateSavedGame,
  navalTransportMultiplier,
  newGame,
  queueBuy,
  queueMove,
  queueUpgrade,
  unitCost,
  useSpyAction,
  useStrategicWeapon,
  validateSavedGame,
} from "../src/engine.js";
import { DIFFICULTIES, MEDALS, UNIT_TYPES, UNIT_UPGRADES, difficultyById, unitUpgradeBranch, unitUpgradeById } from "../src/config.js";
import l10n from "../data/localization-en.json" with { type: "json" };

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
  assert.ok(data.countries.every((country) => Number.isInteger(country.countryResource) && country.countryResource >= 0 && country.countryResource <= 5));
  assert.deepEqual(data.countries.reduce((counts, country) => {
    counts[country.countryResource] = (counts[country.countryResource] || 0) + 1;
    return counts;
  }, {}), { 0: 14, 1: 17, 2: 8, 3: 22, 4: 7, 5: 23 });
  assert.equal(data.countries.find((country) => country.name === "SWEDEN").countryResource, 1);
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

test("country resources grant the recovered yearly units and Power Plant doubles only that grant", () => {
  const state = newGame(data, { playerFaction: USA, seed: 44 });
  for (const [name, faction] of Object.entries(state.factions)) if (name !== USA) faction.defeated = true;
  state.countries.SWEDEN.owner = USA;
  const startingPlanes = state.countries.SWEDEN.units.planes;
  endTurn(data, state);
  assert.equal(state.countries.SWEDEN.units.planes, startingPlanes + 1);

  state.countries.SWEDEN.upgrades.push(15);
  endTurn(data, state);
  assert.equal(state.countries.SWEDEN.units.planes, startingPlanes + 3);
  assert.deepEqual(countryResourceBonus(data, state, "SWEDEN"), { cash: 0, units: { planes: 2 }, costDiscount: 0 });
});

test("Petroleum discounts recovered unit types and Power Plant doubles the discount", () => {
  const state = newGame(data, { playerFaction: USA, seed: 45 });
  const faction = data.factions.find((item) => item.factionName === USA);
  assert.equal(unitCost(data, state, USA, "ALASKA", "ships"), Math.round(faction.shipsCost * 0.75));
  assert.equal(unitCost(data, state, USA, "ALASKA", "troops"), faction.troopsCost);
  state.countries.ALASKA.upgrades.push(15);
  assert.equal(unitCost(data, state, USA, "ALASKA", "ships"), Math.round(faction.shipsCost * 0.5));
  assert.equal(countryResourceBonus(data, state, "ALASKA").costDiscount, 0.5);
});

test("resource synergy awards the recovered capital bonus after ten countries", () => {
  const state = newGame(data, { playerFaction: USA, seed: 46 });
  for (const [name, faction] of Object.entries(state.factions)) if (name !== USA) faction.defeated = true;
  for (const source of data.countries.filter((country) => country.countryResource === 3).slice(0, 10)) state.countries[source.name].owner = USA;
  const capitalTroops = state.countries.UNITED_STATES.units.troops;
  endTurn(data, state);
  assert.equal(state.countries.UNITED_STATES.units.troops, capitalTroops + 10);
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
  const invalidUpgrade = structuredClone(state);
  invalidUpgrade.countries.UNITED_STATES.upgrades.push(9999);
  assert.equal(validateSavedGame(invalidUpgrade, data), false);
  const invalidIntel = structuredClone(state);
  invalidIntel.intel.push(`${USA}:NOWHERE`);
  assert.equal(validateSavedGame(invalidIntel, data), false);
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

test("newly conquered countries require a Supply Center before buying units", () => {
  const state = newGame(data, { playerFaction: USA, seed: 47 });
  state.countries.MEXICO.owner = USA;
  assert.equal(canBuyIn(data, state, USA, "MEXICO"), false);
  state.countries.MEXICO.upgrades.push(1);
  assert.equal(canBuyIn(data, state, USA, "MEXICO"), true);
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

test("queued ships can carry available troops along the same route", () => {
  const state = newGame(data, { playerFaction: USA, seed: 18 });
  const alaskaTroops = state.countries.ALASKA.units.troops;
  const fleet = queueMove(data, state, USA, "UNITED_STATES", "ALASKA", "ships", 10);
  assert.equal(availableBoardingCapacity(state, USA, fleet.id), 10);
  boardTroops(state, USA, fleet.id, 10);
  assert.equal(fleet.carriedTroops, 10);
  assert.equal(availableUnitCount(state, USA, "UNITED_STATES", "troops"), 40);
  endTurn(data, state);
  assert.equal(state.countries.ALASKA.units.troops, alaskaTroops + 10);
});

test("Sea Carrier doubles troop space and is a permanent naval choice", () => {
  const state = newGame(data, { playerFaction: USA, seed: 19 });
  state.countries.UNITED_STATES.units.troops = 100;
  state.factions[USA].cash = 1000;
  chooseNavalDoctrine(state, USA, "sea-carrier");
  assert.equal(navalTransportMultiplier(state, USA), 2);
  const fleet = queueMove(data, state, USA, "UNITED_STATES", "ALASKA", "ships", 30);
  assert.equal(availableBoardingCapacity(state, USA, fleet.id), 60);
  boardTroops(state, USA, fleet.id, 60);
  assert.throws(() => chooseNavalDoctrine(state, USA, "advanced-battleship"), /already been selected/);
});

// Attack score is internal, so it is measured through a real battle. Planes,
// missiles, and commandos reach any country, so Mexico is a safe target that
// is never a starred starting country.
function attackScoreFor(state, factionName, unitType, quantity) {
  const rival = Object.keys(state.factions).find((name) => name !== factionName);
  for (const [name, faction] of Object.entries(state.factions)) {
    if (name !== factionName) faction.defeated = true;
  }
  state.countries.MEXICO.owner = rival;
  state.countries.MEXICO.units = { troops: 1, ships: 0, planes: 0, missiles: 0, commandos: 0 };
  state.countries.UNITED_STATES.units[unitType] = quantity;
  queueMove(data, state, factionName, "UNITED_STATES", "MEXICO", unitType, quantity);
  const battles = [];
  endTurn(data, state, battles);
  const battle = battles.find((item) => item.country === "MEXICO");
  return battle ? battle.attackScore : 0;
}
test("difficulty offers the five original army-rank tiers", () => {
  assert.equal(DIFFICULTIES.length, 5);
  assert.deepEqual(DIFFICULTIES.map((item) => item.rank), ["Private", "Sergeant", "Captain", "Colonel", "General"]);
  // The ranks come from the Super Easy..Super Hard localization keys.
  for (const item of DIFFICULTIES) assert.equal(l10n[item.title], item.rank, item.title);
  // Each tier is strictly harder than the one before it.
  for (let i = 1; i < DIFFICULTIES.length; i += 1) {
    assert.ok(DIFFICULTIES[i].reserve < DIFFICULTIES[i - 1].reserve, DIFFICULTIES[i].rank);
    assert.ok(DIFFICULTIES[i].attacks >= DIFFICULTIES[i - 1].attacks, DIFFICULTIES[i].rank);
    assert.ok(DIFFICULTIES[i].threshold <= DIFFICULTIES[i - 1].threshold, DIFFICULTIES[i].rank);
  }
  assert.equal(difficultyById("normal").rank, "Captain");
  assert.equal(difficultyById("nonsense").rank, "Captain");
});

test("every difficulty tier produces a valid saved game", () => {
  for (const item of DIFFICULTIES) {
    const state = newGame(data, { playerFaction: USA, difficulty: item.id, seed: 5 });
    assert.equal(validateSavedGame(state, data), true, item.id);
  }
});

test("medal catalogue matches the fourteen recovered names in ID order", () => {
  assert.equal(MEDALS.length, 14);
  assert.deepEqual(MEDALS.map((medal) => medal.id), [...Array(14).keys()]);
  // Names recovered from -[Medal medalName] at 0x82420.
  assert.deepEqual(MEDALS.map((medal) => medal.name), [
    "Medal Purple Heart", "Medal Combat Readiness", "Medal Defence Distinguished Service",
    "Medal Army Achievement", "Medal Navy Achievement", "Medal Air Force Achievement",
    "Medal Rocket Achievement", "Medal Expert Rifleman", "Medal Resources Service",
    "Medal Arctic Service", "Medal Desert Service", "Medal Bronze Star",
    "Medal Silver Star", "Medal Medal of Honor",
  ]);
  // Every medal has recovered artwork and a recovered description.
  for (const medal of MEDALS) {
    assert.ok(fs.existsSync(new URL(`../assets/${medal.image}`, import.meta.url)), medal.image);
    assert.ok(l10n[`${medal.name} Description`], `${medal.name} description missing`);
  }
});

test("Purple Heart is awarded for losing a battle", () => {
  const state = newGame(data, { playerFaction: USA, seed: 61 });
  for (const [name, faction] of Object.entries(state.factions)) if (name !== USA) faction.defeated = true;
  state.countries.MEXICO.owner = null;
  state.countries.MEXICO.units = { troops: 4000, ships: 0, planes: 0, missiles: 0, commandos: 0 };
  state.countries.UNITED_STATES.units.troops = 10;
  queueMove(data, state, USA, "UNITED_STATES", "MEXICO", "troops", 10);
  endTurn(data, state, []);
  assert.ok(awardedMedals(state).some((medal) => medal.id === 0), "Purple Heart must be awarded");
});

test("Expert Rifleman is awarded for enrolling 100 commandos", () => {
  const state = newGame(data, { playerFaction: USA, seed: 62 });
  state.factions[USA].cash = 100000;
  queueBuy(data, state, USA, "UNITED_STATES", "commandos", 100);
  endTurn(data, state, []);
  assert.equal(state.factions[USA].built.commandos, 100);
  assert.ok(awardedMedals(state).some((medal) => medal.id === 7), "Expert Rifleman must be awarded");
});

test("Arctic and Desert Service require every listed country", () => {
  const state = newGame(data, { playerFaction: USA, seed: 63 });
  for (const name of ["ALASKA", "ICELAND"]) state.countries[name].owner = USA;
  endTurn(data, state, []);
  assert.ok(!awardedMedals(state).some((medal) => medal.id === 9), "Arctic Service needs all four countries");
  for (const name of ["GREENLAND", "GREAT_SIBERIA"]) state.countries[name].owner = USA;
  endTurn(data, state, []);
  assert.ok(awardedMedals(state).some((medal) => medal.id === 9), "Arctic Service must be awarded");

  for (const name of ["ALGERIA", "LYBIA", "TUNISIA"]) state.countries[name].owner = USA;
  endTurn(data, state, []);
  assert.ok(!awardedMedals(state).some((medal) => medal.id === 10), "Desert Service needs all four countries");
  state.countries.EGYPT.owner = USA;
  endTurn(data, state, []);
  assert.ok(awardedMedals(state).some((medal) => medal.id === 10), "Desert Service must be awarded");
});

test("Bronze and Silver Star track destroyed factions", () => {
  const state = newGame(data, { playerFaction: USA, seed: 64 });
  const other = (state, i) => Object.keys(state.factions).filter((name) => name !== USA)[i];
  endTurn(data, state, []);
  assert.ok(!awardedMedals(state).some((medal) => medal.id === 11));
  state.factions[other(state, 0)].defeated = true;
  state.countries[other(state, 0)] = { ...state.countries[other(state, 0)], owner: null };
  endTurn(data, state, []);
  assert.ok(awardedMedals(state).some((medal) => medal.id === 11), "Bronze Star must be awarded");
  assert.ok(!awardedMedals(state).some((medal) => medal.id === 12));
  state.factions[other(state, 1)].defeated = true;
  state.countries[other(state, 1)] = { ...state.countries[other(state, 1)], owner: null };
  endTurn(data, state, []);
  assert.ok(awardedMedals(state).some((medal) => medal.id === 12), "Silver Star must be awarded");
});

test("Defence Distinguished Service is awarded for retaking a lost starting country", () => {
  const EDF = "EUROPEAN DEMOCRATIC FEDERATION";
  const TGR = "THE GREAT REICH";
  const state = newGame(data, { playerFaction: EDF, seed: 7 });
  for (const [name, faction] of Object.entries(state.factions)) if (name !== EDF && name !== TGR) faction.defeated = true;

  // Turn 1: the Reich takes France, which is a recovered EDF starting country.
  state.countries.BELGIUM.owner = TGR;
  state.countries.BELGIUM.units.troops = 900;
  state.countries.FRANCE.units = { troops: 1, ships: 0, planes: 0, missiles: 0, commandos: 0 };
  queueMove(data, state, TGR, "BELGIUM", "FRANCE", "troops", 500);
  endTurn(data, state, []);
  assert.equal(state.countries.FRANCE.owner, TGR);
  assert.deepEqual(state.factions[EDF].startingCountriesLost, ["FRANCE"]);
  assert.ok(!awardedMedals(state).some((medal) => medal.id === 2), "losing the country alone must not award it");

  // Turn 2: the Federation storms it back.
  state.countries.ITALY.owner = EDF;
  state.countries.ITALY.units.troops = 5000;
  queueMove(data, state, EDF, "ITALY", "FRANCE", "troops", 4000);
  endTurn(data, state, []);
  assert.equal(state.countries.FRANCE.owner, EDF);
  assert.deepEqual(state.factions[EDF].startingCountriesRetaken, ["FRANCE"]);
  assert.ok(awardedMedals(state).some((medal) => medal.id === 2), "Defence medal must be awarded");
});

test("a repelled attack does not mark a starting country as lost", () => {
  const EDF = "EUROPEAN DEMOCRATIC FEDERATION";
  const TGR = "THE GREAT REICH";
  const state = newGame(data, { playerFaction: EDF, seed: 8 });
  for (const [name, faction] of Object.entries(state.factions)) if (name !== EDF && name !== TGR) faction.defeated = true;
  state.countries.BELGIUM.owner = TGR;
  state.countries.BELGIUM.units.troops = 10;
  state.countries.FRANCE.units = { troops: 5000, ships: 0, planes: 0, missiles: 0, commandos: 0 };
  queueMove(data, state, TGR, "BELGIUM", "FRANCE", "troops", 10);
  endTurn(data, state, []);
  assert.equal(state.countries.FRANCE.owner, EDF, "the assault must be repelled");
  assert.deepEqual(state.factions[EDF].startingCountriesLost, [], "a held country is not lost");
});
test("every capital synergy is reachable on the recovered map", () => {
  // The map holds only eight Finance and seven Ore countries, so the original
  // flat "ten countries" rule left two of the six bonuses permanently dead.
  const counts = [0, 1, 2, 3, 4, 5].map((resource) => data.countries.filter((country) => country.countryResource === resource).length);
  for (const count of counts) assert.ok(count >= 4, "every resource needs enough countries to be winnable");

  const capital = "UNITED_STATES";
  // Holding every country of a resource must deliver that resource's award.
  for (const resource of [0, 1, 2, 3, 4, 5]) {
    const owned = data.countries.filter((country) => country.countryResource === resource);
    const state = newGame(data, { playerFaction: USA, seed: 1 });
    for (const country of owned) state.countries[country.name].owner = USA;
    const unitsBefore = { ...state.countries[capital].units };
    const cashBefore = state.factions[USA].cash;
    endTurn(data, state, []);
    const gained = Object.keys(unitsBefore).some((unitType) => state.countries[capital].units[unitType] > unitsBefore[unitType]);
    const cashGained = state.factions[USA].cash > cashBefore;
    assert.ok(gained || cashGained, `resource ${resource} synergy never fires`);
  }
});

test("a capital synergy stays unearned when control is only partial", () => {
  const state = newGame(data, { playerFaction: USA, seed: 1 });
  const ore = data.countries.filter((country) => country.countryResource === 4);
  for (const country of ore.slice(0, 2)) state.countries[country.name].owner = USA;
  const before = state.countries.UNITED_STATES.units.missiles;
  endTurn(data, state, []);
  assert.equal(state.countries.UNITED_STATES.units.missiles, before, "Ore synergy must not fire on a fraction of the map");
});
test("rival factions research the unit tree over a long campaign", () => {
  const state = newGame(data, { playerFaction: USA, seed: 11 });
  for (let year = 0; year < 60; year += 1) endTurn(data, state, []);
  const rivals = Object.entries(state.factions).filter(([name]) => name !== USA && !state.factions[name].defeated);
  assert.ok(rivals.length > 0, "at least one rival should survive");
  for (const [name, faction] of rivals) {
    assert.ok(faction.unitUpgrades.length > 0, `${name} never researched anything`);
    // One branch per unit type, never two of the same.
    const types = faction.unitUpgrades.map((id) => unitUpgradeById(id).unitType);
    assert.equal(new Set(types).size, types.length, `${name} took two branches of one unit type`);
  }
  // At least one rival should reach the expensive end of the tree.
  assert.ok(rivals.some(([, faction]) => faction.unitUpgrades.length >= 4), "no rival progressed past the cheap branches");
  assert.equal(validateSavedGame(state, data), true);
});

test("a research goal that names a taken branch is dropped safely", () => {
  const state = newGame(data, { playerFaction: USA, seed: 12 });
  state.factions[USA].researchGoal = "bomber";
  assert.equal(validateSavedGame(state, data), true);
  state.factions[USA].researchGoal = "not-a-real-upgrade";
  assert.equal(validateSavedGame(state, data), false, "an unknown goal must be rejected");
});
test("a campaign saved before the medal counters still loads", () => {
  // Older browser saves and downloaded files predate medals, the difficulty
  // rename, and Project Lazarus. They must be migrated, not rejected.
  const legacy = newGame(data, { playerFaction: USA, seed: 3 });
  for (const field of ["medals", "built", "battlesLost", "startingCountriesLost", "startingCountriesRetaken", "commandosLost"]) {
    delete legacy.factions[USA][field];
  }
  assert.equal(validateSavedGame(legacy, data), false, "the raw legacy shape is not valid on its own");
  migrateSavedGame(legacy);
  assert.equal(validateSavedGame(legacy, data), true, "a migrated legacy campaign must load");
  assert.deepEqual(legacy.factions[USA].medals, []);
  assert.equal(legacy.factions[USA].built.troops, 0);
  // A migrated campaign still plays.
  endTurn(data, legacy, []);
  assert.equal(validateSavedGame(legacy, data), true);
});

test("an unknown difficulty in an old save falls back to a valid tier", () => {
  const state = newGame(data, { playerFaction: USA, seed: 4 });
  state.difficulty = "insane";
  assert.equal(validateSavedGame(state, data), false);
  migrateSavedGame(state);
  assert.equal(validateSavedGame(state, data), true);
  assert.equal(state.difficulty, "normal");
});

test("tampered medal and counter values are still rejected", () => {
  const state = newGame(data, { playerFaction: USA, seed: 5 });
  const badMedal = JSON.parse(JSON.stringify(state));
  badMedal.factions[USA].medals = [99];
  assert.equal(validateSavedGame(badMedal, data), false, "unknown medal ids must be rejected");
  const negative = JSON.parse(JSON.stringify(state));
  negative.factions[USA].built.troops = -1;
  assert.equal(validateSavedGame(negative, data), false, "negative counters must be rejected");
});
test("medals persist through a saved campaign", () => {
  const state = newGame(data, { playerFaction: USA, seed: 65 });
  state.factions[USA].cash = 100000;
  queueBuy(data, state, USA, "UNITED_STATES", "commandos", 100);
  endTurn(data, state, []);
  assert.ok(state.factions[USA].medals.length > 0);
  assert.equal(validateSavedGame(state, data), true);
  assert.ok(awardedMedals(state).every((medal) => MEDALS.includes(medal)));
});
test("unit research prices match the original UnitManager cost switch", () => {
  // Recovered from +[UnitManager upgradeCost:] at 0x828a4 in the archived
  // Mach-O. Each unit type's pair shares one price, and every pair matches.
  const expected = {
    "advanced-assault-rifle": 200,
    "kevlar-vest": 200,
    "sea-carrier": 400,
    "advanced-battleship": 400,
    "bomber": 1000,
    "stealth-aircraft": 1000,
    "multi-warhead-missile": 500,
    "explosive-device": 500,
    "advanced-training-facility": 2000,
    "project-lazarus": 2000,
  };
  assert.equal(UNIT_UPGRADES.length, 10);
  for (const [id, cost] of Object.entries(expected)) {
    assert.equal(unitUpgradeById(id).cost, cost, id);
  }
  // Both halves of every branch cost the same in the original.
  for (const unitType of Object.keys(UNIT_TYPES)) {
    const pair = unitUpgradeBranch(unitType);
    assert.equal(pair.length, 2, unitType);
    assert.equal(pair[0].cost, pair[1].cost, unitType);
  }
});
test("unit research offers exactly one branch per unit type and charges for it", () => {
  const state = newGame(data, { playerFaction: USA, seed: 30 });
  state.factions[USA].cash = 5000;
  // Every unit type starts with its full branch pair available.
  for (const unitType of Object.keys(UNIT_TYPES)) {
    assert.equal(availableUnitUpgrades(state, USA).filter((item) => item.unitType === unitType).length, 2, unitType);
  }
  const cost = unitUpgradeById("advanced-assault-rifle").cost;
  buyUnitUpgrade(state, USA, "advanced-assault-rifle");
  assert.equal(state.factions[USA].cash, 5000 - cost);
  assert.ok(state.factions[USA].unitUpgrades.includes("advanced-assault-rifle"));
  // The sibling branch is now locked, and other unit types stay open.
  assert.throws(() => buyUnitUpgrade(state, USA, "kevlar-vest"), /already been selected/);
  assert.throws(() => buyUnitUpgrade(state, USA, "advanced-assault-rifle"), /already installed/);
  assert.equal(availableUnitUpgrades(state, USA).filter((item) => item.unitType === "troops").length, 0);
  assert.equal(availableUnitUpgrades(state, USA).filter((item) => item.unitType === "ships").length, 2);
  assert.throws(() => buyUnitUpgrade(state, USA, "not-a-real-upgrade"), /Unknown unit upgrade/);
});

test("unit research cannot be bought without funds", () => {
  const state = newGame(data, { playerFaction: USA, seed: 31 });
  state.factions[USA].cash = 10;
  assert.throws(() => buyUnitUpgrade(state, USA, "bomber"), /Insufficient funds/);
});

test("Advanced Assault Rifle and Kevlar Vest change troop combat", () => {
  const state = newGame(data, { playerFaction: USA, seed: 32 });
  state.factions[USA].cash = 5000;
  const baseDefense = countryDefense(data, state, "UNITED_STATES");
  buyUnitUpgrade(state, USA, "kevlar-vest");
  assert.ok(countryDefense(data, state, "UNITED_STATES") > baseDefense);

  const plain = newGame(data, { playerFaction: USA, seed: 33 });
  const plainScore = attackScoreFor(plain, USA, "troops", 40);
  const rifle = newGame(data, { playerFaction: USA, seed: 33 });
  rifle.factions[USA].cash = 5000;
  buyUnitUpgrade(rifle, USA, "advanced-assault-rifle");
  assert.ok(attackScoreFor(rifle, USA, "troops", 40) > plainScore);
});

test("Multi-Warhead Missile raises missile attack by half", () => {
  const state = newGame(data, { playerFaction: USA, seed: 34 });
  const plain = attackScoreFor(state, USA, "missiles", 10);
  state.factions[USA].cash = 5000;
  buyUnitUpgrade(state, USA, "multi-warhead-missile");
  assert.ok(attackScoreFor(state, USA, "missiles", 10) > plain);
});

test("Advanced Battleship raises ship attack and defence", () => {
  const state = newGame(data, { playerFaction: USA, seed: 35 });
  state.countries.UNITED_STATES.units.ships = 40;
  const plainDefense = countryDefense(data, state, "UNITED_STATES");
  const plain = newGame(data, { playerFaction: USA, seed: 351 });
  plain.countries.UNITED_STATES.units.ships = 40;
  const plainScore = attackScoreFor(plain, USA, "ships", 20);
  state.factions[USA].cash = 5000;
  buyUnitUpgrade(state, USA, "advanced-battleship");
  assert.ok(countryDefense(data, state, "UNITED_STATES") > plainDefense);
  assert.ok(attackScoreFor(state, USA, "ships", 20) > plainScore);
});

test("Stealth Aircraft reduce plane losses in an attack", () => {
  const survivors = (factions, seed) => {
    const state = newGame(data, { playerFaction: USA, seed });
    for (const upgrade of factions) {
      state.factions[USA].cash = 5000;
      buyUnitUpgrade(state, USA, upgrade);
    }
    for (const [name, faction] of Object.entries(state.factions)) if (name !== USA) faction.defeated = true;
    state.countries.ALASKA.owner = null;
    state.countries.ALASKA.units = { troops: 60, ships: 0, planes: 0, missiles: 0, commandos: 0 };
    state.countries.UNITED_STATES.units.planes = 100;
    queueMove(data, state, USA, "UNITED_STATES", "ALASKA", "planes", 40);
    const battles = [];
    endTurn(data, state, battles);
    const battle = battles.find((item) => item.country === "ALASKA");
    return battle ? battle.survivors : 0;
  };
  // Same seed isolates the upgrade as the only difference.
  assert.ok(survivors(["stealth-aircraft"], 36) > survivors([], 36));
});
test("Bomber needs 20 planes and skips starred starting countries", () => {
  // A repelled air strike is the only case where infrastructure survives a
  // conquest, so the strike is aimed at a strong neutral country.
  const strike = (planes, seed, upgrades) => {
    const state = newGame(data, { playerFaction: USA, seed });
    for (const upgrade of upgrades) {
      state.factions[USA].cash = 5000;
      buyUnitUpgrade(state, USA, upgrade);
    }
    for (const [name, faction] of Object.entries(state.factions)) if (name !== USA) faction.defeated = true;
    state.countries.MEXICO.owner = null;
    state.countries.MEXICO.units = { troops: 4000, ships: 0, planes: 0, missiles: 0, commandos: 0 };
    state.countries.MEXICO.upgrades = [0];
    state.countries.UNITED_STATES.units.planes = 200;
    queueMove(data, state, USA, "UNITED_STATES", "MEXICO", "planes", planes);
    endTurn(data, state, []);
    return { owner: state.countries.MEXICO.owner, upgrades: state.countries.MEXICO.upgrades };
  };

  const small = strike(10, 37, ["bomber"]);
  assert.ok(small.upgrades.length, "fewer than 20 planes must not flatten infrastructure");

  const large = strike(30, 37, ["bomber"]);
  assert.deepEqual(large.upgrades, [], "20+ planes flatten a neutral country's infrastructure");

  // Without Bomber the infrastructure survives any strike.
  const none = strike(30, 37, []);
  assert.ok(none.upgrades.length, "infrastructure must survive without Bomber");

  // Canada is a starred USA starting country, so it is spared entirely.
  const starred = newGame(data, { playerFaction: USA, seed: 37 });
  starred.factions[USA].cash = 5000;
  buyUnitUpgrade(starred, USA, "bomber");
  for (const [name, faction] of Object.entries(starred.factions)) if (name !== USA) faction.defeated = true;
  starred.countries.CANADA.owner = "UNION OF SOVIET SOCIALIST REPUBLICS";
  starred.countries.CANADA.units = { troops: 4000, ships: 0, planes: 0, missiles: 0, commandos: 0 };
  starred.countries.CANADA.upgrades = [0];
  starred.countries.UNITED_STATES.units.planes = 200;
  queueMove(data, starred, USA, "UNITED_STATES", "CANADA", "planes", 40);
  endTurn(data, starred, []);
  assert.deepEqual(starred.countries.CANADA.upgrades, [0], "starred country must be spared");
});
test("Explosive Device lets a defender's missiles blunt an attack, and are spent", () => {
  const USSR = "UNION OF SOVIET SOCIALIST REPUBLICS";
  // Same battle with and without the upgrade. Missiles carry no defence value,
  // so the upgrade folds their attack score into the country's defence.
  const battle = (upgrade) => {
    const state = newGame(data, { playerFaction: USA, seed: 40 });
    if (upgrade) {
      state.factions[USSR].cash = 5000;
      buyUnitUpgrade(state, USSR, upgrade);
    }
    for (const [name, faction] of Object.entries(state.factions)) if (name !== USA) faction.defeated = true;
    // Mexico adjoins the United States, so the attack is a legal ground move.
    state.countries.MEXICO.owner = USSR;
    state.countries.MEXICO.units = { troops: 400, ships: 0, planes: 0, missiles: 60, commandos: 0 };
    state.countries.UNITED_STATES.units.troops = 200;
    queueMove(data, state, USA, "UNITED_STATES", "MEXICO", "troops", 120);
    const battles = [];
    endTurn(data, state, battles);
    return { state, battle: battles.find((item) => item.country === "MEXICO") };
  };

  const plain = battle(null);
  const armed = battle("explosive-device");

  // Without the upgrade the defender's missiles are just cargo and survive intact.
  assert.equal(plain.battle.won, false, "the defended country must hold");
  assert.ok(plain.state.countries.MEXICO.units.missiles > 0, "missiles must survive without Explosive Device");

  // With it, the missiles intercept: the assault is blunted and the interceptors
  // are expended because they really do destroy the attackers.
  assert.equal(armed.battle.won, false, "the defended country must still hold");
  assert.ok(armed.battle.survivors > plain.battle.survivors,
    `Explosive Device must blunt the assault: ${armed.battle.survivors} survivors vs ${plain.battle.survivors}`);
  assert.equal(armed.state.countries.MEXICO.units.missiles, 0, "interceptors must be spent");
  assert.ok(armed.state.log.some((entry) => /Explosive devices/.test(entry.message)));
});

test("Explosive Device can turn a losing assault into a successful defence", () => {
  const USSR = "UNION OF SOVIET SOCIALIST REPUBLICS";
  const state = newGame(data, { playerFaction: USA, seed: 41 });
  state.factions[USSR].cash = 5000;
  buyUnitUpgrade(state, USSR, "explosive-device");
  for (const [name, faction] of Object.entries(state.factions)) if (name !== USA) faction.defeated = true;
  // An assault just strong enough to take the garrison bare, stopped by the missiles.
  state.countries.MEXICO.owner = USSR;
  state.countries.MEXICO.units = { troops: 400, ships: 0, planes: 0, missiles: 60, commandos: 0 };
  state.countries.UNITED_STATES.units.troops = 200;
  queueMove(data, state, USA, "UNITED_STATES", "MEXICO", "troops", 120);
  const battles = [];
  endTurn(data, state, battles);
  const result = battles.find((item) => item.country === "MEXICO");
  assert.equal(state.countries.MEXICO.owner, USSR, "the interceptors must hold the country");
  assert.equal(result.won, false);
});
test("Advanced Training Facility raises the commando cap to 300", () => {
  const state = newGame(data, { playerFaction: USA, seed: 41 });
  state.factions[USA].cash = 100000;
  const before = maxPurchasableUnits(data, state, USA, "UNITED_STATES", "commandos");
  buyUnitUpgrade(state, USA, "advanced-training-facility");
  const after = maxPurchasableUnits(data, state, USA, "UNITED_STATES", "commandos");
  assert.ok(after >= before);
  // The cap itself is enforced, not just affordability.
  state.countries.UNITED_STATES.units.commandos = 299;
  const capacity = maxPurchasableUnits(data, state, USA, "UNITED_STATES", "commandos");
  assert.equal(capacity, 1);
  assert.throws(() => queueBuy(data, state, USA, "UNITED_STATES", "commandos", 2), /commando limit is 300/);
});

test("Project Lazarus restores lost commandos to the capital", () => {
  const state = newGame(data, { playerFaction: USA, seed: 42 });
  state.factions[USA].cash = 5000;
  buyUnitUpgrade(state, USA, "project-lazarus");
  state.factions[USA].commandosLost = 12;
  state.countries.UNITED_STATES.units.commandos = 0;
  endTurn(data, state, []);
  assert.equal(state.countries.UNITED_STATES.units.commandos, 12);
  assert.ok(state.log.some((entry) => /Project Lazarus/.test(entry.message)));

  // Nothing returns while the capital is lost.
  const lost = newGame(data, { playerFaction: USA, seed: 43 });
  lost.factions[USA].cash = 5000;
  buyUnitUpgrade(lost, USA, "project-lazarus");
  lost.factions[USA].commandosLost = 12;
  lost.countries.UNITED_STATES.owner = null;
  endTurn(data, lost, []);
  assert.ok(lost.factions[USA].commandosLost >= 12);
});

test("battle resolution reports naval landings for the presentation layer", () => {
  const state = newGame(data, { playerFaction: USA, seed: 20 });
  for (const [name, faction] of Object.entries(state.factions)) if (name !== USA) faction.defeated = true;
  state.countries.ICELAND.owner = null;
  state.countries.ICELAND.units = { troops: 0, ships: 0, planes: 0, missiles: 0, commandos: 0 };
  const fleet = queueMove(data, state, USA, "UNITED_STATES", "ICELAND", "ships", 5);
  boardTroops(state, USA, fleet.id, 5);
  const battles = [];
  endTurn(data, state, battles);
  const landing = battles.find((battle) => battle.country === "ICELAND" && battle.attacker === USA);
  assert.ok(landing);
  assert.equal(landing.carriedTroops, 5);
  assert.equal(landing.won, true);
  assert.equal(state.countries.ICELAND.owner, USA);
  assert.ok(state.countries.ICELAND.units.troops > 0);
});

test("original faction upgrade bitfields expose the expected research", () => {
  const state = newGame(data, { playerFaction: USA, seed: 8 });
  assert.deepEqual(availableUpgrades(data, state, USA, "world").map((upgrade) => upgrade.id), [12, 17]);
  assert.deepEqual(availableUpgrades(data, state, USA, "country", "UNITED_STATES").map((upgrade) => upgrade.id), [0, 6, 15]);
});

test("Supply Centers are offered only where they unlock purchasing", () => {
  const state = newGame(data, { playerFaction: USA, seed: 81 });
  assert.equal(canBuyIn(data, state, USA, "UNITED_STATES"), true);
  assert.ok(!availableUpgrades(data, state, USA, "country", "UNITED_STATES").some((upgrade) => upgrade.id === 1));

  state.countries.MEXICO.owner = USA;
  assert.equal(canBuyIn(data, state, USA, "MEXICO"), false);
  assert.ok(availableUpgrades(data, state, USA, "country", "MEXICO").some((upgrade) => upgrade.id === 1));
  state.countries.MEXICO.upgrades.push(1);
  assert.equal(canBuyIn(data, state, USA, "MEXICO"), true);
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
