import { GameRuleError, validateSavedGame } from "./engine.js";
import { isOrderList, MATCH_PROTOCOL, newMatch, resolvePrivateRound, runOrder, sealPrivateOrders } from "./match.js";
import { REGIONAL_SCENARIO, scenarioData } from "./scenario.js";

const SAVE_PREFIX = "wargame-match-v2-";
const validKey = (value) => typeof value === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{128})$/.test(value);
const validSalt = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const validDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const matchModes = ["versus", "alliance", "coop"];

function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newCheckpoint(key, state) {
  return { key, state, orders: [], salt: null, commitment: null };
}

export function validateMatchSetup(board, setup) {
  if (!setup || setup.version !== MATCH_PROTOCOL || !validSalt(setup.id) || !matchModes.includes(setup.mode)
    || ![null, REGIONAL_SCENARIO].includes(setup.scenario)) throw new Error("Incompatible match version or scenario.");
  const data = scenarioData(board, setup.scenario);
  return { data, initial: newMatch(data, setup.players, setup.seed, setup) };
}

export function createMatchSave(board, { players, mode, scenario }) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const setup = { version: MATCH_PROTOCOL, id: randomHex(), players, mode, scenario, seed };
  const { initial } = validateMatchSetup(board, setup);
  return { setup, history: [newCheckpoint(setup.id, initial)] };
}

export function readMatchSave(board, seat, storage = localStorage) {
  try {
    const save = JSON.parse(storage.getItem(SAVE_PREFIX + seat));
    const { data } = validateMatchSetup(board, save.setup);
    if (!Array.isArray(save.history) || save.history.length < 1 || save.history.length > 3) return null;
    return save.history.every((point) => validKey(point?.key) && isOrderList(point.orders)
      && (point.salt === null && point.commitment === null || validSalt(point.salt) && validDigest(point.commitment))
      && point.state?.playerFaction === save.setup.players[0] && validateSavedGame(point.state, data)) ? save : null;
  } catch {
    return null;
  }
}

export function guestSaveForHello(board, message, stored) {
  if (message?.type !== "hello" || !Array.isArray(message.keys) || message.keys.length < 1
    || message.keys.length > 3 || !message.keys.every(validKey)) throw new Error("Invalid resume handshake.");
  const { initial } = validateMatchSetup(board, message.setup);
  if (stored?.setup.id === message.setup.id) {
    const { seed, mode, scenario, players } = stored.setup;
    if (seed !== message.setup.seed || mode !== message.setup.mode || scenario !== message.setup.scenario
      || !players.every((name, index) => name === message.setup.players[index])) {
      throw new Error("The invite does not match this saved campaign.");
    }
    const key = message.keys.find((candidate) => stored.history.some((item) => item.key === candidate));
    if (!key) throw new Error("The devices do not share a recent match save.");
    return { save: stored, key };
  }
  if (message.keys.length !== 1 || message.keys[0] !== message.setup.id) {
    throw new Error("This device needs its saved copy of the match to reconnect.");
  }
  return { save: { setup: message.setup, history: [newCheckpoint(message.setup.id, initial)] }, key: message.setup.id };
}

export function playMatch(board, save, seat, peer, onChange, storage = localStorage) {
  const { setup, history } = save;
  const { data } = validateMatchSetup(board, setup);
  const player = setup.players[seat];
  let checkpoint = history[0];
  let draft = buildDraft(checkpoint);
  let ready = false;
  let locking = false;
  let remoteCommit = null;
  let revealSent = false;

  function buildDraft(point) {
    const next = structuredClone(point.state);
    next.playerFaction = player;
    for (const order of point.orders) runOrder(data, next, order.type, order.args);
    return next;
  }

  function saveHistory(nextHistory, nextDraft = draft) {
    try {
      storage.setItem(SAVE_PREFIX + seat, JSON.stringify({ setup, history: nextHistory }));
    } catch {
      throw new GameRuleError("The browser could not save the match. Check that site storage is available, then retry.");
    }
    history.splice(0, history.length, ...nextHistory);
    checkpoint = history[0];
    draft = nextDraft;
  }

  function choose(key) {
    const index = history.findIndex((entry) => entry.key === key);
    if (index === -1) throw new Error("The devices do not have a common match save.");
    const nextHistory = history.slice(index);
    saveHistory(nextHistory, buildDraft(nextHistory[0]));
  }

  function announce() {
    if (checkpoint.commitment) peer.send({ type: "commit", key: checkpoint.key, digest: checkpoint.commitment });
  }

  function revealWhenReady() {
    if (!checkpoint.commitment || !remoteCommit || revealSent) return;
    peer.send({ type: "reveal", key: checkpoint.key, salt: checkpoint.salt, orders: checkpoint.orders });
    revealSent = true;
  }

  return {
    data, setup, player, seat, peer,
    get state() { return draft; },
    get connected() { return ready && peer.connected; },
    get locked() { return locking || Boolean(checkpoint.commitment); },
    get finished() { return checkpoint.state.status !== "playing"; },
    start(key) {
      if (seat === 0) peer.send({ type: "hello", setup, keys: history.map((entry) => entry.key) });
      else {
        choose(key);
        peer.send({ type: "resume", key });
      }
    },
    order(type, args) {
      if (!ready) throw new GameRuleError("Wait for the match checkpoint to sync.");
      if (locking || checkpoint.commitment || checkpoint.state.status !== "playing") throw new GameRuleError("Orders are locked for this round.");
      if (!isOrderList([...checkpoint.orders, { type, args }])) throw new GameRuleError("The private order list is full.");
      const next = structuredClone(draft);
      const result = runOrder(data, next, type, args);
      const orders = [...checkpoint.orders, { type, args: [...args], ...(result?.id ? { id: result.id } : {}) }];
      if (!isOrderList(orders)) throw new GameRuleError("The private order list is full.");
      saveHistory([{ ...checkpoint, orders }, ...history.slice(1)], next);
      return result;
    },
    async lock() {
      if (!ready || !peer.connected || locking || checkpoint.commitment || checkpoint.state.status !== "playing") return;
      locking = true;
      onChange();
      try {
        const salt = randomHex();
        const digest = await sealPrivateOrders(checkpoint.key, seat, salt, checkpoint.orders);
        saveHistory([{ ...checkpoint, salt, commitment: digest }, ...history.slice(1)]);
        announce();
        revealWhenReady();
      } finally {
        locking = false;
        onChange();
      }
    },
    async receive(message) {
      if (!ready) {
        if (seat === 0 && message.type === "resume") {
          choose(message.key);
          peer.send({ type: "start", key: checkpoint.key });
        } else if (seat !== 1 || message.type !== "start" || message.key !== checkpoint.key) {
          throw new Error("Invalid match handshake.");
        }
        ready = true;
        announce();
        onChange();
        return;
      }
      if (message.key !== checkpoint.key) throw new Error("Match checkpoints do not agree.");
      if (message.type === "commit" && !remoteCommit && validDigest(message.digest)) {
        remoteCommit = message.digest;
        revealWhenReady();
        onChange();
        return;
      }
      if (message.type !== "reveal" || !checkpoint.commitment || !remoteCommit || !revealSent
        || !validSalt(message.salt) || !isOrderList(message.orders)) throw new Error("Invalid private order reveal.");
      const verified = await sealPrivateOrders(checkpoint.key, 1 - seat, message.salt, message.orders);
      if (verified !== remoteCommit) throw new Error("Revealed orders do not match their commitment.");
      const orders = seat === 0 ? [checkpoint.orders, message.orders] : [message.orders, checkpoint.orders];
      const next = resolvePrivateRound(data, checkpoint.state, setup.players, setup.mode, orders);
      const key = seat === 0 ? checkpoint.commitment + remoteCommit : remoteCommit + checkpoint.commitment;
      const nextPoint = newCheckpoint(key, next);
      saveHistory([nextPoint, ...history.slice(0, 2)], buildDraft(nextPoint));
      remoteCommit = null;
      revealSent = false;
      onChange(true);
    },
  };
}
