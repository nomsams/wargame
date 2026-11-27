import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { newMatch, resolvePrivateRound, runOrder } from "../src/match.js";
import { decodeSignal, encodeSignal, parseSignalCode } from "../src/peer.js";
import qrcode from "../vendor/qrcode-generator.js";

const data = JSON.parse(readFileSync(new URL("../data/game-data.json", import.meta.url)));
const players = data.factions.slice(0, 2).map(({ factionName }) => factionName);

test("two peers resolve the same campaign after both players submit", () => {
  const checkpoint = newMatch(data, players, 239);
  const guestCapital = data.factions[1].capitalCountry;
  const orders = [
    [{ type: "buy", args: ["UNITED_STATES", "troops", "1"] }],
    [
      { type: "buy", args: [guestCapital, "troops", "1"] },
      { type: "move", args: [guestCapital, "IRELAND", "ships", 2], id: "guest-fleet" },
      { type: "board", args: ["guest-fleet", 2] },
    ],
  ];
  const result = resolvePrivateRound(data, checkpoint, players, "versus", orders);
  assert.deepEqual(result, resolvePrivateRound(data, checkpoint, players, "versus", orders));
  assert.equal(checkpoint.year, 2010);
  assert.equal(result.year, 2011);
  assert.equal(result.factions[players[0]].built.troops, 1);
  assert.equal(result.factions[players[1]].built.troops, 1);
  assert.equal(result.lastReplay.events.find(({ from, country }) => from === guestCapital && country === "IRELAND").carriedTroops, 2);
});

test("invalid or inherited identifiers cannot enter the match", () => {
  const match = newMatch(data, players, 239);
  const before = structuredClone(match);
  assert.throws(() => runOrder(data, match, "spy", ["constructor", "FRANCE"]), /Invalid order/);
  assert.throws(() => runOrder(data, match, "buy", ["UNITED_STATES", "troops", "1.5"]), /Invalid order/);
  assert.deepEqual(match, before);
});

test("compressed pairing links produce a QR matrix and round-trip as data-only signals", async () => {
  const offer = { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
  const sessionId = "1234567890abcdef";
  const code = await encodeSignal(offer, sessionId);
  const link = `https://example.test/wargame/web/#match=${code}`;
  assert.equal(parseSignalCode(link), code);
  assert.deepEqual(await decodeSignal(link, "offer"), offer);
  await assert.rejects(decodeSignal(link, "answer"), /needs a multiplayer answer/);
  const matrix = qrcode(0, "L");
  matrix.addData(link);
  matrix.make();
  assert.ok(matrix.getModuleCount() > 21);
  assert.match(matrix.createSvgTag({ scalable: true }), /<svg/);

  const invalid = await encodeSignal({ ...offer, sdp: offer.sdp + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" }, sessionId);
  await assert.rejects(decodeSignal(invalid, "offer"), /game data connection/);
});
