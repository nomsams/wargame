import { DIFFICULTIES, FACTION_META, MEDALS, OBJECTIVES, SPY_ACTIONS, UNIT_TYPES, UNIT_UPGRADES, UPGRADES, difficultyById, factionCanBuild, unitUpgradeById, upgradeById } from "./config.js";
import { allianceBetween, forceInCountry, friendlyFaction, isSupplied, newDiplomacy, SUPPLY_SURCHARGE, validDiplomacy } from "./diplomacy.js";
import { REGIONAL_SCENARIO } from "./scenario.js";

export const SAVE_VERSION = 1;

export class GameRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = "GameRuleError";
  }
}

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const factionSource = (data, name) => data.factions.find((faction) => faction.factionName === name);
const countrySource = (data, name) => data.countries.find((country) => country.name === name);
const ownsUpgrade = (state, faction, id) => state.factions[faction]?.worldUpgrades.includes(id);

function random(state) {
  let value = state.seed += 0x6d2b79f5;
  value = Math.imul(value ^ value >>> 15, value | 1);
  value ^= value + Math.imul(value ^ value >>> 7, value | 61);
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
}

function ensurePlaying(state) {
  if (state.status !== "playing") throw new GameRuleError("This campaign has already ended.");
}

function factionState(state, name) {
  const faction = state.factions[name];
  if (!faction || faction.defeated) throw new GameRuleError("That faction is no longer active.");
  return faction;
}

function countryState(state, name) {
  const country = state.countries[name];
  if (!country) throw new GameRuleError("Unknown country.");
  return country;
}

function record(state, message, kind = "info") {
  state.log.unshift({ year: state.year, message, kind });
  state.log = state.log.slice(0, 120);
}

export function newGame(data, options = {}) {
  const playerFaction = options.playerFaction || data.factions[0].factionName;
  if (!factionSource(data, playerFaction)) throw new GameRuleError("Unknown player faction.");
  const seed = Number.isInteger(options.seed) ? options.seed : Date.now() >>> 0;
  const state = {
    saveVersion: SAVE_VERSION,
    seed,
    year: 2010,
    turn: 1,
    status: "playing",
    objective: options.objective && OBJECTIVES[options.objective] ? options.objective : "domination",
    difficulty: options.difficulty || "normal",
    playerFaction,
    factions: {},
    countries: {},
    queue: [],
    intel: [],
    log: [],
    winner: null,
  };
  if (options.alliances) state.diplomacy = newDiplomacy();
  if (options.scenario === REGIONAL_SCENARIO) state.scenario = REGIONAL_SCENARIO;

  for (const faction of data.factions) {
    state.factions[faction.factionName] = {
      cash: faction.factionInitialCash,
      defeated: false,
      worldUpgrades: [],
      unitUpgrades: [],
      nukes: 0,
      commandosLost: 0,
      railGunReady: 2010,
      conquests: 0,
      medals: [],
      researchGoal: null,
      built: { troops: 0, ships: 0, planes: 0, missiles: 0, commandos: 0 },
      battlesLost: 0,
      startingCountriesLost: [],
      startingCountriesRetaken: [],
      general: {
        name: faction.factionName === playerFaction ? (options.heroName || "General") : `${FACTION_META[faction.factionName]?.code || "AI"} Command`,
        level: 1,
        inactiveUntil: 0,
      },
    };
  }

  for (const country of data.countries) {
    state.countries[country.name] = {
      owner: country.faction || null,
      units: {
        troops: country.initialTroops || 0,
        ships: country.initialShips || 0,
        planes: country.initialPlanes || 0,
        missiles: country.initialMissiles || 0,
        commandos: country.initialCommandos || 0,
      },
      upgrades: [],
      bribedBy: null,
      nukedUntil: 0,
    };
  }
  record(state, `${state.factions[playerFaction].general.name} assumes command of ${FACTION_META[playerFaction]?.short || playerFaction}.`, "good");
  return state;
}

export function validateSavedGame(value, data) {
  if (!value || typeof value !== "object" || value.saveVersion !== SAVE_VERSION) return false;
  if (!factionSource(data, value.playerFaction) || !Object.hasOwn(OBJECTIVES, value.objective)) return false;
  if (!Number.isSafeInteger(value.seed) || !Number.isSafeInteger(value.year) || !Number.isSafeInteger(value.turn)
    || !["playing", "victory", "defeat"].includes(value.status) || !DIFFICULTIES.some((difficulty) => difficulty.id === value.difficulty)) return false;
  if (!Array.isArray(value.queue) || !Array.isArray(value.intel) || !Array.isArray(value.log)) return false;
  const factionNames = new Set(data.factions.map((faction) => faction.factionName));
  const countryNames = new Set(data.countries.map((country) => country.name));
  if (!value.factions || !value.countries || Object.keys(value.factions).length !== factionNames.size
    || Object.keys(value.countries).length !== countryNames.size) return false;
  if (value.scenario !== undefined && value.scenario !== REGIONAL_SCENARIO) return false;
  if (value.diplomacy !== undefined && !validDiplomacy(value.diplomacy, factionNames, countryNames)) return false;
  if (value.lastReplay !== undefined) {
    const { year, events } = value.lastReplay || {};
    if (!Number.isSafeInteger(year) || !Array.isArray(events) || events.length > 200
      || !events.every((event) => event && ["battle", "transfer"].includes(event.type) && countryNames.has(event.from)
        && countryNames.has(event.country) && Object.hasOwn(UNIT_TYPES, event.unitType) && Number.isSafeInteger(event.quantity)
        && (event.type === "battle" ? factionNames.has(event.attacker) && (event.winner === null || factionNames.has(event.winner))
          : factionNames.has(event.faction)))) return false;
  }
  const validIntel = new Set([...factionNames].flatMap((factionName) => [...countryNames].map((countryName) => `${factionName}:${countryName}`)));
  const validFactions = data.factions.every((source) => {
    const faction = value.factions?.[source.factionName];
    const unitUpgrades = faction?.unitUpgrades ?? [];
    const worldUpgrades = faction?.worldUpgrades ?? [];
    const built = faction?.built;
    return faction && Number.isFinite(faction.cash) && faction.cash >= 0 && typeof faction.defeated === "boolean"
      && Array.isArray(faction.medals) && faction.medals.every((id) => MEDALS.some((medal) => medal.id === id))
      && Number.isSafeInteger(faction.battlesLost) && faction.battlesLost >= 0
      && (faction.researchGoal === null || unitUpgradeById(faction.researchGoal))
      && Array.isArray(faction.startingCountriesLost) && Array.isArray(faction.startingCountriesRetaken)
      && built && Object.keys(UNIT_TYPES).every((unitType) => Number.isSafeInteger(built[unitType]) && built[unitType] >= 0)
      && Array.isArray(worldUpgrades) && new Set(worldUpgrades).size === worldUpgrades.length
      && worldUpgrades.every((id) => Number.isSafeInteger(id) && upgradeById(id)?.scope === "world")
      && Array.isArray(unitUpgrades)
      && unitUpgrades.every((item) => Boolean(unitUpgradeById(item)))
      && new Set(unitUpgrades).size === unitUpgrades.length
      && new Set(unitUpgrades.map((item) => unitUpgradeById(item).unitType)).size === unitUpgrades.length
      && Number.isSafeInteger(faction.nukes) && faction.nukes >= 0
      && Number.isSafeInteger(faction.railGunReady) && Number.isSafeInteger(faction.conquests) && faction.conquests >= 0
      && faction.general && typeof faction.general.name === "string" && Number.isSafeInteger(faction.general.level)
      && Number.isSafeInteger(faction.general.inactiveUntil);
  });
  if (!validFactions) return false;
  const validCountries = data.countries.every((source) => {
    const country = value.countries?.[source.name];
    const visitors = country?.visitors;
    if (visitors !== undefined && (!value.diplomacy || !visitors || typeof visitors !== "object" || Array.isArray(visitors)
      || !Object.entries(visitors).every(([name, units]) => factionNames.has(name) && name !== country.owner
        && friendlyFaction(value, name, country.owner) && validUnits(units)))) return false;
    return country && (country.owner === null || factionNames.has(country.owner)) && Array.isArray(country.upgrades)
      && new Set(country.upgrades).size === country.upgrades.length
      && country.upgrades.every((id) => Number.isSafeInteger(id) && upgradeById(id)?.scope === "country")
      && (country.bribedBy === null || factionNames.has(country.bribedBy)) && Number.isSafeInteger(country.nukedUntil)
      && validUnits(country.units);
  });
  if (!validCountries) return false;
  const validQueue = value.queue.every((action) => {
    if (!action || typeof action.id !== "string" || !factionNames.has(action.faction) || !Number.isSafeInteger(action.quantity ?? 1)) return false;
    if (action.type === "buy") return countryNames.has(action.country) && Object.hasOwn(UNIT_TYPES, action.unitType)
      && action.quantity > 0 && Number.isFinite(action.cost) && action.cost >= 0;
    if (action.type === "move") {
      const transportMultiplier = value.factions[action.faction].unitUpgrades?.includes("sea-carrier") ? 2 : 1;
      return countryNames.has(action.from) && countryNames.has(action.to) && Object.hasOwn(UNIT_TYPES, action.unitType) && action.quantity > 0
        && (action.carriedTroops === undefined || (action.unitType === "ships" && Number.isSafeInteger(action.carriedTroops)
          && action.carriedTroops >= 0 && action.carriedTroops <= action.quantity * transportMultiplier));
    }
    if (action.type === "country-upgrade") return countryNames.has(action.country) && upgradeById(action.upgradeId)?.scope === "country"
      && Number.isFinite(action.cost) && action.cost >= 0;
    return false;
  });
  return validQueue && new Set(value.queue.map((action) => action.id)).size === value.queue.length
    && value.intel.every((item) => typeof item === "string" && validIntel.has(item))
    && value.log.every((item) => item && Number.isSafeInteger(item.year) && typeof item.message === "string");
}

function validUnits(units) {
  return Object.keys(UNIT_TYPES).every((unitType) => Number.isSafeInteger(units?.[unitType]) && units[unitType] >= 0);
}

// Campaign saves taken before the medal, difficulty, and Project Lazarus work lack
// those fields. Rather than reject a valid old campaign, fill in the new counters
// so an existing browser save or downloaded file keeps loading.
export function migrateSavedGame(value) {
  if (!value || typeof value !== "object") return value;
  if (value.difficulty && !DIFFICULTIES.some((difficulty) => difficulty.id === value.difficulty)) {
    // The five original rank tiers replace the earlier three-name scale.
    value.difficulty = { easy: "easy", normal: "normal", hard: "hard" }[value.difficulty] || "normal";
  }
  for (const faction of Object.values(value.factions || {})) {
    if (!faction || typeof faction !== "object") continue;
    faction.medals ||= [];
    faction.battlesLost ??= 0;
    faction.startingCountriesLost ||= [];
    faction.startingCountriesRetaken ||= [];
    faction.commandosLost ??= 0;
    faction.researchGoal ??= null;
    faction.built ||= Object.fromEntries(Object.keys(UNIT_TYPES).map((unitType) => [unitType, 0]));
    for (const unitType of Object.keys(UNIT_TYPES)) faction.built[unitType] ??= 0;
  }
  return value;
}
export function availableUpgrades(data, state, factionName, scope, countryName = null) {
  const faction = factionSource(data, factionName);
  if (!faction) return [];
  const quickLearner = ownsUpgrade(state, factionName, 14);
  return UPGRADES.filter((upgrade) => {
    if (upgrade.scope !== scope) return false;
    if (!factionCanBuild(faction, upgrade.id) && !(quickLearner && scope === "country" && upgrade.id >= 3 && upgrade.id <= 8)) return false;
    if (scope === "world") return !ownsUpgrade(state, factionName, upgrade.id);
    if (!countryName) return true;
    // Original starting countries already support purchases, so a Supply
    // Center there would spend money without unlocking any capability.
    if (upgrade.id === 1 && countrySource(data, countryName)?.faction === factionName) return false;
    const alreadyQueued = state.queue.some((action) => action.type === "country-upgrade"
      && action.faction === factionName && action.country === countryName && action.upgradeId === upgrade.id);
    return !state.countries[countryName].upgrades.includes(upgrade.id) && !alreadyQueued;
  });
}

function costMultiplier(source, country, unitType) {
  if (source.countryResource !== 0 || !["ships", "planes", "missiles"].includes(unitType)) return 1;
  return country.upgrades.includes(15) ? 0.5 : 0.75;
}

export function countryResourceBonus(data, state, countryName) {
  const source = countrySource(data, countryName);
  const country = countryState(state, countryName);
  if (!source) throw new GameRuleError("Unknown country.");
  const multiplier = country.upgrades.includes(15) ? 2 : 1;
  if (source.countryResource === 0) return { cash: 0, units: {}, costDiscount: multiplier === 2 ? 0.5 : 0.25 };
  if (source.countryResource === 1) return { cash: 0, units: { planes: multiplier }, costDiscount: 0 };
  if (source.countryResource === 2) return { cash: 30 * multiplier, units: {}, costDiscount: 0 };
  if (source.countryResource === 3) return { cash: 0, units: { troops: multiplier }, costDiscount: 0 };
  if (source.countryResource === 4) return { cash: 0, units: { missiles: multiplier }, costDiscount: 0 };
  if (source.countryResource === 5) return { cash: 0, units: { ships: multiplier }, costDiscount: 0 };
  return { cash: 0, units: {}, costDiscount: 0 };
}

export function unitCost(data, state, factionName, countryName, unitType) {
  const faction = factionSource(data, factionName);
  const country = countrySource(data, countryName);
  const current = countryState(state, countryName);
  const unit = UNIT_TYPES[unitType];
  if (!faction || !country || !unit) throw new GameRuleError("Unknown unit purchase.");
  const baseCost = Math.max(1, Math.round(faction[unit.costKey] * costMultiplier(country, current, unitType)));
  return isSupplied(data, state, factionName, countryName) ? baseCost : Math.ceil(baseCost * (1 + SUPPLY_SURCHARGE));
}

export function canBuyIn(data, state, factionName, countryName) {
  const source = countrySource(data, countryName);
  const country = countryState(state, countryName);
  return country.owner === factionName && country.nukedUntil <= state.year
    && (source.faction === factionName || country.upgrades.includes(1) || ownsUpgrade(state, factionName, 19));
}

function positiveQuantity(quantity) {
  const amount = Number(quantity);
  if (!Number.isSafeInteger(amount) || amount < 1) throw new GameRuleError("Choose a positive whole number of units.");
  return amount;
}

// Advanced Training Facility raises the cap to 300; Mechwarrior keeps the
// original 100 -> 300 step for saved campaigns bought before it existed.
function commandoCap(state, factionName) {
  if (hasUnitUpgrade(state, factionName, "commandos", "commandoCap")) return 300;
  return ownsUpgrade(state, factionName, 16) ? 300 : 100;
}

function queuedCommandos(state, factionName) {
  return state.queue.filter((action) => action.type === "buy" && action.faction === factionName && action.unitType === "commandos")
    .reduce((sum, action) => sum + action.quantity, 0);
}

export function maxPurchasableUnits(data, state, factionName, countryName, unitType) {
  const faction = state.factions[factionName];
  const source = countrySource(data, countryName);
  if (!faction || !source || !UNIT_TYPES[unitType] || !canBuyIn(data, state, factionName, countryName)) return 0;
  if (unitType === "ships" && !source.hasSeaBorder) return 0;
  let capacity = Math.floor(faction.cash / unitCost(data, state, factionName, countryName, unitType));
  if (unitType === "commandos") {
    const owned = totalCommandos(state, factionName);
    const cap = commandoCap(state, factionName);
    capacity = Math.min(capacity, cap - owned - queuedCommandos(state, factionName));
  }
  return Math.max(0, capacity);
}

export function queueBuy(data, state, factionName, countryName, unitType, quantity) {
  ensurePlaying(state);
  const faction = factionState(state, factionName);
  if (!UNIT_TYPES[unitType]) throw new GameRuleError("Choose a valid unit type.");
  const amount = positiveQuantity(quantity);
  if (!canBuyIn(data, state, factionName, countryName)) throw new GameRuleError("Units can only be bought in a starting country or Supply Center.");
  const source = countrySource(data, countryName);
  if (unitType === "ships" && !source.hasSeaBorder) throw new GameRuleError("Ships require a sea border.");
  const currentCommandos = totalCommandos(state, factionName);
  const cap = commandoCap(state, factionName);
  if (unitType === "commandos" && currentCommandos + queuedCommandos(state, factionName) + amount > cap) throw new GameRuleError(`Your commando limit is ${cap}.`);
  const total = unitCost(data, state, factionName, countryName, unitType) * amount;
  if (faction.cash < total) throw new GameRuleError("Insufficient funds.");
  faction.cash -= total;
  const action = { id: cryptoId(state), type: "buy", faction: factionName, country: countryName, unitType, quantity: amount, cost: total };
  state.queue.push(action);
  record(state, `${amount} ${UNIT_TYPES[unitType].label.toLowerCase()} queued in ${displayCountry(countryName)}.`);
  return action;
}

function committedUnits(state, factionName, countryName, unitType) {
  const moved = state.queue.filter((action) => action.type === "move" && action.faction === factionName && action.from === countryName && action.unitType === unitType)
    .reduce((sum, action) => sum + action.quantity, 0);
  const boarded = unitType === "troops" ? state.queue.filter((action) => action.type === "move" && action.faction === factionName && action.from === countryName && action.unitType === "ships")
    .reduce((sum, action) => sum + (action.carriedTroops || 0), 0) : 0;
  return moved + boarded;
}

export function availableUnitCount(state, factionName, countryName, unitType) {
  const country = state.countries[countryName];
  if (!country?.units || !UNIT_TYPES[unitType]) return 0;
  const force = forceInCountry(country, factionName);
  return Math.max(0, (force?.[unitType] || 0) - committedUnits(state, factionName, countryName, unitType));
}

export function navalTransportMultiplier(state, factionName) {
  return state.factions[factionName]?.unitUpgrades?.includes("sea-carrier") ? 2 : 1;
}

export function availableBoardingCapacity(state, factionName, shipActionId) {
  const action = state.queue.find((item) => item.id === shipActionId && item.type === "move" && item.unitType === "ships" && item.faction === factionName);
  if (!action) return 0;
  const shipSpace = action.quantity * navalTransportMultiplier(state, factionName) - (action.carriedTroops || 0);
  return Math.max(0, Math.min(shipSpace, availableUnitCount(state, factionName, action.from, "troops")));
}

export function boardTroops(state, factionName, shipActionId, quantity) {
  ensurePlaying(state);
  factionState(state, factionName);
  const action = state.queue.find((item) => item.id === shipActionId && item.type === "move" && item.unitType === "ships" && item.faction === factionName);
  if (!action) throw new GameRuleError("Queue a ship movement before boarding troops.");
  const amount = positiveQuantity(quantity);
  if (amount > availableBoardingCapacity(state, factionName, shipActionId)) throw new GameRuleError("Those ships do not have enough free troop capacity.");
  action.carriedTroops = (action.carriedTroops || 0) + amount;
  record(state, `${amount} troops boarded ships sailing from ${displayCountry(action.from)} to ${displayCountry(action.to)}.`);
  return action;
}

export function availableUnitUpgrades(state, factionName) {
  const faction = state.factions[factionName];
  if (!faction) return [];
  const owned = new Set(faction.unitUpgrades || []);
  const takenTypes = new Set([...owned].map((id) => unitUpgradeById(id)?.unitType).filter(Boolean));
  return UNIT_UPGRADES.filter((upgrade) => !owned.has(upgrade.id) && !takenTypes.has(upgrade.unitType));
}

export function buyUnitUpgrade(state, factionName, upgradeId) {
  ensurePlaying(state);
  const faction = factionState(state, factionName);
  const upgrade = unitUpgradeById(upgradeId);
  if (!upgrade) throw new GameRuleError("Unknown unit upgrade.");
  faction.unitUpgrades ||= [];
  const available = availableUnitUpgrades(state, factionName);
  if (!available.some((item) => item.id === upgrade.id)) {
    throw new GameRuleError(faction.unitUpgrades.includes(upgrade.id)
      ? `${upgrade.title} is already installed.`
      : `A ${UNIT_TYPES[upgrade.unitType].label.toLowerCase()} upgrade has already been selected.`);
  }
  if (faction.cash < upgrade.cost) throw new GameRuleError("Insufficient funds.");
  faction.cash -= upgrade.cost;
  faction.unitUpgrades.push(upgrade.id);
  record(state, `${upgrade.title} research completed.`, "good");
  return upgrade;
}

// Retained for existing callers and saved campaigns: the naval branch is now
// one of the five unit specializations handled by buyUnitUpgrade.
export function chooseNavalDoctrine(state, factionName, doctrine) {
  return buyUnitUpgrade(state, factionName, doctrine);
}

export function canReach(data, state, factionName, fromName, toName, unitType) {
  if (fromName === toName) return false;
  const from = countrySource(data, fromName);
  const to = countrySource(data, toName);
  if (!from || !to) return false;
  if (["planes", "missiles", "commandos"].includes(unitType)) return true;
  if (unitType === "ships") return Boolean(from.hasSeaBorder && to.hasSeaBorder);
  if (from.adjoiningCountries.includes(toName)) return true;
  return unitType === "troops" && ownsUpgrade(state, factionName, 7)
    && state.countries[fromName].owner === factionName && state.countries[toName].owner === factionName;
}

export function queueMove(data, state, factionName, fromName, toName, unitType, quantity) {
  ensurePlaying(state);
  factionState(state, factionName);
  const from = countryState(state, fromName);
  if (!forceInCountry(from, factionName)) throw new GameRuleError("You have no forces in the source country.");
  if (!UNIT_TYPES[unitType]) throw new GameRuleError("Choose a valid unit type.");
  const amount = positiveQuantity(quantity);
  if (!canReach(data, state, factionName, fromName, toName, unitType)) throw new GameRuleError("That unit cannot reach the target country.");
  if (availableUnitCount(state, factionName, fromName, unitType) < amount) throw new GameRuleError("Not enough uncommitted units in the source country.");
  const action = { id: cryptoId(state), type: "move", faction: factionName, from: fromName, to: toName, unitType, quantity: amount };
  if (unitType === "ships") action.carriedTroops = 0;
  state.queue.push(action);
  record(state, `${amount} ${UNIT_TYPES[unitType].label.toLowerCase()} ordered from ${displayCountry(fromName)} to ${displayCountry(toName)}.`);
  return action;
}

export function queueUpgrade(data, state, factionName, countryName, upgradeId) {
  ensurePlaying(state);
  const faction = factionState(state, factionName);
  const country = countryState(state, countryName);
  const upgrade = upgradeById(upgradeId);
  if (!upgrade || upgrade.scope !== "country") throw new GameRuleError("Unknown country upgrade.");
  if (country.owner !== factionName) throw new GameRuleError("You do not control that country.");
  if (!availableUpgrades(data, state, factionName, "country", countryName).some((item) => item.id === upgrade.id)) throw new GameRuleError("That upgrade is unavailable or already built.");
  if (faction.cash < upgrade.cost) throw new GameRuleError("Insufficient funds.");
  faction.cash -= upgrade.cost;
  const action = { id: cryptoId(state), type: "country-upgrade", faction: factionName, country: countryName, upgradeId: upgrade.id, cost: upgrade.cost };
  state.queue.push(action);
  record(state, `${upgrade.title} queued in ${displayCountry(countryName)}.`);
  return action;
}

export function buyWorldUpgrade(data, state, factionName, upgradeId) {
  ensurePlaying(state);
  const faction = factionState(state, factionName);
  const upgrade = upgradeById(upgradeId);
  if (!upgrade || upgrade.scope !== "world") throw new GameRuleError("Unknown world upgrade.");
  if (!availableUpgrades(data, state, factionName, "world").some((item) => item.id === upgrade.id)) throw new GameRuleError("That upgrade is unavailable or already built.");
  if (faction.cash < upgrade.cost) throw new GameRuleError("Insufficient funds.");
  faction.cash -= upgrade.cost;
  faction.worldUpgrades.push(upgrade.id);
  if (upgrade.id === 11) for (const country of Object.values(state.countries)) if (country.owner === factionName) country.units.troops *= 2;
  if (upgrade.id === 12) faction.nukes = 2;
  if (upgrade.id === 19) {
    const countryIds = availableUpgrades(data, state, factionName, "country").map((item) => item.id);
    for (const country of Object.values(state.countries)) if (country.owner === factionName) country.upgrades = [...new Set([...country.upgrades, ...countryIds])];
  }
  record(state, `${FACTION_META[factionName]?.short || factionName} completed ${upgrade.title}.`, "good");
}

export function cancelAction(state, actionId) {
  const index = state.queue.findIndex((action) => action.id === actionId && action.faction === state.playerFaction);
  if (index < 0) throw new GameRuleError("That action can no longer be cancelled.");
  const [action] = state.queue.splice(index, 1);
  if (action.cost) state.factions[action.faction].cash += action.cost;
  record(state, "Queued action cancelled.");
}

export function diplomacyOrder(data, state, actor, kind, partner, target = null) {
  ensurePlaying(state);
  factionState(state, actor);
  factionState(state, partner);
  const diplomacy = state.diplomacy;
  if (!diplomacy || actor === partner || !factionSource(data, partner)) throw new GameRuleError("Choose a different active faction in Alliance mode.");
  const pact = allianceBetween(state, actor, partner);
  const incoming = diplomacy.offers.find(({ from, to }) => from === partner && to === actor);
  if (kind === "propose" && !pact && !diplomacy.offers.some(({ from, to }) => from === actor && to === partner)) {
    diplomacy.offers.push({ from: actor, to: partner });
    record(state, `${FACTION_META[actor].short} offered an alliance to ${FACTION_META[partner].short}.`);
  } else if (kind === "accept" && incoming && !pact) {
    diplomacy.offers = diplomacy.offers.filter(({ from, to }) => !(from === actor && to === partner || from === partner && to === actor));
    diplomacy.alliances.push({ members: [actor, partner], locked: false });
    record(state, `${FACTION_META[actor].short} and ${FACTION_META[partner].short} formed an alliance.`, "good");
  } else if (kind === "decline" && incoming) {
    diplomacy.offers = diplomacy.offers.filter((offer) => offer !== incoming);
  } else if (kind === "end" && pact && !pact.locked) {
    diplomacy.alliances = diplomacy.alliances.filter((item) => item !== pact);
    diplomacy.requests = diplomacy.requests.filter(({ from, to }) => !(from === actor && to === partner || from === partner && to === actor));
    for (const [countryName, country] of Object.entries(state.countries)) {
      if (country.owner !== actor && country.owner !== partner) continue;
      const returningFaction = country.owner === actor ? partner : actor;
      const returning = country.visitors?.[returningFaction];
      if (!returning) continue;
      const home = factionSource(data, returningFaction).capitalCountry;
      const safeHome = state.countries[home].owner === returningFaction
        ? state.countries[home] : Object.values(state.countries).find((place) => place.owner === returningFaction);
      if (safeHome) addForce(safeHome.units, returning);
      delete country.visitors[returningFaction];
      state.queue = state.queue.filter((order) => !(order.type === "move" && order.from === countryName && order.faction === returningFaction));
    }
    record(state, `${FACTION_META[actor].short} ended its alliance with ${FACTION_META[partner].short}.`);
  } else if (kind === "support" && pact && Object.hasOwn(state.countries, target)) {
    const country = state.countries[target];
    if (country.owner && friendlyFaction(state, actor, country.owner) !== friendlyFaction(state, partner, country.owner)) {
      throw new GameRuleError("You and your partner have different treaties with that country.");
    }
    if (country.nukedUntil > state.year) throw new GameRuleError("That country is temporarily uninhabitable.");
    diplomacy.requests = diplomacy.requests.filter(({ from, to }) => from !== actor || to !== partner);
    diplomacy.requests.push({ from: actor, to: partner, target, expires: state.year + 1 });
    record(state, `${FACTION_META[actor].short} asked ${FACTION_META[partner].short} for support in ${displayCountry(target)}.`);
  } else {
    throw new GameRuleError("That diplomatic action is unavailable.");
  }
}

export function useSpyAction(data, state, factionName, actionName, targetName) {
  ensurePlaying(state);
  const faction = factionState(state, factionName);
  const action = SPY_ACTIONS[actionName];
  const target = countryState(state, targetName);
  const source = countrySource(data, targetName);
  if (!action || friendlyFaction(state, factionName, target.owner) || !target.owner) throw new GameRuleError("Choose an enemy-controlled country.");
  if (source.name === factionSource(data, target.owner)?.capitalCountry) throw new GameRuleError("Capital countries are immune to spy actions.");
  if (target.upgrades.includes(3)) throw new GameRuleError("Spezial Polizei prevented the operation.");
  if (action.upgrade && !ownsUpgrade(state, factionName, action.upgrade)) throw new GameRuleError(`${action.title} requires 00 Agents.`);
  const cost = ownsUpgrade(state, factionName, 13) ? Math.ceil(action.cost / 2) : action.cost;
  if (faction.cash < cost) throw new GameRuleError("Insufficient funds.");
  faction.cash -= cost;
  if (actionName === "intelligence") state.intel.push(`${factionName}:${targetName}`);
  if (actionName === "bribery") target.bribedBy = factionName;
  if (actionName === "hit") state.factions[target.owner].general.inactiveUntil = state.year + 1;
  record(state, `${action.title} operation completed in ${displayCountry(targetName)}.`, "good");
}

export function useStrategicWeapon(state, factionName, kind, targetName) {
  ensurePlaying(state);
  const faction = factionState(state, factionName);
  const target = countryState(state, targetName);
  if (!target.owner || friendlyFaction(state, factionName, target.owner)) throw new GameRuleError("Choose an enemy-controlled country.");
  if (kind === "nuke") {
    if (!ownsUpgrade(state, factionName, 12) || faction.nukes < 1) throw new GameRuleError("No nuclear warheads remain.");
    faction.nukes -= 1;
    target.units = emptyUnits();
    delete target.visitors;
    target.owner = null;
    target.upgrades = [];
    target.nukedUntil = state.year + 2;
    record(state, `${displayCountry(targetName)} was destroyed by a nuclear strike.`, "bad");
  } else if (kind === "railgun") {
    if (!ownsUpgrade(state, factionName, 17) || faction.railGunReady > state.year) throw new GameRuleError("Rail Gun is not ready.");
    for (const unit of Object.keys(UNIT_TYPES)) target.units[unit] = Math.floor(target.units[unit] * 0.15);
    for (const force of Object.values(target.visitors || {})) for (const unit of Object.keys(UNIT_TYPES)) force[unit] = Math.floor(force[unit] * 0.15);
    faction.railGunReady = state.year + 3;
    record(state, `Rail Gun devastated ${displayCountry(targetName)}.`, "bad");
  } else throw new GameRuleError("Unknown strategic weapon.");
  updateDefeatedFactions(state);
  checkVictory(state);
}

function cryptoId(state) {
  return `${state.turn}-${state.queue.length}-${Math.floor(random(state) * 1e9).toString(36)}`;
}

function generalMultiplier(state, factionName) {
  const general = state.factions[factionName].general;
  return general.inactiveUntil >= state.year ? 1 : 1 + Math.min(4, general.level) * 0.03;
}

function unitUpgradeValue(state, factionName, unitType, effect) {
  const id = (state.factions[factionName]?.unitUpgrades || [])
    .map((item) => unitUpgradeById(item))
    .find((upgrade) => upgrade?.unitType === unitType && upgrade.effect === effect);
  return id ? id.value : null;
}

function hasUnitUpgrade(state, factionName, unitType, effect) {
  return unitUpgradeValue(state, factionName, unitType, effect) !== null;
}
function attackMultiplier(state, factionName, unitType) {
  let multiplier = generalMultiplier(state, factionName);
  if (ownsUpgrade(state, factionName, 10) && ["troops", "commandos"].includes(unitType)) multiplier *= 1.5;
  return multiplier * (unitUpgradeValue(state, factionName, unitType, "attack")
    ?? unitUpgradeValue(state, factionName, unitType, "attackDefense") ?? 1);
}

function unitDefenseMultiplier(state, factionName, unitType) {
  return unitUpgradeValue(state, factionName, unitType, "defense")
    ?? unitUpgradeValue(state, factionName, unitType, "attackDefense") ?? 1;
}

function defenseMultiplier(state, countryName, unitType) {
  const country = state.countries[countryName];
  let multiplier = generalMultiplier(state, country.owner);
  if (country.upgrades.includes(0)) multiplier *= 1.5;
  if (country.upgrades.includes(4)) multiplier *= 1.5;
  if (country.upgrades.includes(8)) multiplier *= 1.25;
  if (country.bribedBy) multiplier *= 0.5;
  if (ownsUpgrade(state, country.owner, 10) && ["troops", "commandos"].includes(unitType)) multiplier *= 0.75;
  return multiplier * unitDefenseMultiplier(state, country.owner, unitType);
}

export function countryDefense(data, state, countryName) {
  const country = countryState(state, countryName);
  if (!country.owner) return country.units.troops;
  const faction = factionSource(data, country.owner);
  const ownerScore = Object.entries(UNIT_TYPES).reduce((total, [unitType, unit]) => total + country.units[unitType] * faction[unit.defenseKey] * defenseMultiplier(state, countryName, unitType), 0);
  return Object.entries(country.visitors || {}).reduce((total, [name, force]) => {
    const partner = factionSource(data, name);
    return total + Object.entries(UNIT_TYPES).reduce((sum, [unitType, unit]) =>
      sum + force[unitType] * partner[unit.defenseKey] * unitDefenseMultiplier(state, name, unitType), 0);
  }, ownerScore);
}

function addForce(destination, incoming) {
  for (const unit of Object.keys(UNIT_TYPES)) destination[unit] += incoming[unit];
}

function stationForce(country, faction, troops) {
  if (country.owner === faction) addForce(country.units, troops);
  else {
    country.visitors ??= {};
    country.visitors[faction] ??= emptyUnits();
    addForce(country.visitors[faction], troops);
  }
}

function embarkOrder(state, action) {
  const force = forceInCountry(state.countries[action.from], action.faction);
  const aboard = action.carriedTroops || 0;
  if (!force || force[action.unitType] < action.quantity || force.troops < aboard) return null;
  force[action.unitType] -= action.quantity;
  force.troops -= aboard;
  const departure = emptyUnits();
  departure[action.unitType] = action.quantity;
  departure.troops += aboard;
  return departure;
}

function totalUnits(force) {
  return Object.values(force).reduce((sum, count) => sum + count, 0);
}

function resolveCoalition(data, state, actions, battleEvents, replay) {
  const destination = actions[0].to;
  const country = state.countries[destination];
  if (country.nukedUntil > state.year) return;
  const defender = country.owner;
  const defendingAllies = Object.entries(country.visitors || {}).filter(([, force]) => totalUnits(force) > 0).map(([name]) => name);
  const defendersBefore = { ...country.units };
  const participants = actions.flatMap((action) => {
    const force = embarkOrder(state, action);
    if (!force) {
      record(state, `Move from ${displayCountry(action.from)} failed because the source force changed.`, "bad");
      return [];
    }
    const faction = factionSource(data, action.faction);
    const power = Object.entries(UNIT_TYPES).reduce((sum, [unitType, type]) =>
      sum + force[unitType] * faction[type.attackKey] * attackMultiplier(state, action.faction, unitType), 0);
    return [{ action, force, power }];
  });
  if (!participants.length) return;
  const attack = participants.reduce((sum, { power }) => sum + power, 0) * (0.86 + random(state) * 0.28);
  const defense = Math.max(1, countryDefense(data, state, destination)) * (0.86 + random(state) * 0.28);
  const interceptor = hasUnitUpgrade(state, defender, "missiles", "support")
    ? country.units.missiles * factionSource(data, defender).missilesAttackStrength * attackMultiplier(state, defender, "missiles") : 0;
  const defendedScore = defense + interceptor;
  const won = attack > defendedScore;
  const baseLoss = clamp((won ? defendedScore : attack) / Math.max(1, attack + defendedScore) * 1.55, 0.08, won ? 0.78 : 0.95);
  const surviving = new Map();
  for (const { action, force } of participants) {
    const loss = action.unitType === "planes" ? baseLoss * (unitUpgradeValue(state, action.faction, "planes", "stealth") || 1) : baseLoss;
    const survivors = Object.fromEntries(Object.entries(force).map(([type, count]) => [
      type, Math.max(won && count ? 1 : 0, count - Math.ceil(count * loss)),
    ]));
    state.factions[action.faction].commandosLost += force.commandos - survivors.commandos;
    if (!won) {
      state.factions[action.faction].battlesLost += 1;
      addForce(forceInCountry(state.countries[action.from], action.faction), survivors);
    }
    if (!surviving.has(action.faction)) surviving.set(action.faction, emptyUnits());
    addForce(surviving.get(action.faction), survivors);
  }
  if (won) {
    const ranked = [...surviving].sort((a, b) => b[1].troops - a[1].troops || totalUnits(b[1]) - totalUnits(a[1])
      || (a[0] < b[0] ? -1 : 1));
    const winner = ranked[0][0];
    for (const [name, force] of [[defender, country.units], ...Object.entries(country.visitors || {})]) {
      if (name) state.factions[name].commandosLost += force.commandos;
    }
    country.owner = winner;
    country.units = ranked[0][1];
    if (ownsUpgrade(state, winner, 18)) country.units.troops += Math.ceil(defendersBefore.troops * 0.5);
    country.visitors = Object.fromEntries(ranked.slice(1));
    country.upgrades = ownsUpgrade(state, winner, 19) ? [0, 1, 15] : [];
    state.factions[winner].conquests += 1;
    state.factions[winner].general.level = 1 + Math.min(3, Math.floor(state.factions[winner].conquests / 8));
    const originalOwner = countrySource(data, destination)?.faction;
    if (defender && originalOwner === defender && !state.factions[defender].startingCountriesLost.includes(destination)) state.factions[defender].startingCountriesLost.push(destination);
    if (originalOwner === winner && state.factions[winner].startingCountriesLost.includes(destination)
      && !state.factions[winner].startingCountriesRetaken.includes(destination)) state.factions[winner].startingCountriesRetaken.push(destination);
    record(state, `${FACTION_META[winner].short} took control of ${displayCountry(destination)}.`, "good");
  } else {
    const attrition = clamp(attack / defendedScore * 0.55, 0.05, 0.55);
    for (const [name, force] of [[defender, country.units], ...Object.entries(country.visitors || {})]) {
      const before = force.commandos;
      for (const type of Object.keys(force)) force[type] = Math.round(force[type] * (1 - attrition));
      if (name) state.factions[name].commandosLost += before - force.commandos;
    }
    if (interceptor) country.units.missiles = 0;
    if (participants.some(({ action }) => action.unitType === "planes" && action.quantity >= 20
      && hasUnitUpgrade(state, action.faction, "planes", "bomber")) && !countrySource(data, destination)?.faction) country.upgrades = [];
    record(state, `The attack on ${displayCountry(destination)} was repelled.`);
  }
  for (const { action } of participants) {
    const battle = {
      type: "battle", country: destination, from: action.from, attacker: action.faction, defender, winner: country.owner,
      unitType: action.unitType, quantity: action.quantity, carriedTroops: action.carriedTroops || 0, won,
      defendingAllies,
      attackScore: Math.round(attack), defenseScore: Math.round(defendedScore), defendersBefore, defendersAfter: { ...country.units },
    };
    battleEvents.push(battle);
    replay.push(battle);
  }
}

function resolveMove(data, state, action, battleEvents) {
  const from = state.countries[action.from];
  const to = state.countries[action.to];
  const carriedTroops = action.unitType === "ships" ? (action.carriedTroops || 0) : 0;
  if (!from || !to || from.owner !== action.faction || from.units[action.unitType] < action.quantity || from.units.troops < carriedTroops) {
    record(state, `Move from ${displayCountry(action.from)} failed because the source force changed.`, "bad");
    return;
  }
  from.units[action.unitType] -= action.quantity;
  from.units.troops -= carriedTroops;
  if (to.owner === action.faction) {
    to.units[action.unitType] += action.quantity;
    to.units.troops += carriedTroops;
    return;
  }
  if (to.nukedUntil > state.year) {
    record(state, `${displayCountry(action.to)} is still uninhabitable.`, "bad");
    from.units[action.unitType] += action.quantity;
    from.units.troops += carriedTroops;
    return;
  }

  const faction = factionSource(data, action.faction);
  const defender = to.owner;
  const defendersBefore = { ...to.units };
  const attack = (action.quantity * faction[UNIT_TYPES[action.unitType].attackKey] * attackMultiplier(state, action.faction, action.unitType)
    + carriedTroops * faction.troopsAttackStrength * attackMultiplier(state, action.faction, "troops")) * (0.86 + random(state) * 0.28);
  const defense = Math.max(1, countryDefense(data, state, action.to)) * (0.86 + random(state) * 0.28);
  // Explosive Device: "Your missiles can apply their attack power if they are in one
  // of your country under attack." Missiles carry no defence value, so their attack
  // score is folded into the country's defence for this contest, which blunts the
  // assault in both directions. Only a defending faction can field them.
  const defenderFaction = defender ? factionSource(data, defender) : null;
  const interceptorMissiles = hasUnitUpgrade(state, defender, "missiles", "support") && defenderFaction
    ? to.units.missiles * defenderFaction.missilesAttackStrength * attackMultiplier(state, defender, "missiles") : 0;
  const defendedScore = defense + interceptorMissiles;
  const won = attack > defendedScore;
  let lossRatio = clamp((won ? defendedScore : attack) / Math.max(1, attack + defendedScore) * 1.55, 0.08, won ? 0.78 : 0.95);
  const stealth = unitUpgradeValue(state, action.faction, "planes", "stealth");
  if (stealth && action.unitType === "planes") lossRatio *= stealth;
  const survivors = Math.max(won ? 1 : 0, action.quantity - Math.ceil(action.quantity * lossRatio));
  const troopSurvivors = Math.max(won && carriedTroops ? 1 : 0, carriedTroops - Math.ceil(carriedTroops * lossRatio));
  if (won) {
    const defeatedTroops = to.units.troops;
    to.owner = action.faction;
    to.units = emptyUnits();
    to.units[action.unitType] = survivors;
    to.units.troops += troopSurvivors;
    if (ownsUpgrade(state, action.faction, 18)) to.units.troops += Math.ceil(defeatedTroops * 0.5);
    if (ownsUpgrade(state, action.faction, 19)) to.upgrades = [0, 1, 15];
    else to.upgrades = [];

    state.factions[action.faction].conquests += 1;
    state.factions[action.faction].general.level = 1 + Math.min(3, Math.floor(state.factions[action.faction].conquests / 8));
    record(state, `${FACTION_META[action.faction]?.code || action.faction} conquered ${displayCountry(action.to)}${defender ? ` from ${FACTION_META[defender]?.code || defender}` : ""}.`, "good");
  } else {
    const attrition = clamp((attack - defendedScore) / Math.max(1, defendedScore) * 0.65, 0.05, 0.85);
    const before = { ...to.units };
    for (const unitType of Object.keys(UNIT_TYPES)) to.units[unitType] = Math.max(0, Math.round(to.units[unitType] * (1 - attrition)));
    if (interceptorMissiles > 0) {
      const killed = Object.keys(UNIT_TYPES).some((unitType) => before[unitType] > 0 && to.units[unitType] < before[unitType]);
      to.units.missiles = killed ? 0 : before.missiles;
      if (killed) record(state, `Explosive devices in ${displayCountry(action.to)} destroyed attacking units.`, "good");
    }
    if (defender && before.commandos > to.units.commandos) {
      state.factions[defender].commandosLost = (state.factions[defender].commandosLost || 0) + (before.commandos - to.units.commandos);
    }
    // Bomber: a large enough air strike flattens the infrastructure it failed
    // to capture. Starred starting countries are explicitly spared.
    if (hasUnitUpgrade(state, action.faction, "planes", "bomber") && action.unitType === "planes" && action.quantity >= 20
      && to.upgrades.length && !countrySource(data, action.to)?.faction) {
      to.upgrades = [];
      record(state, `Bombers flattened the infrastructure of ${displayCountry(action.to)}.`, "good");
    }
    record(state, `${FACTION_META[action.faction]?.code || action.faction} failed to take ${displayCountry(action.to)}.`, "bad");
  }
  if (action.unitType === "commandos") {
    state.factions[action.faction].commandosLost = (state.factions[action.faction].commandosLost || 0) + (action.quantity - survivors);
  }
  if (!won) state.factions[action.faction].battlesLost = (state.factions[action.faction].battlesLost || 0) + 1;
  // A starting country only changes hands when the attack succeeds, so the
  // defender is the one that lost it. Recording it on a repelled attack would
  // never fire and left the Defence medal unreachable.
  if (won && defender && countrySource(data, action.to)?.faction === defender) {
    const faction = state.factions[defender];
    if (faction && !faction.startingCountriesLost.includes(action.to)) faction.startingCountriesLost.push(action.to);
  }
  if (won && defender && countrySource(data, action.to)?.faction === action.faction) {
    const faction = state.factions[action.faction];
    if (faction && faction.startingCountriesLost.includes(action.to) && !faction.startingCountriesRetaken.includes(action.to)) {
      faction.startingCountriesRetaken.push(action.to);
    }
  }
  battleEvents.push({
    type: "battle",
    country: action.to,
    from: action.from,
    attacker: action.faction,
    defender,
    winner: to.owner,
    unitType: action.unitType,
    quantity: action.quantity,
    carriedTroops,
    won,
    survivors,
    troopSurvivors,
    attackScore: Math.round(attack),
    defenseScore: Math.round(defense),
    defendersBefore,
    defendersAfter: { ...to.units },
  });
}

function resolveAllianceMoves(data, state, moves, battleEvents, replay) {
  const hostile = [];
  const transfer = (action) => {
    const destination = state.countries[action.to];
    if (destination.nukedUntil > state.year) return;
    const force = embarkOrder(state, action);
    if (!force) return;
    stationForce(destination, action.faction, force);
    replay.push({ ...action, type: "transfer", country: action.to });
  };
  for (const action of moves) {
    if (friendlyFaction(state, action.faction, state.countries[action.to].owner)) transfer(action);
    else hostile.push(action);
  }
  while (hostile.length) {
    const lead = hostile.shift();
    if (friendlyFaction(state, lead.faction, state.countries[lead.to].owner)) {
      transfer(lead);
      continue;
    }
    const group = [lead];
    for (let i = 0; i < hostile.length;) {
      const order = hostile[i];
      if (order.to === lead.to && group.every(({ faction }) => friendlyFaction(state, faction, order.faction))
        && !friendlyFaction(state, order.faction, state.countries[lead.to].owner)) {
        group.push(...hostile.splice(i, 1));
      } else i += 1;
    }
    resolveCoalition(data, state, group, battleEvents, replay);
  }
}

function resolveQueue(data, state, battleEvents, replay) {
  const ordering = { "country-upgrade": 0, buy: 1, move: 2 };
  const queue = [...state.queue].sort((a, b) => ordering[a.type] - ordering[b.type]);
  state.queue = [];
  for (const action of queue) {
    if (action.type === "buy" && state.countries[action.country]?.owner === action.faction) {
      state.countries[action.country].units[action.unitType] += action.quantity;
      state.factions[action.faction].built[action.unitType] += action.quantity;
    }
    if (action.type === "country-upgrade" && state.countries[action.country]?.owner === action.faction) state.countries[action.country].upgrades.push(action.upgradeId);
    if (!state.diplomacy && action.type === "move") {
      const index = battleEvents.length;
      const fromOwner = state.countries[action.from].owner;
      const toOwner = state.countries[action.to].owner;
      const before = state.countries[action.from].units[action.unitType];
      resolveMove(data, state, action, battleEvents);
      if (battleEvents.length > index) replay.push(battleEvents[index]);
      else if (fromOwner === action.faction && toOwner === action.faction && state.countries[action.from].units[action.unitType] < before) {
        replay.push({ ...action, type: "transfer", country: action.to });
      }
    }
  }
  if (state.diplomacy) resolveAllianceMoves(data, state, queue.filter(({ type }) => type === "move"), battleEvents, replay);
}

// Each branch has a different effect, so a faction should not simply buy the
// cheapest one forever. A troop branch is taken first because it helps in every
// early fight; afterwards the AI alternates toward the branch its army can
// actually use, and only falls back to the cheapest when nothing else is
// affordable.
// Each faction leans toward a different arm, so the rivals field visibly
// different armies instead of five identical research trees.
const AI_RESEARCH_BIAS = {
  "UNITED STATES OF AMERICA": { planes: 0.30, troops: 0.10 },
  "EUROPEAN DEMOCRATIC FEDERATION": { ships: 0.26, commandos: 0.16 },
  "THE GREAT REICH": { troops: 0.26, missiles: 0.12 },
  "UNION OF SOVIET SOCIALIST REPUBLICS": { missiles: 0.30, troops: 0.12 },
  "THE GREAT KHALIFA": { troops: 0.24, commandos: 0.20 },
  "EMPIRE OF THE SUN": { planes: 0.22, ships: 0.18, commandos: 0.12 },
};
function aiResearchTarget(data, state, factionName) {
  const faction = state.factions[factionName];
  const open = availableUnitUpgrades(state, factionName);
  if (!open.length) return null;
  const remembered = open.find((upgrade) => upgrade.id === faction.researchGoal);
  if (remembered) return remembered;
  const totals = { troops: 0, ships: 0, planes: 0, missiles: 0, commandos: 0 };
  for (const country of data.countries) {
    if (state.countries[country.name].owner !== factionName) continue;
    for (const unitType of Object.keys(UNIT_TYPES)) totals[unitType] += state.countries[country.name].units[unitType];
  }
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  // A stable per-faction bias keeps the five rivals from all drafting an
  // identical tree, while the army composition still decides the first pick.
  const bias = AI_RESEARCH_BIAS[factionName] || {};
  const weight = (upgrade) => totals[upgrade.unitType] / Math.max(1, total)
    + (bias[upgrade.unitType] || 0)
    + (upgrade.unitType === "troops" ? 0.34 : 0);
  const chosen = open.sort((a, b) => weight(b) - weight(a) || a.cost - b.cost)[0];
  faction.researchGoal = chosen.id;
  return chosen;
}
function aiPlan(data, state, factionName) {
  const faction = state.factions[factionName];
  if (faction.defeated) return;
  const owned = data.countries.filter((country) => state.countries[country.name].owner === factionName);
  if (!owned.length) return;
  const sourceFaction = factionSource(data, factionName);
  // Rival factions research their unit specializations too, otherwise the whole
  // research tree only ever benefits the player. The cheapest open branch is taken
  // first so a faction that cannot afford everything still improves. This runs
  // before this turn's troop spending, otherwise the AI drains its cash on troops
  // every year and never accumulates enough for a branch.
  // The AI is poor, so it has to save across several years for a costly branch.
  // Once a faction has decided on a target it withholds cash from troop buys
  // instead of spending everything every year and never getting there.
  const target = aiResearchTarget(data, state, factionName);
  if (target && faction.cash >= target.cost) {
    buyUnitUpgrade(state, factionName, target.id);
    state.factions[factionName].researchGoal = null;
  }
  const saving = target && faction.cash < target.cost;
  const buyCountry = owned.find((country) => canBuyIn(data, state, factionName, country.name));
  if (buyCountry && !saving) {
    const cost = unitCost(data, state, factionName, buyCountry.name, "troops");
    const reserve = difficultyById(state.difficulty).reserve;
    const quantity = Math.floor(faction.cash * (1 - reserve) / cost);
    if (quantity > 0) queueBuy(data, state, factionName, buyCountry.name, "troops", quantity);
  }
  const candidates = [];
  for (const from of owned) {
    for (const targetName of from.adjoiningCountries) {
      const target = state.countries[targetName];
      if (target && !friendlyFaction(state, factionName, target.owner)
        && (!state.diplomacy || target.nukedUntil <= state.year)) candidates.push({ from, targetName, defense: countryDefense(data, state, targetName) });
    }
  }
  candidates.sort((a, b) => a.defense - b.defense);
  for (const candidate of candidates.slice(0, difficultyById(state.difficulty).attacks)) {
    const troops = state.countries[candidate.from.name].units.troops - committedUnits(state, factionName, candidate.from.name, "troops");
    const attack = troops * sourceFaction.troopsAttackStrength;
    if (troops > 6 && attack > candidate.defense * difficultyById(state.difficulty).threshold) {
      queueMove(data, state, factionName, candidate.from.name, candidate.targetName, "troops", Math.max(1, troops - 4));
    }
  }
}

function planDiplomacy(data, state, humanFactions) {
  const diplomacy = state.diplomacy;
  const active = data.factions.map(({ factionName }) => factionName).filter((name) => !state.factions[name].defeated);
  const neighbors = new Map(active.map((name) => [name, new Set()]));
  for (const country of data.countries) {
    const owner = state.countries[country.name].owner;
    for (const adjacent of country.adjoiningCountries) {
      const rival = state.countries[adjacent].owner;
      if (owner && rival && owner !== rival) neighbors.get(owner)?.add(rival);
    }
  }
  const sharedThreat = (a, b) => [...neighbors.get(a)].some((name) =>
    name !== b && neighbors.get(b).has(name) && !friendlyFaction(state, a, name) && !friendlyFaction(state, b, name));
  for (const actor of active.filter((name) => !humanFactions.includes(name))) {
    const incoming = diplomacy.offers.find(({ from, to }) => to === actor && neighbors.has(from));
    const count = diplomacy.alliances.filter(({ members }) => members.includes(actor)).length;
    const breakable = diplomacy.alliances.find(({ members, locked }) => {
      const partner = members.find((name) => name !== actor);
      return !locked && members.includes(actor) && neighbors.has(partner) && !sharedThreat(actor, partner);
    });
    if (incoming) {
      const favorable = sharedThreat(actor, incoming.from) || count === 0;
      diplomacyOrder(data, state, actor, favorable ? "accept" : "decline", incoming.from);
    } else if (breakable && state.turn > 3 && random(state) < 0.16) {
      diplomacyOrder(data, state, actor, "end", breakable.members.find((name) => name !== actor));
    } else if (count < 2 && random(state) < 0.4) {
      const partner = active.find((name) => actor !== name && !friendlyFaction(state, actor, name) && sharedThreat(actor, name)
        && !diplomacy.offers.some(({ from, to }) => from === actor && to === name));
      if (partner) diplomacyOrder(data, state, actor, "propose", partner);
    }
    const humanAlly = humanFactions.find((name) => active.includes(name) && allianceBetween(state, actor, name));
    if (humanAlly && !diplomacy.requests.some(({ from, to }) => from === actor && to === humanAlly) && random(state) < 0.3) {
      const target = data.countries.find(({ name, adjoiningCountries }) => {
        const owner = state.countries[name].owner;
        return owner && !friendlyFaction(state, actor, owner) && !friendlyFaction(state, humanAlly, owner)
          && state.countries[name].nukedUntil <= state.year
          && adjoiningCountries.some((neighbor) => state.countries[neighbor]?.owner === actor)
          && adjoiningCountries.some((neighbor) => state.countries[neighbor]?.owner === humanAlly);
      });
      if (target) diplomacyOrder(data, state, actor, "support", humanAlly, target.name);
    }
  }
  // Co-op and allied human players receive requests in their diplomacy panel.
  // AI partners plan immediately from their own units when a route is available.
  for (const { from, to, target } of [...diplomacy.requests]) {
    if (!active.includes(from) || !active.includes(to) || humanFactions.includes(to) || !allianceBetween(state, from, to)) continue;
    const destination = state.countries[target];
    if (destination.nukedUntil > state.year
      || (destination.owner && friendlyFaction(state, to, destination.owner) !== friendlyFaction(state, from, destination.owner))) continue;
    const sources = data.countries.filter(({ name }) => name !== target && forceInCountry(state.countries[name], to));
    const route = ["troops", "ships", "planes"].flatMap((unitType) => sources
      .filter(({ name }) => canReach(data, state, to, name, target, unitType))
      .map(({ name }) => ({ name, unitType, quantity: availableUnitCount(state, to, name, unitType) - (unitType === "troops" ? 4 : 0) })))
      .find(({ quantity }) => quantity > 0);
    if (!route) {
      record(state, `${FACTION_META[to].short} had no forces in range of ${displayCountry(target)}.`);
      continue;
    }
    const order = queueMove(data, state, to, route.name, target, route.unitType, route.quantity);
    if (route.unitType === "ships") {
      const capacity = availableBoardingCapacity(state, to, order.id);
      if (capacity > 0) boardTroops(state, to, order.id, capacity);
    }
    record(state, `${FACTION_META[to].short} sent support to ${displayCountry(target)}.`, "good");
  }
}

function incomeFor(data, state, countryName) {
  const country = state.countries[countryName];
  const source = countrySource(data, countryName);
  let income = source.cashPerTurn || 0;
  if (country.upgrades.includes(6)) income *= 1.5;
  if (country.upgrades.includes(8)) income *= 1.25;
  return Math.round(income);
}

const SYNERGY_BONUSES = {
  0: { units: { ships: 5, planes: 5, missiles: 5 } },
  1: { units: { planes: 10 } },
  2: { cash: 200 },
  3: { units: { troops: 10 } },
  4: { units: { missiles: 10 } },
  5: { units: { ships: 10 } },
};

function applyAward(state, factionName, countryName, award, totals) {
  if (award.cash) {
    state.factions[factionName].cash += award.cash;
    totals.cash += award.cash;
  }
  for (const [unitType, quantity] of Object.entries(award.units || {})) {
    state.countries[countryName].units[unitType] += quantity;
    totals.units[unitType] += quantity;
  }
}

// Most of the countries producing a resource, never fewer than four so a tiny
// resource is still meaningful, and never more than ten so the original bar holds
// for the abundant resources.
function synergyThreshold(data, resource) {
  const total = data.countries.filter((country) => country.countryResource === resource).length;
  return Math.max(4, Math.min(10, Math.ceil(total * 0.75)));
}
function applyCountryResourceBonuses(data, state) {
  const totals = Object.fromEntries(Object.keys(state.factions).map((name) => [name, { cash: 0, units: emptyUnits() }]));
  for (const source of data.countries) {
    const factionName = state.countries[source.name].owner;
    if (!factionName || state.factions[factionName].defeated) continue;
    applyAward(state, factionName, source.name, countryResourceBonus(data, state, source.name), totals[factionName]);
  }
  for (const sourceFaction of data.factions) {
    const factionName = sourceFaction.factionName;
    const capitalName = sourceFaction.capitalCountry;
    if (state.factions[factionName].defeated || state.countries[capitalName]?.owner !== factionName) continue;
    const resourceCounts = new Map();
    for (const source of data.countries) if (state.countries[source.name].owner === factionName) {
      resourceCounts.set(source.countryResource, (resourceCounts.get(source.countryResource) || 0) + 1);
    }
    // The capital synergy originally triggered on a flat "ten countries" rule, but
    // the recovered map only has eight Finance and seven Ore countries in the
    // world, so those two awards could never be earned. The threshold is now
    // relative to how many countries produce each resource, so every one of the
    // six bonuses is reachable while still demanding near-total control.
    for (const [resource, count] of resourceCounts) {
      if (count >= synergyThreshold(data, resource)) {
        applyAward(state, factionName, capitalName, SYNERGY_BONUSES[resource], totals[factionName]);
      }
    }
  }
  const playerTotals = totals[state.playerFaction];
  const parts = Object.entries(playerTotals.units).filter(([, quantity]) => quantity > 0)
    .map(([unitType, quantity]) => `${quantity} ${quantity === 1 ? UNIT_TYPES[unitType].singular : UNIT_TYPES[unitType].label.toLowerCase()}`);
  if (playerTotals.cash) parts.push(`$${playerTotals.cash}`);
  if (parts.length) record(state, `Country resources delivered ${parts.join(", ")}.`, "good");
}

function reviveCommandos(data, state) {
  for (const sourceFaction of data.factions) {
    const factionName = sourceFaction.factionName;
    if (state.factions[factionName].defeated) continue;
    if (!hasUnitUpgrade(state, factionName, "commandos", "revive")) continue;
    const capitalName = sourceFaction.capitalCountry;
    const capital = state.countries[capitalName];
    // "If your capital country is not under your control, they disappear."
    if (!capital || capital.owner !== factionName) continue;
    const lost = state.factions[factionName].commandosLost || 0;
    if (lost <= 0) continue;
    const room = Math.max(0, commandoCap(state, factionName) - totalCommandos(state, factionName));
    const revived = Math.min(lost, room);
    state.factions[factionName].commandosLost = lost - revived;
    if (revived > 0) {
      capital.units.commandos += revived;
      record(state, `Project Lazarus restored ${revived} commandos in ${displayCountry(capitalName)}.`, "good");
    }
  }
}

function totalCommandos(state, factionName) {
  return Object.values(state.countries).reduce((sum, country) => sum + (forceInCountry(country, factionName)?.commandos || 0), 0);
}

function advanceEconomy(data, state) {
  reviveCommandos(data, state);
  for (const [factionName, faction] of Object.entries(state.factions)) {
    if (faction.defeated) continue;
    const income = data.countries.reduce((sum, country) => sum + (state.countries[country.name].owner === factionName ? incomeFor(data, state, country.name) : 0), 0);
    faction.cash += income;
  }
  for (const source of data.countries) {
    const country = state.countries[source.name];
    country.bribedBy = null;
    if (!country.owner && country.nukedUntil <= state.year) country.units.troops = Math.min(source.neutralMaxTroops || 20, country.units.troops + (source.neutralTroopsPerBuyPhase || 1));
  }
}

function emptyUnits() {
  return { troops: 0, ships: 0, planes: 0, missiles: 0, commandos: 0 };
}

function updateDefeatedFactions(state) {
  for (const [name, faction] of Object.entries(state.factions)) {
    if (!faction.defeated && !Object.values(state.countries).some((country) => country.owner === name)) {
      faction.defeated = true;
      for (const country of Object.values(state.countries)) if (country.visitors) delete country.visitors[name];
      if (state.diplomacy) {
        state.diplomacy.offers = state.diplomacy.offers.filter(({ from, to }) => from !== name && to !== name);
        state.diplomacy.requests = state.diplomacy.requests.filter(({ from, to }) => from !== name && to !== name);
      }
      record(state, `${FACTION_META[name]?.short || name} has been eliminated.`, "bad");
    }
  }
}

export function checkVictory(state, team = [state.playerFaction]) {
  const player = state.playerFaction;
  const owned = Object.values(state.countries).filter((country) => team.includes(country.owner)).length;
  const rivals = Object.entries(state.factions).filter(([name, faction]) => !team.includes(name) && !faction.defeated).length;
  let victory = false;
  if (state.objective === "domination") victory = owned === Object.values(state.countries).filter((country) => country.nukedUntil <= state.year).length;
  if (state.objective === "destroyer") victory = rivals === 0;
  if (state.objective === "supremacy") victory = owned >= 45 && team.reduce((sum, name) => sum + state.factions[name].cash, 0) >= 5000;
  if (victory) { state.status = "victory"; state.winner = player; }
  if (team.every((name) => state.factions[name].defeated)) { state.status = "defeat"; state.winner = Object.keys(state.factions).find((name) => !state.factions[name].defeated) || null; }
  return state.status;
}

// Every medal condition is stated numerically in the original English
// description, so each is checked directly against the live campaign state.
function medalEarned(data, state, factionName, medal) {
  const faction = state.factions[factionName];
  const owned = data.countries.filter((country) => state.countries[country.name].owner === factionName);
  const infrastructure = owned.reduce((total, country) => total + state.countries[country.name].upgrades.length, 0);
  const awfds = owned.filter((country) => state.countries[country.name].upgrades.includes(0)).length;
  const supply = owned.filter((country) => state.countries[country.name].upgrades.includes(1)).length;
  const holdsAll = (names) => names.every((name) => state.countries[name]?.owner === factionName);
  switch (medal.id) {
    case 0: return faction.battlesLost > 0;
    case 1: return awfds >= 10 && supply >= 10 && infrastructure >= 10;
    case 2: return faction.startingCountriesRetaken.some((name) => faction.startingCountriesLost.includes(name));
    case 3: return faction.built.troops >= 1000000;
    case 4: return faction.built.ships >= 1000;
    case 5: return faction.built.planes >= 1000;
    case 6: return faction.built.missiles >= 1000;
    case 7: return faction.built.commandos >= 100;
    case 8: {
      const resources = new Set(owned.map((country) => country.countryResource));
      return resources.has(0) && resources.has(1) && resources.has(2) && resources.has(3) && resources.has(4) && resources.has(5);
    }
    case 9: return holdsAll(["GREENLAND", "ICELAND", "GREAT_SIBERIA", "ALASKA"]);
    case 10: return holdsAll(["ALGERIA", "LYBIA", "TUNISIA", "EGYPT"]);
    case 11: return data.factions.filter((other) => other.factionName !== factionName && state.factions[other.factionName].defeated).length >= 1;
    case 12: return data.factions.filter((other) => other.factionName !== factionName && state.factions[other.factionName].defeated).length >= 2;
    case 13: return owned.length >= 50 && awfds >= 50 && supply >= 50 && infrastructure >= 50 && faction.worldUpgrades.length > 0;
    default: return false;
  }
}

export function awardedMedals(state, factionName = state.playerFaction) {
  return (state.factions[factionName]?.medals || []).map((id) => MEDALS.find((medal) => medal.id === id)).filter(Boolean);
}

function checkMedals(data, state, factionName) {
  const faction = state.factions[factionName];
  if (!faction || faction.defeated) return;
  for (const medal of MEDALS) {
    if (faction.medals.includes(medal.id)) continue;
    if (!medalEarned(data, state, factionName, medal)) continue;
    faction.medals.push(medal.id);
    if (factionName === state.playerFaction) {
      record(state, `Medal awarded: ${medal.name}.`, "good");
    }
  }
}
export function endTurn(data, state, battleEvents = [], humanFactions = [state.playerFaction], team = [state.playerFaction]) {
  ensurePlaying(state);
  if (state.diplomacy) planDiplomacy(data, state, humanFactions);
  for (const factionName of Object.keys(state.factions)) if (!humanFactions.includes(factionName)) aiPlan(data, state, factionName);
  const replay = [];
  resolveQueue(data, state, battleEvents, replay);
  state.lastReplay = { year: state.year, events: replay.slice(0, 200) };
  if (state.diplomacy) state.diplomacy.requests = state.diplomacy.requests.filter(({ to, expires }) =>
    humanFactions.includes(to) && expires > state.year);
  updateDefeatedFactions(state);
  applyCountryResourceBonuses(data, state);
  advanceEconomy(data, state);
  for (const factionName of Object.keys(state.factions)) checkMedals(data, state, factionName);
  state.year += 1;
  state.turn += 1;
  checkVictory(state, team);
  record(state, state.status === "playing" ? `Year ${state.year} begins. Treasury reports are complete.` : state.status === "victory" ? "Your objective is complete. Victory!" : "Your faction has fallen.", state.status === "defeat" ? "bad" : "good");
  return state.status;
}

export function displayCountry(name) {
  return String(name || "").split("_").map((part) => part.charAt(0) + part.slice(1).toLowerCase()).join(" ");
}

export function publicCountryView(state, countryName) {
  const country = state.countries[countryName];
  if (!country) return null;
  const visible = friendlyFaction(state, state.playerFaction, country.owner) || !country.owner || state.intel.includes(`${state.playerFaction}:${countryName}`);
  return { ...country, units: visible ? { ...country.units } : null, upgrades: visible ? [...country.upgrades] : null };
}
