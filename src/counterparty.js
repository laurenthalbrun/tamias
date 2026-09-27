// Counterparty screening: know who is paying before you book it as revenue.
//
// On the x402 rail a "buyer" is just a wallet. Two things measured on Base in September 2026
// make wallet counts meaningless on their own:
//   - sellers that fund the wallets that buy from them (demand manufactured by the seller);
//   - one operator funding many agent wallets, so "17 buyers" is really one customer.
// So every payer is traced one hop back to whoever funded it with USDC.
import { incomingUsdc } from "./sources/base.js";

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Address poisoning: a near-zero transfer from an address that imitates a known one. */
export function looksPoisoned(from, micro, known) {
  if (micro > 1000) return null; // above 0.001 USDC nobody bothers
  for (const k of known) {
    if (k !== from && k.slice(2, 6) === from.slice(2, 6) && k.slice(-4) === from.slice(-4)) return k;
  }
  return null;
}

export class Screener {
  constructor({ ourWallets = [], sellerWallets = [], fetchIncoming = incomingUsdc } = {}) {
    this.our = new Set(ourWallets.map((a) => a.toLowerCase()));
    this.sellers = new Set(sellerWallets.map((a) => a.toLowerCase()));
    this.fetchIncoming = fetchIncoming;
    this.cache = new Map();
  }

  async funders(addr) {
    if (!this.cache.has(addr)) {
      const inc = await this.fetchIncoming(addr).catch(() => null);
      if (!inc) { this.cache.set(addr, null); return null; }
      const agg = new Map();
      for (const t of inc) agg.set(t.from, (agg.get(t.from) || 0) + t.micro);
      this.cache.set(addr, [...agg.entries()].map(([from, micro]) => ({ from, micro })).sort((a, b) => b.micro - a.micro));
    }
    return this.cache.get(addr);
  }

  /** Classify one payer. Returns { class, funders, evidence }. */
  async screen(payer) {
    const p = payer.toLowerCase();
    if (this.our.has(p)) return { class: "INTERNAL", funders: [], evidence: "payer is one of our own wallets: a transfer, not revenue" };
    const f = await this.funders(p);
    if (f === null) return { class: "UNSCREENED", funders: [], evidence: "funding history unavailable; booked, flagged for re-screening" };
    const byUs = f.filter((x) => this.our.has(x.from));
    if (byUs.length) return { class: "INTERNAL_LOOP", funders: f.slice(0, 3), evidence: `funded by our own wallet ${short(byUs[0].from)}: money going round in a circle` };
    const bySeller = f.filter((x) => this.sellers.has(x.from));
    if (bySeller.length) return { class: "SELLER_FUNDED", funders: f.slice(0, 3), evidence: `funded by seller wallet ${short(bySeller[0].from)}: demand manufactured by a seller` };
    return { class: "EXTERNAL", funders: f.slice(0, 3), evidence: f.length ? `top funder ${short(f[0].from)}` : "no USDC funding seen (funded off-rail or by bridge)" };
  }

  /** Customer concentration: how many distinct payers share the same top funder. */
  static concentration(screened) {
    const byFunder = new Map();
    for (const [payer, s] of screened) {
      const top = s.funders?.[0]?.from;
      if (!top || s.class !== "EXTERNAL") continue;
      if (!byFunder.has(top)) byFunder.set(top, new Set());
      byFunder.get(top).add(payer);
    }
    return [...byFunder.entries()].map(([funder, set]) => ({ funder, payers: set.size })).filter((x) => x.payers > 1).sort((a, b) => b.payers - a.payers);
  }
}
