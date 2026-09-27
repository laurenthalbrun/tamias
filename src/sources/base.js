// Source 1: the chain. Every USDC transfer received by the business's x402 payTo wallet on
// Base, read from Blockscout. This is the external witness: it does not depend on our own
// logging, so it catches money our journal never saw.
const BLOCKSCOUT = process.env.BLOCKSCOUT_BASE || "https://base.blockscout.com/api/v2";
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

async function get(url, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) }).catch((e) => ({ ok: false, status: String(e.message) }));
    if (r.ok) return r.json();
    if (i >= tries) throw new Error(`blockscout ${r.status} on ${url}`);
    await new Promise((s) => setTimeout(s, 800 * 2 ** i));
  }
}

/** USDC settlements received by `payTo` since `since` (ISO), newest first, paginated to the end. */
export async function settlements(payTo, { since, maxPages = 60 } = {}) {
  const base = `${BLOCKSCOUT}/addresses/${payTo}/token-transfers?type=ERC-20&filter=to`;
  const out = [];
  let next = "";
  for (let page = 0; page < maxPages; page++) {
    const d = await get(base + next);
    for (const t of d.items || []) {
      if (String(t.token?.address_hash || t.token?.address || "").toLowerCase() !== USDC_BASE) continue;
      if (since && t.timestamp < since) return { items: out, complete: true };
      out.push({
        doc: `base:${t.transaction_hash}:${t.log_index}`,
        tx: t.transaction_hash, logIndex: t.log_index, date: t.timestamp,
        from: t.from.hash.toLowerCase(), to: t.to.hash.toLowerCase(),
        micro: Number(t.total.value),
      });
    }
    if (!d.next_page_params) return { items: out, complete: true };
    next = "&" + new URLSearchParams(Object.entries(d.next_page_params).map(([k, v]) => [k, String(v)])).toString();
  }
  // Pagination cap hit: the list is a floor, never an overcount. Say so.
  return { items: out, complete: false };
}

/** Incoming USDC transfers of any address (used to find who funded a buyer). */
export async function incomingUsdc(address, { pages = 2 } = {}) {
  const base = `${BLOCKSCOUT}/addresses/${address}/token-transfers?type=ERC-20&filter=to`;
  const out = [];
  let next = "";
  for (let p = 0; p < pages; p++) {
    const d = await get(base + next);
    for (const t of d.items || []) {
      if (String(t.token?.address_hash || t.token?.address || "").toLowerCase() !== USDC_BASE) continue;
      out.push({ from: t.from.hash.toLowerCase(), micro: Number(t.total.value), date: t.timestamp, tx: t.transaction_hash });
    }
    if (!d.next_page_params) break;
    next = "&" + new URLSearchParams(Object.entries(d.next_page_params).map(([k, v]) => [k, String(v)])).toString();
  }
  return out;
}

// Second witness. Blockscout sometimes has not indexed a transaction that the chain did
// settle (measured: a successful Base tx on 2026-09-26 that Blockscout returned as unknown).
// Before calling a journal row fictitious, ask a Base node for the receipt directly.
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (t) => `0x${t.slice(26)}`.toLowerCase();

export async function settlementFromReceipt(tx, payTo) {
  const r = await fetch(BASE_RPC, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] }) }).then((x) => x.json()).catch(() => null);
  const rc = r?.result;
  if (!rc) return { found: false, reason: "no receipt" };
  if (rc.status !== "0x1") return { found: false, reason: "transaction reverted" };
  const log = rc.logs.find((l) => l.address.toLowerCase() === USDC_BASE && l.topics[0] === TRANSFER && topicAddr(l.topics[2]) === payTo.toLowerCase());
  if (!log) return { found: false, reason: "no USDC transfer to payTo in this tx" };
  const block = await fetch(BASE_RPC, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [rc.blockNumber, false] }) }).then((x) => x.json()).catch(() => null);
  const date = block?.result ? new Date(Number(block.result.timestamp) * 1000).toISOString() : null;
  const logIndex = Number(log.logIndex);
  return { found: true, settlement: { doc: `base:${tx}:${logIndex}`, tx, logIndex, date, from: topicAddr(log.topics[1]), to: payTo.toLowerCase(), micro: Number(BigInt(log.data)), witness: "base-rpc" } };
}
