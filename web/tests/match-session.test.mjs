import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMatchSave, guestSaveForHello, playMatch, readMatchSave } from "../src/match-session.js";

const board = JSON.parse(readFileSync(new URL("../data/game-data.json", import.meta.url)));
const players = board.factions.slice(0, 2).map(({ factionName }) => factionName);

test("co-op seals orders and replays the last shared round after a mid-reveal disconnect", async () => {
  const entries = new Map();
  const storage = { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const messages = [];
  const peer = (seat) => ({ connected: true, send: (message) => messages.push({ seat: 1 - seat, message: structuredClone(message) }) });
  let host, guest;
  async function connect(save) {
    host = playMatch(board, save, 0, peer(0), () => {}, storage);
    host.start();
    const { message } = messages.shift();
    const { save: restored, key } = guestSaveForHello(board, message, readMatchSave(board, 1, storage));
    guest = playMatch(board, restored, 1, peer(1), () => {}, storage);
    guest.start(key);
    await pump();
  }
  async function pump() {
    while (messages.length) {
      const { seat, message } = messages.shift();
      await (seat === 0 ? host : guest).receive(message);
    }
  }
  await connect(createMatchSave(board, { players, mode: "coop", scenario: null }));
  assert.ok(host.connected && guest.connected);
  assert.ok(host.state.diplomacy.alliances[0].locked);
  host.order("buy", ["UNITED_STATES", "troops", 1]);
  guest.order("buy", ["FRANCE", "troops", 1]);
  assert.equal(messages.length, 0);
  await host.lock();
  assert.deepEqual(messages.map(({ message }) => message.type), ["commit"]);
  assert.throws(() => host.order("buy", ["UNITED_STATES", "troops", 1]), /locked/);
  await pump();
  await guest.lock();
  for (const _ of [0, 1]) await host.receive(messages.shift().message);
  assert.equal(host.state.year, 2011);
  assert.equal(guest.state.year, 2010);
  messages.splice(0);
  await connect(readMatchSave(board, 0, storage));
  assert.equal(host.state.year, 2011);
  assert.equal(guest.state.year, 2011);
  assert.equal(host.state.factions[players[0]].built.troops, 1);
  assert.equal(guest.state.factions[players[1]].built.troops, 1);
  assert.deepEqual({ ...guest.state, playerFaction: players[0] }, host.state);
});

test("a failed browser save does not spend cash, queue a draft, or broadcast a seal", async () => {
  let writable = true;
  const storage = { setItem() { if (!writable) throw new Error("Quota exceeded"); } };
  const sent = [];
  const save = createMatchSave(board, { players, mode: "coop", scenario: null });
  const session = playMatch(board, save, 0, { connected: true, send: (message) => sent.push(message) }, () => {}, storage);
  assert.throws(() => session.order("buy", ["UNITED_STATES", "troops", 1]), /checkpoint to sync/);
  await session.receive({ type: "resume", key: save.setup.id });
  writable = false;
  const cash = session.state.factions[players[0]].cash;
  assert.throws(() => session.order("buy", ["UNITED_STATES", "troops", 1]), /could not save/);
  assert.equal(session.state.factions[players[0]].cash, cash);
  assert.equal(session.state.queue.length, 0);
  await assert.rejects(session.lock(), /could not save/);
  assert.equal(session.locked, false);
  assert.deepEqual(sent.map(({ type }) => type), ["start"]);
  writable = true;
  session.order("buy", ["UNITED_STATES", "troops", 1]);
  await session.lock();
  assert.equal(session.state.queue.length, 1);
  assert.equal(sent.at(-1).type, "commit");
});
