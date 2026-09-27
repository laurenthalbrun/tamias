// The agent. It reads the books the way a treasurer would (balances, exceptions, who the
// payers really are) and proposes what to do. It never moves money itself: its output goes
// through policy.evaluate(), and anything above the approval threshold waits for the owner.
import { fromMicro, ACCOUNTS as A } from "./ledger.js";

const LLM_KEY = process.env.LLM_API_KEY;
const LLM_BASE = process.env.LLM_BASE_URL || "https://api.deepseek.com";
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-chat";

/** What the agent is allowed to see: a summary, never keys, never raw secrets. */
export function briefing({ ledger, state, policy, treasuryMicro, payeeBalances }) {
  const b = ledger.balances();
  const undelivered = ledger.entries.filter((e) => e.meta.class === "UNDELIVERED").map((e) => ({ doc: e.doc, payer: e.meta.payer, route: e.meta.route, owedMicro: -e.postings.find((p) => p.account === A.UNDELIVERED).micro }));
  const kinds = {};
  for (const x of state.exceptions) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  const classes = {};
  for (const v of Object.values(state.screened)) classes[v.class] = (classes[v.class] || 0) + 1;
  return {
    business: "x402 API business: AI agents pay per call in USDC on Base; the treasury operates on Arc",
    books: { revenueUsdc: fromMicro(-(b[A.INCOME_API] || 0)), internalTransfersUsdc: fromMicro(-(b[A.INCOME_INTERNAL] || 0)), unmatchedUsdc: fromMicro(-(b[A.UNMATCHED] || 0)), owedBackUsdc: fromMicro(-(b[A.UNDELIVERED] || 0)) },
    exceptions: kinds, undelivered: undelivered.slice(0, 20),
    payers: { byClass: classes, concentration: state.concentration.slice(0, 5) },
    treasury: { arcUsdc: fromMicro(treasuryMicro), operatingMinUsdc: fromMicro(policy.floats.arcOperatingMinMicro), operatingTargetUsdc: fromMicro(policy.floats.arcOperatingTargetMicro) },
    payees: policy.payees.map((p) => ({ id: p.id, purpose: p.purpose, kinds: p.kinds, targetUsdc: p.targetMicro != null ? fromMicro(p.targetMicro) : null, balanceUsdc: payeeBalances[p.address.toLowerCase()] != null ? fromMicro(payeeBalances[p.address.toLowerCase()]) : null })),
    limits: { perActionMaxUsdc: fromMicro(policy.limits.perActionMaxMicro), dailyMaxUsdc: fromMicro(policy.limits.dailyMaxMicro) },
  };
}

const SYSTEM = `You are the treasurer of a small autonomous API business. You receive a JSON briefing of its books.
Propose the treasury actions for today as JSON: {"actions":[...], "summary": "two sentences for the owner"}.
Allowed actions:
- {"kind":"REFUND","doc":"<doc from undelivered>","amountMicro":<owed>,"reason":"..."}: pay back a buyer whose paid call failed.
- {"kind":"TOPUP","payee":"<payee id>","amountMicro":<int>,"reason":"..."}: refill a payee up to its target, never above.
- {"kind":"SWEEP","payee":"reserve","amountMicro":<int>,"reason":"..."}: move treasury cash above the operating target to the reserve.
- {"kind":"FLAG","subject":"...","reason":"..."}: something the owner must look at; no money moves.
Rules: amounts are integers in micro-USDC (1 USDC = 1000000). Use only payee ids and docs present in the briefing.
Never refund a payer that is not an external customer. Flag customer concentration and unexplained money. Propose nothing you cannot justify from the briefing.`;

export async function propose(brief) {
  if (LLM_KEY) {
    try {
      const r = await fetch(`${LLM_BASE}/chat/completions`, {
        method: "POST", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${LLM_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: LLM_MODEL, temperature: 0.2, max_tokens: 900, response_format: { type: "json_object" },
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(brief) }] }),
      });
      if (r.ok) {
        const d = await r.json();
        const o = JSON.parse(d.choices?.[0]?.message?.content || "{}");
        if (Array.isArray(o.actions)) return { by: "model", model: LLM_MODEL, actions: o.actions, summary: String(o.summary || "") };
      }
    } catch { /* fall through to the rule-based planner */ }
  }
  return { by: "rules", ...planByRules(brief) };
}

/** Deterministic planner: the same decisions a careful human would take from the same briefing. */
export function planByRules(brief) {
  const actions = [];
  for (const u of brief.undelivered) actions.push({ kind: "REFUND", doc: u.doc, amountMicro: u.owedMicro, reason: `${u.route} was paid and failed` });
  for (const p of brief.payees) {
    if (!p.kinds.includes("TOPUP") || p.targetUsdc == null || p.balanceUsdc == null) continue;
    const gap = Math.round((Number(p.targetUsdc) - Number(p.balanceUsdc)) * 1e6);
    if (gap > 0) actions.push({ kind: "TOPUP", payee: p.id, amountMicro: gap, reason: `${p.id} below its target` });
  }
  const top = brief.payers.concentration[0];
  if (top) actions.push({ kind: "FLAG", subject: `customer concentration: ${top.funder}`, reason: `one funder is behind ${top.payers} paying wallets; revenue depends on a single operator` });
  if (brief.exceptions.SETTLEMENT_WITHOUT_JOURNAL) actions.push({ kind: "FLAG", subject: "settlements without a service record", reason: `${brief.exceptions.SETTLEMENT_WITHOUT_JOURNAL} payments arrived with no journal row: check journal outages before booking them as revenue` });
  if (brief.exceptions.ADDRESS_POISONING) actions.push({ kind: "FLAG", subject: "address poisoning", reason: "dust received from an address imitating a known counterparty; never copy a payee from transaction history" });
  return { actions, summary: `Rule-based plan: ${actions.length} actions.` };
}
