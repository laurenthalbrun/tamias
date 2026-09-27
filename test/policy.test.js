import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, ACCOUNTS as A } from "../src/ledger.js";
import { evaluate } from "../src/policy.js";
import { planByRules } from "../src/agent.js";

const policy = {
  limits: { perActionMaxMicro: 250000, dailyMaxMicro: 1000000, humanApprovalAboveMicro: 100000 },
  floats: { arcOperatingMinMicro: 200000, arcOperatingTargetMicro: 500000 },
  payees: [{ id: "ops", address: "0x1111111111111111111111111111111111111111", kinds: ["TOPUP"], targetMicro: 50000 },
           { id: "reserve", address: "0x2222222222222222222222222222222222222222", kinds: ["SWEEP"] }],
  refunds: { enabled: true, onlyClasses: ["EXTERNAL"], requireLiabilityMatch: true },
};
function books() {
  const l = new Ledger(join(mkdtempSync(join(tmpdir(), "tamias-")), "l.jsonl"));
  l.post({ doc: "base:0xbad:1", date: "2026-09-20", memo: "failed", postings: [{ account: A.TREASURY_BASE, micro: 10000 }, { account: A.UNDELIVERED, micro: -10000 }], meta: { class: "UNDELIVERED", payer: "0xbuyer", route: "/v1/x" } });
  l.post({ doc: "base:0xloop:1", date: "2026-09-20", memo: "failed", postings: [{ account: A.TREASURY_BASE, micro: 10000 }, { account: A.UNDELIVERED, micro: -10000 }], meta: { class: "UNDELIVERED", payer: "0xloop", route: "/v1/x" } });
  return l;
}
const ctx = (over = {}) => ({ policy, ledger: books(), screened: { "0xbuyer": { class: "EXTERNAL" }, "0xloop": { class: "INTERNAL_LOOP" } }, treasuryMicro: 1_000_000, balances: {}, ...over });

test("a refund pays exactly the liability, to the payer on the books", () => {
  const d = evaluate({ kind: "REFUND", doc: "base:0xbad:1", amountMicro: 10000 }, ctx());
  assert.equal(d.ok, true); assert.equal(d.action.to, "0xbuyer"); assert.equal(d.action.amountMicro, 10000);
  assert.equal(evaluate({ kind: "REFUND", doc: "base:0xbad:1", amountMicro: 99999 }, ctx()).ok, false);
});
test("a wallet that loops money back to us is never refunded", () => {
  assert.match(evaluate({ kind: "REFUND", doc: "base:0xloop:1" }, ctx()).reason, /not refundable/);
});
test("the agent cannot invent a payee address", () => {
  const d = evaluate({ kind: "TOPUP", payee: "attacker", to: "0xdead", amountMicro: 1000 }, ctx());
  assert.equal(d.ok, false); assert.match(d.reason, /vendor master/);
});
test("top-up never overshoots the target", () => {
  assert.equal(evaluate({ kind: "TOPUP", payee: "ops", amountMicro: 60000 }, ctx()).ok, false);
  assert.equal(evaluate({ kind: "TOPUP", payee: "ops", amountMicro: 50000 }, ctx()).ok, true);
});
test("per-action cap, daily cap and minimum float hold", () => {
  const big = { ...policy, payees: [{ ...policy.payees[0], targetMicro: 10_000_000 }, policy.payees[1]] };
  assert.match(evaluate({ kind: "TOPUP", payee: "ops", amountMicro: 300000 }, ctx({ policy: big })).reason, /per-action cap/);
  assert.match(evaluate({ kind: "TOPUP", payee: "ops", amountMicro: 200000 }, ctx({ policy: big, spentToday: 900000 })).reason, /daily cap/);
  assert.match(evaluate({ kind: "TOPUP", payee: "ops", amountMicro: 50000 }, ctx({ treasuryMicro: 220000 })).reason, /minimum float/);
});
test("above the threshold the owner must approve", () => {
  const d = evaluate({ kind: "SWEEP", payee: "reserve", amountMicro: 200000 }, ctx());
  assert.equal(d.ok, true); assert.equal(d.needsHuman, true);
});
test("an executed action is refused the second time (idempotency)", () => {
  const first = evaluate({ kind: "TOPUP", payee: "ops", amountMicro: 50000 }, ctx());
  const again = evaluate({ kind: "TOPUP", payee: "ops", amountMicro: 50000 }, ctx({ executedIds: new Set([first.action.id]) }));
  assert.match(again.reason, /already executed/);
});
test("the rule-based planner refunds failures and flags concentration", () => {
  const plan = planByRules({ undelivered: [{ doc: "d", owedMicro: 10000, route: "/v1/x" }], payees: [], payers: { concentration: [{ funder: "0xop", payers: 7 }] }, exceptions: {} });
  assert.deepEqual(plan.actions.map((a) => a.kind), ["REFUND", "FLAG"]);
});
