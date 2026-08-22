import { FACTION_META, OBJECTIVES, SPY_ACTIONS, UNIT_TYPES, UPGRADES, factionCanBuild, upgradeById } from "./config.js";

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

  for (const faction of data.factions) {
    state.factions[faction.factionName] = {
      cash: faction.factionInitialCash,
      defeated: false,
      worldUpgrades: [],
      nukes: 0,
      railGunReady: 2010,
      conquests: 0,
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
  if (!value || value.saveVersion !== SAVE_VERSION || typeof value !== "object") return false;
  if (!factionSource(data, value.playerFaction) || !OBJECTIVES[value.objective]) return false;
  return data.countries.every((country) => value.countries?.[country.name]?.units);
}

export function availableUpgrades(data, state, factionName, scope, countryName = null) {
  const faction = factionSource(data, factionName);
  if (!faction) return [];
  const quickLearner = ownsUpgrade(state, factionName, 14);
  return UPGRADES.filter((upgrade) => {
    if (upgrade.scope !== scope) return false;
    if (!factionCanBuild(faction, upgrade.id) && !(quickLearner && scope === "country" && upgrade.id >= 3 && upgrade.id <= 8)) return false;
    if (scope === "world") return !ownsUpgrade(state, factionName, upgrade.id);
    return countryName ? !state.countries[countryName].upgrades.includes(upgrade.id) : true;
  });
}

function costMultiplier(country, unitType) {
  const resource = country.countryResource;
  if (resource === 0 && ["ships", "planes", "missiles"].includes(unitType)) return 0.85;
  if (resource === 1 && ["ships", "planes"].includes(unitType)) return 0.8;
  if (resource === 2) return 0.9;
  if (resource === 3 && unitType === "troops") return 0.75;
  if (resource === 4 && ["missiles", "commandos"].includes(unitType)) return 0.85;
  if (resource === 5 && unitType === "ships") return 0.75;
  return 1;
}

export function unitCost(data, state, factionName, countryName, unitType) {
  const faction = factionSource(data, factionName);
  const country = countrySource(data, countryName);
  const unit = UNIT_TYPES[unitType];
  if (!faction || !country || !unit) throw new GameRuleError("Unknown unit purchase.");
  return Math.max(1, Math.round(faction[unit.costKey] * costMultiplier(country, unitType)));
}

function canBuyIn(data, state, factionName, countryName) {
  const source = countrySource(data, countryName);
  const country = countryState(state, countryName);
  return country.owner === factionName && country.nukedUntil <= state.year
    && (source.faction === factionName || country.upgrades.includes(1) || ownsUpgrade(state, factionName, 19));
}

export function queueBuy(data, state, factionName, countryName, unitType, quantity) {
  ensurePlaying(state);
  const faction = factionState(state, factionName);
  const amount = Math.floor(Number(quantity));
  if (!UNIT_TYPES[unitType] || amount < 1) throw new GameRuleError("Choose at least one unit.");
  if (!canBuyIn(data, state, factionName, countryName)) throw new GameRuleError("Units can only be bought in a starting country or Supply Center.");
  const source = countrySource(data, countryName);
  if (unitType === "ships" && !source.hasSeaBorder) throw new GameRuleError("Ships require a sea border.");
  const currentCommandos = Object.values(state.countries).reduce((sum, country) => sum + (country.owner === factionName ? country.units.commandos : 0), 0);
  const cap = ownsUpgrade(state, factionName, 16) ? 300 : 100;
  if (unitType === "commandos" && currentCommandos + amount > cap) throw new GameRuleError(`Your commando limit is ${cap}.`);
  const total = unitCost(data, state, factionName, countryName, unitType) * amount;
  if (faction.cash < total) throw new GameRuleError("Insufficient funds.");
  faction.cash -= total;
  state.queue.push({ id: cryptoId(state), type: "buy", faction: factionName, country: countryName, unitType, quantity: amount, cost: total });
  record(state, `${amount} ${UNIT_TYPES[unitType].label.toLowerCase()} queued in ${displayCountry(countryName)}.`);
}

function committedUnits(state, factionName, countryName, unitType) {
  return state.queue.filter((action) => action.type === "move" && action.faction === factionName && action.from === countryName && action.unitType === unitType)
    .reduce((sum, action) => sum + action.quantity, 0);
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
  const amount = Math.floor(Number(quantity));
  if (from.owner !== factionName) throw new GameRuleError("You do not control the source country.");
  if (!UNIT_TYPES[unitType] || amount < 1) throw new GameRuleError("Choose at least one unit.");
  if (!canReach(data, state, factionName, fromName, toName, unitType)) throw new GameRuleError("That unit cannot reach the target country.");
  if (from.units[unitType] - committedUnits(state, factionName, fromName, unitType) < amount) throw new GameRuleError("Not enough uncommitted units in the source country.");
  state.queue.push({ id: cryptoId(state), type: "move", faction: factionName, from: fromName, to: toName, unitType, quantity: amount });
  record(state, `${amount} ${UNIT_TYPES[unitType].label.toLowerCase()} ordered from ${displayCountry(fromName)} to ${displayCountry(toName)}.`);
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
  state.queue.push({ id: cryptoId(state), type: "country-upgrade", faction: factionName, country: countryName, upgradeId: upgrade.id, cost: upgrade.cost });
  record(state, `${upgrade.title} queued in ${displayCountry(countryName)}.`);
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

export function useSpyAction(data, state, factionName, actionName, targetName) {
  ensurePlaying(state);
  const faction = factionState(state, factionName);
  const action = SPY_ACTIONS[actionName];
  const target = countryState(state, targetName);
  const source = countrySource(data, targetName);
  if (!action || target.owner === factionName || !target.owner) throw new GameRuleError("Choose an enemy-controlled country.");
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
  if (!target.owner || target.owner === factionName) throw new GameRuleError("Choose an enemy-controlled country.");
  if (kind === "nuke") {
    if (!ownsUpgrade(state, factionName, 12) || faction.nukes < 1) throw new GameRuleError("No nuclear warheads remain.");
    faction.nukes -= 1;
    target.units = emptyUnits();
    target.owner = null;
    target.upgrades = [];
    target.nukedUntil = state.year + 2;
    record(state, `${displayCountry(targetName)} was destroyed by a nuclear strike.`, "bad");
  } else if (kind === "railgun") {
    if (!ownsUpgrade(state, factionName, 17) || faction.railGunReady > state.year) throw new GameRuleError("Rail Gun is not ready.");
    for (const unit of Object.keys(UNIT_TYPES)) target.units[unit] = Math.floor(target.units[unit] * 0.15);
    faction.railGunReady = state.year + 3;
    record(state, `Rail Gun devastated ${displayCountry(targetName)}.`, "bad");
  } else throw new GameRuleError("Unknown strategic weapon.");
  updateDefeatedFactions(state);
}

function cryptoId(state) {
  return `${state.turn}-${state.queue.length}-${Math.floor(random(state) * 1e9).toString(36)}`;
}

function generalMultiplier(state, factionName) {
  const general = state.factions[factionName].general;
  return general.inactiveUntil >= state.year ? 1 : 1 + Math.min(4, general.level) * 0.03;
}

function attackMultiplier(state, factionName, unitType) {
  let multiplier = generalMultiplier(state, factionName);
  if (ownsUpgrade(state, factionName, 10) && ["troops", "commandos"].includes(unitType)) multiplier *= 1.5;
  return multiplier;
}

function defenseMultiplier(state, countryName, unitType) {
  const country = state.countries[countryName];
  let multiplier = generalMultiplier(state, country.owner);
  if (country.upgrades.includes(0)) multiplier *= 1.5;
  if (country.upgrades.includes(4)) multiplier *= 1.5;
  if (country.upgrades.includes(8)) multiplier *= 1.25;
  if (country.bribedBy) multiplier *= 0.5;
  if (ownsUpgrade(state, country.owner, 10) && ["troops", "commandos"].includes(unitType)) multiplier *= 0.75;
  return multiplier;
}

export function countryDefense(data, state, countryName) {
  const country = countryState(state, countryName);
  if (!country.owner) return country.units.troops;
  const faction = factionSource(data, country.owner);
  return Object.entries(UNIT_TYPES).reduce((total, [unitType, unit]) => total + country.units[unitType] * faction[unit.defenseKey] * defenseMultiplier(state, countryName, unitType), 0);
}

function resolveMove(data, state, action) {
  const from = state.countries[action.from];
  const to = state.countries[action.to];
  if (!from || !to || from.owner !== action.faction || from.units[action.unitType] < action.quantity) {
    record(state, `Move from ${displayCountry(action.from)} failed because the source force changed.`, "bad");
    return;
  }
  from.units[action.unitType] -= action.quantity;
  if (to.owner === action.faction) {
    to.units[action.unitType] += action.quantity;
    return;
  }
  if (to.nukedUntil > state.year) {
    record(state, `${displayCountry(action.to)} is still uninhabitable.`, "bad");
    from.units[action.unitType] += action.quantity;
    return;
  }

  const faction = factionSource(data, action.faction);
  const attack = action.quantity * faction[UNIT_TYPES[action.unitType].attackKey] * attackMultiplier(state, action.faction, action.unitType) * (0.86 + random(state) * 0.28);
  const defense = Math.max(1, countryDefense(data, state, action.to)) * (0.86 + random(state) * 0.28);
  const won = attack > defense;
  const lossRatio = clamp((won ? defense : attack) / Math.max(1, attack + defense) * 1.55, 0.08, won ? 0.78 : 0.95);
  const survivors = Math.max(won ? 1 : 0, action.quantity - Math.ceil(action.quantity * lossRatio));
  if (won) {
    const oldOwner = to.owner;
    const defeatedTroops = to.units.troops;
    to.owner = action.faction;
    to.units = emptyUnits();
    to.units[action.unitType] = survivors;
    if (ownsUpgrade(state, action.faction, 18)) to.units.troops += Math.ceil(defeatedTroops * 0.5);
    if (ownsUpgrade(state, action.faction, 19)) to.upgrades = [0, 1, 15];
    else to.upgrades = [];
    state.factions[action.faction].conquests += 1;
    state.factions[action.faction].general.level = 1 + Math.min(3, Math.floor(state.factions[action.faction].conquests / 8));
    record(state, `${FACTION_META[action.faction]?.code || action.faction} conquered ${displayCountry(action.to)}${oldOwner ? ` from ${FACTION_META[oldOwner]?.code || oldOwner}` : ""}.`, "good");
  } else {
    const attrition = clamp(attack / Math.max(1, defense) * 0.65, 0.05, 0.85);
    for (const unitType of Object.keys(UNIT_TYPES)) to.units[unitType] = Math.max(0, Math.round(to.units[unitType] * (1 - attrition)));
    record(state, `${FACTION_META[action.faction]?.code || action.faction} failed to take ${displayCountry(action.to)}.`, "bad");
  }
}

function resolveQueue(data, state) {
  const ordering = { "country-upgrade": 0, buy: 1, move: 2 };
  const queue = [...state.queue].sort((a, b) => ordering[a.type] - ordering[b.type]);
  state.queue = [];
  for (const action of queue) {
    if (action.type === "buy" && state.countries[action.country]?.owner === action.faction) state.countries[action.country].units[action.unitType] += action.quantity;
    if (action.type === "country-upgrade" && state.countries[action.country]?.owner === action.faction) state.countries[action.country].upgrades.push(action.upgradeId);
    if (action.type === "move") resolveMove(data, state, action);
  }
}

function aiPlan(data, state, factionName) {
  const faction = state.factions[factionName];
  if (faction.defeated) return;
  const owned = data.countries.filter((country) => state.countries[country.name].owner === factionName);
  if (!owned.length) return;
  const sourceFaction = factionSource(data, factionName);
  const buyCountry = owned.find((country) => canBuyIn(data, state, factionName, country.name));
  if (buyCountry) {
    const cost = unitCost(data, state, factionName, buyCountry.name, "troops");
    const reserve = state.difficulty === "hard" ? 0.15 : state.difficulty === "easy" ? 0.45 : 0.3;
    const quantity = Math.floor(faction.cash * (1 - reserve) / cost);
    if (quantity > 0) queueBuy(data, state, factionName, buyCountry.name, "troops", quantity);
  }
  const candidates = [];
  for (const from of owned) {
    for (const targetName of from.adjoiningCountries) {
      const target = state.countries[targetName];
      if (target && target.owner !== factionName) candidates.push({ from, targetName, defense: countryDefense(data, state, targetName) });
    }
  }
  candidates.sort((a, b) => a.defense - b.defense);
  for (const candidate of candidates.slice(0, state.difficulty === "hard" ? 3 : 1)) {
    const troops = state.countries[candidate.from.name].units.troops - committedUnits(state, factionName, candidate.from.name, "troops");
    const attack = troops * sourceFaction.troopsAttackStrength;
    if (troops > 6 && attack > candidate.defense * (state.difficulty === "easy" ? 1.35 : 0.8)) {
      queueMove(data, state, factionName, candidate.from.name, candidate.targetName, "troops", Math.max(1, troops - 4));
    }
  }
}

function incomeFor(data, state, countryName) {
  const country = state.countries[countryName];
  const source = countrySource(data, countryName);
  let income = source.cashPerTurn || 0;
  if (country.upgrades.includes(6)) income *= 1.5;
  if (country.upgrades.includes(8)) income *= 1.25;
  if (country.upgrades.includes(15)) income *= 2;
  return Math.round(income);
}

function advanceEconomy(data, state) {
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
      record(state, `${FACTION_META[name]?.short || name} has been eliminated.`, "bad");
    }
  }
}

export function checkVictory(state) {
  const player = state.playerFaction;
  const owned = Object.values(state.countries).filter((country) => country.owner === player).length;
  const rivals = Object.entries(state.factions).filter(([name, faction]) => name !== player && !faction.defeated).length;
  let victory = false;
  if (state.objective === "domination") victory = owned === Object.values(state.countries).filter((country) => country.nukedUntil <= state.year).length;
  if (state.objective === "destroyer") victory = rivals === 0;
  if (state.objective === "supremacy") victory = owned >= 45 && state.factions[player].cash >= 5000;
  if (victory) { state.status = "victory"; state.winner = player; }
  if (state.factions[player].defeated) { state.status = "defeat"; state.winner = Object.keys(state.factions).find((name) => !state.factions[name].defeated) || null; }
  return state.status;
}

export function endTurn(data, state) {
  ensurePlaying(state);
  for (const factionName of Object.keys(state.factions)) if (factionName !== state.playerFaction) aiPlan(data, state, factionName);
  resolveQueue(data, state);
  updateDefeatedFactions(state);
  advanceEconomy(data, state);
  state.year += 1;
  state.turn += 1;
  checkVictory(state);
  record(state, state.status === "playing" ? `Year ${state.year} begins. Treasury reports are complete.` : state.status === "victory" ? "Your objective is complete. Victory!" : "Your faction has fallen.", state.status === "defeat" ? "bad" : "good");
  return state.status;
}

export function displayCountry(name) {
  return String(name || "").split("_").map((part) => part.charAt(0) + part.slice(1).toLowerCase()).join(" ");
}

export function publicCountryView(state, countryName) {
  const country = state.countries[countryName];
  if (!country) return null;
  const visible = country.owner === state.playerFaction || !country.owner || state.intel.includes(`${state.playerFaction}:${countryName}`);
  return { ...country, units: visible ? { ...country.units } : null, upgrades: visible ? [...country.upgrades] : null };
}
