import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, ACCOUNTS as A } from "../src/ledger.js";
import { reconcile } from "../src/reconcile.js";
import { Screener, looksPoisoned } from "../src/counterparty.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "tamias-")), "ledger.jsonl");
const PAYER = "0x91f17a0e69d61bb078506beee7323fa10f04f880";
const OUR = "0x2c871c2b8876dc35e9e19646fda5abf1cd27735f";

test("ledger rejects an unbalanced entry", () => {
  const l = new Ledger(tmp());
  assert.throws(() => l.post({ doc: "d1", date: "2026-09-01", memo: "x", postings: [{ account: A.TREASURY_BASE, micro: 10 }, { account: A.INCOME_API, micro: -9 }] }), /unbalanced/);
});

test("posting the same document twice is a no-op (safe retries)", () => {
  const l = new Ledger(tmp());
  const e = { doc: "base:0xabc:1", date: "2026-09-01", memo: "x", postings: [{ account: A.TREASURY_BASE, micro: 10 }, { account: A.INCOME_API, micro: -10 }] };
  assert.equal(l.post(e).status, "posted");
  assert.equal(l.post(e).status, "duplicate");
  assert.equal(l.entries.length, 1);
});

test("a locked period refuses back-dated entries", () => {
  const l = new Ledger(tmp(), { lockedBefore: "2026-09-15" });
  assert.throws(() => l.post({ doc: "d", date: "2026-09-10", memo: "x", postings: [{ account: A.TREASURY_BASE, micro: 1 }, { account: A.INCOME_API, micro: -1 }] }), /locked/);
});

test("editing a past line breaks the hash chain", () => {
  const p = tmp(); const l = new Ledger(p);
  for (const d of ["a", "b"]) l.post({ doc: d, date: "2026-09-01", memo: d, postings: [{ account: A.TREASURY_BASE, micro: 5 }, { account: A.INCOME_API, micro: -5 }] });
  assert.equal(new Ledger(p).verifyChain(), null);
  writeFileSync(p, readFileSync(p, "utf8").replace('"memo":"a"', '"memo":"tampered"'));
  assert.notEqual(new Ledger(p).verifyChain(), null);
});

const S = (tx, from, micro) => ({ doc: `base:${tx}:1`, tx, logIndex: 1, date: "2026-09-20T00:00:00Z", from, to: OUR, micro });
const C = (tx, status, amount) => ({ tx_hash: tx, status, amount_usd: amount, route: "/v1/x", payer: PAYER, ts: "2026-09-20T00:00:00Z", network: "eip155:8453" });

test("three-way match: only a delivered call at the offered price is revenue", () => {
  const { entries, exceptions } = reconcile({
    settlements: [S("0x1", PAYER, 10000), S("0x2", PAYER, 10000), S("0x3", PAYER, 10000), S("0x4", OUR, 50000), S("0x5", PAYER, 3001)],
    calls: [C("0x1", 200, 0.01), C("0x2", 502, 0.01), C("0x5", 200, 0.003), C("0x9", 200, 0.01)],
    ourWallets: [OUR],
  });
  const cls = Object.fromEntries(entries.map((e) => [e.meta.tx, e.meta.class]));
  assert.equal(cls["0x1"], "DELIVERED");
  assert.equal(cls["0x2"], "UNDELIVERED");          // paid, service failed: owed back
  assert.equal(cls["0x3"], "UNMATCHED");            // money with no service record
  assert.equal(cls["0x4"], "INTERNAL");             // our own wallet: never revenue
  assert.equal(cls["0x5"], "DELIVERED");            // journal float rounding is not a dispute
  assert.ok(exceptions.some((x) => x.kind === "PAID_NOT_DELIVERED"));
  assert.ok(exceptions.some((x) => x.kind === "JOURNAL_WITHOUT_SETTLEMENT" && x.tx === "0x9"));
});

test("dust from a look-alike address is flagged as poisoning", () => {
  const fake = "0x91f1" + "0".repeat(32) + "f880";
  assert.equal(looksPoisoned(fake, 0, [PAYER]), PAYER);
  assert.equal(looksPoisoned(fake, 5000, [PAYER]), null);
});

test("screening: seller-funded, internal loop and one operator behind many payers", async () => {
  const SELLER = "0x4466d4a84b7c49a6a094ec6eef4a0712d6dd125e", OP = "0x3f06d2d7780771213483a1c34f9aa0fd9109edfc";
  const funding = { "0xa": [{ from: SELLER, micro: 1e6 }], "0xb": [{ from: OUR, micro: 1e6 }], "0xc": [{ from: OP, micro: 250000 }], "0xd": [{ from: OP, micro: 250000 }] };
  const s = new Screener({ ourWallets: [OUR], sellerWallets: [SELLER], fetchIncoming: async (a) => funding[a] || [] });
  assert.equal((await s.screen("0xa")).class, "SELLER_FUNDED");
  assert.equal((await s.screen("0xb")).class, "INTERNAL_LOOP");
  const m = new Map([["0xc", await s.screen("0xc")], ["0xd", await s.screen("0xd")]]);
  assert.deepEqual(Screener.concentration(m), [{ funder: OP, payers: 2 }]);
});
