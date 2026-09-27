// Append-only double-entry ledger.
//
// Every entry points back to the document that caused it (a settlement tx, a journal row, an
// Arc receipt). The document id is the idempotency key: posting the same document twice is a
// no-op, which is what makes a retried agent safe. Unbalanced entries are rejected, closed
// periods are locked, and anything that does not reconcile is posted to a visible
// Imbalance account instead of being buried in an expense line.
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export const ACCOUNTS = {
  TREASURY_BASE: "Assets:Base:Treasury",          // x402 payTo wallet on Base
  TREASURY_ARC: "Assets:Arc:Treasury",            // operating wallet on Arc
  RESERVE_ARC: "Assets:Arc:Reserve",              // swept reserve on Arc
  INCOME_API: "Income:API",                       // external buyers, delivered
  INCOME_INTERNAL: "Equity:InternalTransfers",    // our own wallets paying us: never revenue
  UNDELIVERED: "Liabilities:PaidNotDelivered",    // money in, service failed: owed back
  UNMATCHED: "Imbalance:UnmatchedSettlement",     // money in, no journal row explains it
  REFUNDS: "Liabilities:PaidNotDelivered",
  EXP_OPS: "Expenses:Operations",
  EQUITY: "Equity:Opening",
};

// USDC amounts are kept as integer micro-units (6 decimals). No floats in the books.
export const toMicro = (usd) => {
  const n = typeof usd === "bigint" ? Number(usd) : Math.round(Number(usd) * 1e6);
  if (!Number.isSafeInteger(n)) throw new Error(`amount out of range: ${usd}`);
  return n;
};
export const fromMicro = (m) => (m / 1e6).toFixed(6);

export class Ledger {
  constructor(path, { lockedBefore = null } = {}) {
    this.path = path;
    this.lockedBefore = lockedBefore ? new Date(lockedBefore) : null;
    this.entries = [];
    this.byDoc = new Map();
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        this.entries.push(e);
        this.byDoc.set(e.doc, e);
      }
    }
  }

  /** Post an entry. Returns { status: "posted" | "duplicate", entry }. Throws on invalid input. */
  post({ doc, date, memo, postings, meta = {} }) {
    if (!doc) throw new Error("entry rejected: no source document");
    if (this.byDoc.has(doc)) return { status: "duplicate", entry: this.byDoc.get(doc) };
    const when = new Date(date);
    if (Number.isNaN(when.getTime())) throw new Error(`entry rejected: bad date ${date}`);
    if (this.lockedBefore && when < this.lockedBefore) throw new Error(`entry rejected: period before ${this.lockedBefore.toISOString()} is locked`);
    if (!Array.isArray(postings) || postings.length < 2) throw new Error("entry rejected: needs at least two postings");
    for (const p of postings) {
      if (!p.account || !Number.isSafeInteger(p.micro) || p.micro === 0) throw new Error(`entry rejected: bad posting ${JSON.stringify(p)}`);
    }
    const sum = postings.reduce((s, p) => s + p.micro, 0);
    if (sum !== 0) throw new Error(`entry rejected: unbalanced by ${sum} micro-USDC`);
    const entry = { id: null, doc, date: when.toISOString(), memo, postings, meta, prev: this.entries.at(-1)?.id ?? null };
    // Each id hashes the previous one: editing a past line breaks every id after it.
    entry.id = createHash("sha256").update(JSON.stringify({ ...entry, id: undefined })).digest("hex").slice(0, 16);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    this.entries.push(entry);
    this.byDoc.set(doc, entry);
    return { status: "posted", entry };
  }

  balances() {
    const b = {};
    for (const e of this.entries) for (const p of e.postings) b[p.account] = (b[p.account] || 0) + p.micro;
    return b;
  }

  /** Recompute the hash chain. Returns the first broken entry, or null. */
  verifyChain() {
    let prev = null;
    for (const e of this.entries) {
      const expect = createHash("sha256").update(JSON.stringify({ ...e, id: undefined, prev })).digest("hex").slice(0, 16);
      if (e.prev !== prev || e.id !== expect) return e;
      prev = e.id;
    }
    return null;
  }
}
