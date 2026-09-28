// Moving revenue from Base (where x402 buyers pay) to the Arc treasury, through Circle CCTP.
//
// A treasurer does not move money just because it can. Each bridge costs gas on both sides and
// a mint fee on Arc, so the sweep waits until the batch is large enough for the cost to stay
// under `maxFeeBps` of the amount, and it always leaves `keepOnBaseMicro` behind for refunds.
// The ledger books the burn and the mint as two entries around an in-transit account, so money
// that left Base and has not landed on Arc is visible, never lost.
import { readFileSync, existsSync } from "node:fs";
import { BridgeKit } from "@circle-fin/bridge-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { ACCOUNTS as A } from "./ledger.js";

export const IN_TRANSIT = "Assets:InTransit:CCTP";
export const EXP_BRIDGE = "Expenses:Bridge";
const CHAINS = { mainnet: { base: "Base", arc: "Arc" }, testnet: { base: "Base_Sepolia", arc: "Arc_Testnet" } };
const USDC = (micro) => (micro / 1e6).toFixed(6);
const toMicro = (s) => Math.round(Number(s) * 1e6);

function adapterFrom(keyPath) {
  if (!keyPath || !existsSync(keyPath)) throw new Error(`bridge source key not configured (${keyPath ?? "unset"}): the owner must point policy.bridge.sourceKeyPath at the payTo wallet key`);
  return createViemAdapterFromPrivateKey({ privateKey: readFileSync(keyPath, "utf8").trim() });
}

/** Cost of bridging `micro` from Base to Arc, in micro-USDC equivalent. ETH gas on Base is
 *  converted at `ethUsd` (passed in, so the decision is reproducible). */
export async function quote({ net = "mainnet", micro, keyPath, recipient, ethUsd = 4000, speed = "SLOW", kit = new BridgeKit() }) {
  const adapter = adapterFrom(keyPath);
  const e = await kit.estimate({ from: { adapter, chain: CHAINS[net].base }, to: { adapter, chain: CHAINS[net].arc, recipientAddress: recipient }, amount: USDC(micro), config: { transferSpeed: speed } });
  let cost = 0;
  for (const f of e.fees || []) if (f.token === "USDC") cost += toMicro(f.amount);
  for (const g of e.gasFees || []) {
    const fee = Number(g.fees?.fee ?? 0);
    cost += g.token === "USDC" ? toMicro(fee) : Math.round(fee * ethUsd * 1e6);
  }
  return { micro, costMicro: cost, bps: micro ? Math.round((cost / micro) * 10_000) : Infinity, speed, raw: e };
}

/**
 * Pure decision: how much to sweep, or why not. No network.
 * @param baseMicro    USDC on the Base payTo wallet (from the node, not the books)
 * @param owedMicro    liabilities that must stay payable on Base (paid-not-delivered)
 * @param quoteFor     (micro) => cost in micro, for the candidate amount
 */
export async function decideSweep({ baseMicro, owedMicro = 0, cfg, quoteFor }) {
  const keep = (cfg.keepOnBaseMicro ?? 0) + owedMicro;
  const amount = baseMicro - keep;
  if (amount < cfg.minSweepMicro) return { sweep: false, reason: `only ${USDC(Math.max(0, amount))} USDC above the Base reserve; waiting for ${USDC(cfg.minSweepMicro)}` };
  const q = await quoteFor(amount);
  if (q.bps > cfg.maxFeeBps) return { sweep: false, reason: `bridging ${USDC(amount)} would cost ${USDC(q.costMicro)} (${q.bps} bps), above the ${cfg.maxFeeBps} bps ceiling; batch more first`, quote: q };
  return { sweep: true, amountMicro: amount, costMicro: q.costMicro, bps: q.bps, reason: `sweep ${USDC(amount)} USDC at ${q.bps} bps, keeping ${USDC(keep)} on Base` };
}

/** Execute the sweep and return the two ledger entries (burn on Base, mint on Arc). */
export async function sweep({ net = "mainnet", micro, keyPath, recipient, speed = "SLOW", kit = new BridgeKit(), actionId }) {
  const adapter = adapterFrom(keyPath);
  const r = await kit.bridge({ from: { adapter, chain: CHAINS[net].base }, to: { adapter, chain: CHAINS[net].arc, recipientAddress: recipient }, amount: USDC(micro), config: { transferSpeed: speed } });
  const step = (name) => (r.steps || []).find((s) => s.name?.toLowerCase().includes(name));
  const burn = step("burn"), mint = step("mint");
  if (!burn?.txHash) throw new Error(`bridge returned no burn transaction: ${JSON.stringify(r).slice(0, 300)}`);
  const now = new Date().toISOString();
  const entries = [{ doc: `cctp:burn:${burn.txHash}`, date: now, memo: `CCTP burn on Base, ${USDC(micro)} USDC to the Arc treasury`,
    postings: [{ account: IN_TRANSIT, micro }, { account: A.TREASURY_BASE, micro: -micro }], meta: { class: "BRIDGE_OUT", kind: "BRIDGE_SWEEP", actionId, amountMicro: micro, tx: burn.txHash, net } }];
  if (mint?.txHash && r.state !== "error") {
    const received = r.destination?.amount ? toMicro(r.destination.amount) : micro;
    const fee = micro - received;
    entries.push({ doc: `cctp:mint:${mint.txHash}`, date: now, memo: `CCTP mint on Arc`,
      postings: [{ account: A.TREASURY_ARC, micro: received }, ...(fee ? [{ account: EXP_BRIDGE, micro: fee }] : []), { account: IN_TRANSIT, micro: -micro }], meta: { class: "BRIDGE_IN", tx: mint.txHash, net } });
  }
  return { result: r, entries };
}
