import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CAPITAL_MARKER_OVERRIDES, decodeHitColor, encodeHitColor, mapProjectionFrame, pinchMapView, projectMapPoint } from "../src/projection.js";

const data = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../data/game-data.json", import.meta.url)), "utf8"));

function pointInTriangle(point, a, b, c) {
  const cross = (p, first, second) => (p[0] - second[0]) * (first[1] - second[1]) - (first[0] - second[0]) * (p[1] - second[1]);
  const signs = [cross(point, a, b), cross(point, b, c), cross(point, c, a)];
  return signs.every((value) => value >= 0) || signs.every((value) => value <= 0);
}

test("the archived west-positive map is rendered with west on the left", () => {
  const halfSize = [90, 180];
  const westernHemisphere = projectMapPoint([0, 100], halfSize, 1000, 500);
  const easternHemisphere = projectMapPoint([0, -100], halfSize, 1000, 500);

  assert.ok(westernHemisphere[0] < 500, "the Americas should render left of centre");
  assert.ok(easternHemisphere[0] > 500, "Asia should render right of centre");
});

test("portrait projection keeps the original landscape proportions and centers the board", () => {
  const frame = mapProjectionFrame(390, 676);
  assert.equal(frame.width / frame.height, 1.5);
  assert.equal(frame.y, 208);

  const top = projectMapPoint([90, 0], [90, 180], 390, 676, 0);
  const bottom = projectMapPoint([-90, 0], [90, 180], 390, 676, 0);
  assert.equal(top[1], 208);
  assert.equal(bottom[1], 468);
  assert.equal(bottom[1] - top[1], 260);
});

test("two-finger gestures zoom around their moving midpoint", () => {
  const start = { zoom: 1, panX: 0, panY: 0, distance: 70, centerX: 195, centerY: 338, canvasWidth: 390, canvasHeight: 676 };
  assert.deepEqual(pinchMapView(start, { ...start, distance: 140 }), { zoom: 2, panX: 0, panY: 0 });
  assert.deepEqual(pinchMapView(start, { ...start, distance: 350 }), { zoom: 4, panX: 0, panY: 0 });

  const moved = pinchMapView(start, { ...start, distance: 140, centerX: 215, centerY: 348 });
  assert.deepEqual(moved, { zoom: 2, panX: 20, panY: 10 });
});

test("country hit IDs survive anti-aliased map edges", () => {
  assert.equal(encodeHitColor(61), "rgb(61 255 194)");
  assert.equal(decodeHitColor([61, 255, 194, 255]), 61);
  assert.equal(decodeHitColor([25, 105, 80, 255]), 61);
  assert.equal(decodeHitColor([0, 0, 0, 255]), 0);
});

test("every capital star is anchored inside its country", () => {
  for (const faction of data.factions) {
    const country = data.map.countries.find((item) => item.name === faction.capitalCountry);
    const marker = CAPITAL_MARKER_OVERRIDES[country.name] || country.center;
    let inside = false;
    for (let cursor = country.indexStart; cursor < country.indexStart + country.indexLength; cursor += 3) {
      const triangle = [0, 1, 2].map((offset) => data.map.vertices[data.map.indices[cursor + offset]]);
      if (pointInTriangle(marker, ...triangle)) { inside = true; break; }
    }
    assert.equal(inside, true, `${country.name} capital marker`);
  }
});
