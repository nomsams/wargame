import {
  GameRuleError, boardTroops, buyUnitUpgrade, buyWorldUpgrade, cancelAction,
  checkVictory, diplomacyOrder, endTurn, newGame, queueBuy, queueMove, queueUpgrade, useSpyAction,
  useStrategicWeapon,
} from "./engine.js";

const actions = new Map([
  ["buy", [queueBuy, ["country", "unit", "number"]]],
  ["move", [queueMove, ["country", "country", "unit", "number"]]],
  ["build", [queueUpgrade, ["country", "number"]]],
  ["research", [buyWorldUpgrade, ["number"]]],
  ["specialize", [(data, state, actor, id) => buyUnitUpgrade(state, actor, id), ["text"]]],
  ["board", [(data, state, actor, id, count) => boardTroops(state, actor, id, count), ["text", "number"]]],
  ["cancel", [(data, state, actor, id) => cancelAction(state, id), ["text"]]],
  ["spy", [useSpyAction, ["text", "country"]]],
  ["strike", [(data, state, actor, kind, target) => useStrategicWeapon(state, actor, kind, target), ["text", "country"]]],
  ["treaty", [diplomacyOrder, ["text", "faction"]]],
  ["support", [(data, state, actor, partner, target) => diplomacyOrder(data, state, actor, "support", partner, target), ["faction", "country"]]],
]);
const units = ["troops", "ships", "planes", "missiles", "commandos"];
const reservedKeys = new Set(Object.getOwnPropertyNames(Object.prototype));
export const MATCH_PROTOCOL = 2;

export function runOrder(data, state, type, args) {
  const [execute, types] = actions.get(type) || [];
  const valid = (value, kind) => {
    if (kind === "number") return (typeof value === "number" || (typeof value === "string" && /^\d{1,16}$/.test(value))) && Number.isSafeInteger(Number(value));
    if (kind === "country") return typeof value === "string" && Object.hasOwn(state.countries, value);
    if (kind === "faction") return typeof value === "string" && Object.hasOwn(state.factions, value);
    if (kind === "unit") return units.includes(value);
    return typeof value === "string" && value.length > 0 && value.length <= 96 && !reservedKeys.has(value);
  };
  if (!Array.isArray(args) || !types || args.length !== types.length || !types.every((kind, i) => valid(args[i], kind))) {
    throw new GameRuleError("Invalid order or quantity.");
  }
  return execute(data, state, state.playerFaction, ...args);
}

export function newMatch(data, players, seed, options = {}) {
  if (!Array.isArray(players) || players.length !== 2 || players[0] === players[1]
    || !players.every((name) => data.factions.some((faction) => faction.factionName === name))
    || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new GameRuleError("Invalid multiplayer setup.");
  }
  const coOp = options.mode === "coop";
  const state = newGame(data, { playerFaction: players[0], heroName: "Player 1", objective: coOp ? "destroyer" : "domination", seed, alliances: coOp || options.mode === "alliance", scenario: options.scenario });
  state.factions[players[1]].general.name = "Player 2";
  if (coOp) state.diplomacy.alliances.push({ members: [...players], locked: true });
  return state;
}

export const MAX_PRIVATE_ORDERS = 100;

export function isOrderList(orders) {
  return Array.isArray(orders) && orders.length <= MAX_PRIVATE_ORDERS
    && orders.every((order) => order && typeof order.type === "string" && actions.has(order.type) && Array.isArray(order.args)
      && order.args.length <= 5 && order.args.every((arg) => typeof arg === "number" ? Number.isSafeInteger(arg) : typeof arg === "string" && arg.length <= 96)
      && (order.id === undefined || (typeof order.id === "string" && /^[a-z0-9-]{1,40}$/.test(order.id))))
    && JSON.stringify(orders).length <= 24_000;
}

export function applyPrivateOrder(data, state, order, references) {
  const args = [...order.args];
  if (order.type === "cancel" || order.type === "board") {
    if (!references.has(args[0])) throw new GameRuleError("The referenced order is unavailable.");
    args[0] = references.get(args[0]);
  }
  const result = runOrder(data, state, order.type, args);
  if (order.id && result?.id) references.set(order.id, result.id);
  return result;
}

export async function sealPrivateOrders(key, seat, salt, orders) {
  const canonical = orders.map(({ type, args, id }) => [type, args, id ?? null]);
  const bytes = new TextEncoder().encode(JSON.stringify([key, seat, salt, canonical]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function resolvePrivateRound(data, checkpoint, players, mode, submissions) {
  const state = structuredClone(checkpoint);
  const firstSeat = (state.turn - 1) % 2;
  for (const seat of [firstSeat, 1 - firstSeat]) {
    state.playerFaction = players[seat];
    const references = new Map();
    for (const order of submissions[seat]) {
      try {
        // Restore the round's shared outcome after immediate orders. Both seats
        // must get a chance to act before victory is evaluated.
        applyPrivateOrder(data, state, order, references);
        state.status = "playing";
        state.winner = null;
      } catch (error) {
        if (!(error instanceof GameRuleError)) throw error;
        state.log.unshift({ year: state.year, message: `${state.factions[players[seat]].general.name}: ${error.message}`, kind: "bad" });
        state.log = state.log.slice(0, 120);
      }
    }
  }
  state.playerFaction = players[0];
  endTurn(data, state, [], players, mode === "coop" ? players : undefined);
  if (mode !== "coop") updateMatchResult({ state, players });
  state.playerFaction = players[0];
  return state;
}

function updateMatchResult(match) {
  const { state, players } = match;
  // Victory rules are perspective-dependent. Inspect each side, then keep one shared result.
  let winner = null;
  let finished = false;
  for (const [seat, faction] of players.entries()) {
    state.playerFaction = faction;
    state.status = "playing";
    state.winner = null;
    const outcome = checkVictory(state);
    if (outcome === "playing") continue;
    finished = true;
    if (outcome === "victory") winner = faction;
    else if (!state.factions[players[1 - seat]].defeated) winner = players[1 - seat];
    break;
  }
  match.finished = finished;
  state.status = finished ? (winner ? "victory" : "defeat") : "playing";
  state.winner = winner;
}
