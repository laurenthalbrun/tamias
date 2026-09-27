// Three-way match for an x402 business.
//
//   offer      the price the server asked for (the journal's amount_usd, set from the price grid)
//   settlement the USDC transfer on Base (external witness, from the chain)
//   delivery   the journal row's HTTP status for that same tx hash
//
// Only a settlement that matches a delivered call at the offered amount is revenue. Everything
// else lands in a named account or an exception, where a human (or the agent) can see it.
import { ACCOUNTS as A } from "./ledger.js";
import { looksPoisoned } from "./counterparty.js";

export function reconcile({ settlements, calls, ourWallets = [], knownAddresses = [] }) {
  const our = new Set(ourWallets.map((a) => a.toLowerCase()));
  const byTx = new Map();
  // Only Base settlements are witnessed here; rows settled on another network are out of scope.
  for (const c of calls) if (c.tx_hash && (!c.network || c.network === "eip155:8453")) {
    if (!byTx.has(c.tx_hash)) byTx.set(c.tx_hash, []);
    byTx.get(c.tx_hash).push(c);
  }
  const seenTx = new Set();
  const entries = [], exceptions = [];
  const known = [...new Set([...knownAddresses, ...ourWallets].map((a) => a.toLowerCase()))];

  for (const s of settlements) {
    seenTx.add(s.tx);
    const base = { doc: s.doc, date: s.date, meta: { tx: s.tx, payer: s.from } };
    const dr = { account: A.TREASURY_BASE, micro: s.micro };
    const imitated = looksPoisoned(s.from, s.micro, known);
    if (imitated) {
      exceptions.push({ kind: "ADDRESS_POISONING", doc: s.doc, payer: s.from, imitates: imitated, micro: s.micro, action: "never pay this address; it imitates a known counterparty" });
      entries.push({ ...base, memo: "dust from a look-alike address", postings: [dr, { account: A.UNMATCHED, micro: -s.micro }], meta: { ...base.meta, class: "POISONING" } });
      continue;
    }
    if (our.has(s.from)) {
      entries.push({ ...base, memo: "transfer from our own wallet", postings: [dr, { account: A.INCOME_INTERNAL, micro: -s.micro }], meta: { ...base.meta, class: "INTERNAL" } });
      continue;
    }
    const rows = byTx.get(s.tx) || [];
    if (!rows.length) {
      exceptions.push({ kind: "SETTLEMENT_WITHOUT_JOURNAL", doc: s.doc, payer: s.from, micro: s.micro, date: s.date, action: "money received but no service record: check server logs, journal outage or a direct transfer" });
      entries.push({ ...base, memo: "settlement with no journal row", postings: [dr, { account: A.UNMATCHED, micro: -s.micro }], meta: { ...base.meta, class: "UNMATCHED" } });
      continue;
    }
    const row = rows[0];
    const offered = Math.round(Number(row.amount_usd) * 1e6);
    if (row.status >= 400) {
      exceptions.push({ kind: "PAID_NOT_DELIVERED", doc: s.doc, payer: s.from, micro: s.micro, route: row.route, status: row.status, date: s.date, action: "refund candidate: the buyer paid and the service failed" });
      entries.push({ ...base, memo: `paid, ${row.route} failed with ${row.status}`, postings: [dr, { account: A.UNDELIVERED, micro: -s.micro }], meta: { ...base.meta, route: row.route, status: row.status, class: "UNDELIVERED" } });
      continue;
    }
    // The journal stores amount_usd as a float, so a unique legacy price like 0.003001 comes
    // back as 0.003. Differences under 10 micro-USDC are the journal's rounding, not a dispute:
    // the chain amount is the truth and the rounding is kept visible in the entry's meta.
    if (Number.isFinite(offered) && Math.abs(offered - s.micro) < 10) {
      entries.push({ ...base, memo: `${row.route} delivered`, postings: [dr, { account: A.INCOME_API, micro: -s.micro }], meta: { ...base.meta, route: row.route, class: "DELIVERED", journalRoundingMicro: s.micro - offered } });
      continue;
    }
    if (Number.isFinite(offered) && offered !== s.micro) {
      exceptions.push({ kind: "AMOUNT_MISMATCH", doc: s.doc, payer: s.from, micro: s.micro, offered, route: row.route, action: "settled amount differs from the offered price" });
      const diff = s.micro - offered;
      entries.push({ ...base, memo: `${row.route}: settled ${s.micro} vs offered ${offered}`, postings: [dr, { account: A.INCOME_API, micro: -offered }, { account: A.UNMATCHED, micro: -diff }], meta: { ...base.meta, route: row.route, class: "MISMATCH" } });
      continue;
    }
    entries.push({ ...base, memo: `${row.route} delivered`, postings: [dr, { account: A.INCOME_API, micro: -s.micro }], meta: { ...base.meta, route: row.route, class: "DELIVERED" } });
  }

  // The other direction: a journal row claiming a payment the chain does not show is a
  // fictitious entry until proven otherwise. Nothing is posted for it.
  const window = settlements.length ? settlements.reduce((m, s) => (s.date < m ? s.date : m), settlements[0].date) : null;
  for (const [tx, rows] of byTx) {
    if (seenTx.has(tx)) continue;
    const r = rows[0];
    if (window && r.ts && new Date(r.ts) < new Date(window)) continue; // outside the chain window read
    exceptions.push({ kind: "JOURNAL_WITHOUT_SETTLEMENT", tx, payer: r.payer, route: r.route, micro: Math.round(Number(r.amount_usd) * 1e6), action: "journal claims a payment the chain does not show: do not book" });
  }
  return { entries, exceptions };
}
