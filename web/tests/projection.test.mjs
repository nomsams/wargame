import assert from "node:assert/strict";
import test from "node:test";

import { decodeHitColor, encodeHitColor, projectMapPoint } from "../src/projection.js";

test("the archived west-positive map is rendered with west on the left", () => {
  const halfSize = [90, 180];
  const westernHemisphere = projectMapPoint([0, 100], halfSize, 1000, 500);
  const easternHemisphere = projectMapPoint([0, -100], halfSize, 1000, 500);

  assert.ok(westernHemisphere[0] < 500, "the Americas should render left of centre");
  assert.ok(easternHemisphere[0] > 500, "Asia should render right of centre");
});

test("country hit IDs survive anti-aliased map edges", () => {
  assert.equal(encodeHitColor(61), "rgb(61 255 194)");
  assert.equal(decodeHitColor([61, 255, 194, 255]), 61);
  assert.equal(decodeHitColor([25, 105, 80, 255]), 61);
  assert.equal(decodeHitColor([0, 0, 0, 255]), 0);
});
