import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSweep } from "../src/bridge.js";

const cfg = { minSweepMicro: 1_000_000, maxFeeBps: 100, keepOnBaseMicro: 200_000 };
const flatCost = (c) => async (micro) => ({ micro, costMicro: c, bps: Math.round((c / micro) * 10_000) });

test("waits until the batch is worth bridging", async () => {
  const d = await decideSweep({ baseMicro: 900_000, cfg, quoteFor: flatCost(8_400) });
  assert.equal(d.sweep, false); assert.match(d.reason, /waiting/);
});
test("refuses when the fee is above the ceiling", async () => {
  const d = await decideSweep({ baseMicro: 1_300_000, cfg, quoteFor: flatCost(20_000) });
  assert.equal(d.sweep, false); assert.match(d.reason, /bps/);
});
test("sweeps everything above the reserve and what is owed back", async () => {
  const d = await decideSweep({ baseMicro: 2_784_833, owedMicro: 10_000, cfg, quoteFor: flatCost(8_400) });
  assert.equal(d.sweep, true); assert.equal(d.amountMicro, 2_784_833 - 210_000); assert.ok(d.bps <= 100);
});
