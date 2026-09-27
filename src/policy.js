// Policy engine. The agent proposes; this file decides. Nothing the model says is a release
// condition: every action is re-derived from the ledger and the policy, and refused with a
// reason when it does not fit.
//
// Action shapes the agent may propose:
//   { kind: "REFUND", doc, reason }            pay back a buyer whose paid call was not delivered
//   { kind: "TOPUP",  payee, amountMicro, reason }   refill an operating wallet to its target
//   { kind: "SWEEP",  payee, amountMicro, reason }   move cash above the operating float to reserve
//   { kind: "FLAG",   subject, reason }        no money moves; recorded for the owner
import { createHash } from "node:crypto";
import { ACCOUNTS as A } from "./ledger.js";

export const actionId = (a) => createHash("sha256").update(JSON.stringify([a.kind, a.doc ?? null, a.payee ?? null, a.amountMicro ?? null, a.subject ?? null, a.day ?? null])).digest("hex").slice(0, 32);

/**
 * @param action   proposal from the agent
 * @param ctx      { ledger, policy, screened, spentToday, treasuryMicro, balances: { [address]: micro }, executedIds:Set }
 * @returns        { ok, action (normalized, with id and amountMicro and to), reason, needsHuman }
 */
export function evaluate(action, ctx) {
  const { policy, ledger, screened = {}, spentToday = 0, treasuryMicro = 0, balances = {}, executedIds = new Set() } = ctx;
  const L = policy.limits;
  const refuse = (reason) => ({ ok: false, action, reason });
  if (!action || typeof action.kind !== "string") return refuse("malformed proposal");
  if (action.kind === "FLAG") return { ok: true, action: { ...action, id: actionId(action), amountMicro: 0 }, reason: "no money moves" };

  let to, amount, payee;
  if (action.kind === "REFUND") {
    if (!policy.refunds?.enabled) return refuse("refunds disabled by policy");
    const e = ledger.byDoc.get(action.doc);
    if (!e) return refuse(`unknown document ${action.doc}`);
    const owed = e.postings.find((p) => p.account === A.UNDELIVERED);
    if (!owed) return refuse("this document carries no paid-not-delivered liability");
    const cls = screened[e.meta.payer]?.class ?? "UNSCREENED";
    if (!policy.refunds.onlyClasses.includes(cls)) return refuse(`payer class ${cls} is not refundable (loops and seller-funded wallets are never paid out)`);
    amount = -owed.micro;
    if (policy.refunds.requireLiabilityMatch && action.amountMicro != null && action.amountMicro !== amount) return refuse(`proposed ${action.amountMicro} but the liability is ${amount}`);
    to = e.meta.payer;
  } else if (action.kind === "TOPUP" || action.kind === "SWEEP") {
    // Payees come only from the vendor master in policy.json, edited by a human. The agent
    // cannot invent an address: that is the payee-substitution attack the ledger cannot see.
    payee = policy.payees.find((p) => p.id === action.payee);
    if (!payee) return refuse(`payee ${action.payee} is not in the vendor master`);
    if (!payee.kinds.includes(action.kind)) return refuse(`payee ${payee.id} does not accept ${action.kind}`);
    if (/^0x0{40}$/.test(payee.address)) return refuse(`payee ${payee.id} has no address set by the owner`);
    to = payee.address.toLowerCase();
    amount = Number(action.amountMicro);
    if (action.kind === "TOPUP") {
      const need = (payee.targetMicro ?? 0) - (balances[to] ?? 0);
      if (need <= 0) return refuse(`${payee.id} already at or above its target`);
      if (amount > need) return refuse(`top-up ${amount} exceeds the gap to target ${need}`);
    } else {
      const free = treasuryMicro - policy.floats.arcOperatingTargetMicro;
      if (amount > free) return refuse(`sweep ${amount} would drop the treasury under its operating target (free: ${Math.max(0, free)})`);
    }
  } else return refuse(`unknown action kind ${action.kind}`);

  if (!Number.isSafeInteger(amount) || amount <= 0) return refuse("amount must be a positive integer of micro-USDC");
  if (amount > L.perActionMaxMicro) return refuse(`amount ${amount} over the per-action cap ${L.perActionMaxMicro}`);
  if (spentToday + amount > L.dailyMaxMicro) return refuse(`daily cap ${L.dailyMaxMicro} would be exceeded (spent ${spentToday})`);
  if (amount > treasuryMicro - (action.kind === "SWEEP" ? 0 : policy.floats.arcOperatingMinMicro) && action.kind !== "SWEEP") return refuse(`treasury ${treasuryMicro} cannot cover ${amount} and keep its minimum float`);
  const day = new Date().toISOString().slice(0, 10);
  const normalized = { kind: action.kind, doc: action.doc ?? null, payee: payee?.id ?? null, to, amountMicro: amount, reason: String(action.reason || "").slice(0, 300), day: action.kind === "REFUND" ? null : day };
  normalized.id = actionId(normalized);
  if (executedIds.has(normalized.id)) return refuse("already executed (idempotency)");
  return { ok: true, action: normalized, needsHuman: amount > L.humanApprovalAboveMicro, reason: amount > L.humanApprovalAboveMicro ? "within policy, above the human-approval threshold" : "within policy" };
}
