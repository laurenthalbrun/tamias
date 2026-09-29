// Arc execution. Every USDC payment goes through Arc's Memo contract, so the transfer carries
// the ledger reference on-chain: anyone reading Arc can tie the payment to the entry that
// justified it, and the treasurer reads its own receipts back as the external witness.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, fallback, encodeFunctionData, erc20Abi, parseEventLogs, keccak256, stringToHex, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

export const USDC_ARC = "0x3600000000000000000000000000000000000000"; // ERC-20 view of native USDC, 6 decimals
export const MEMO = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
const MEMO_ABI = [
  { type: "function", name: "memo", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }, { name: "memoId", type: "bytes32" }, { name: "memoData", type: "bytes" }], outputs: [] },
  { type: "event", name: "Memo", anonymous: false, inputs: [{ name: "sender", type: "address", indexed: true }, { name: "target", type: "address", indexed: true }, { name: "callDataHash", type: "bytes32", indexed: false }, { name: "memoId", type: "bytes32", indexed: true }, { name: "memo", type: "bytes", indexed: false }, { name: "memoIndex", type: "uint256", indexed: false }] },
];

// Public endpoints from docs.arc.io. Circle's primary endpoint rate-limits bursts of log reads,
// so every client falls back across providers instead of stalling on one.
export const NETWORKS = {
  "arc-testnet": { chain: arcTestnet, explorer: "https://testnet.arcscan.app",
    rpcs: ["https://rpc.testnet.arc.io", "https://rpc.drpc.testnet.arc.io", "https://rpc.blockdaemon.testnet.arc.io", "https://rpc.quicknode.testnet.arc.io"] },
  "arc-mainnet": { chain: arc, explorer: "https://explorer.arc.io",
    rpcs: ["https://rpc.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io"] },
};

/** Load the treasurer's key from a 0600 file, creating it on first use. Never printed. */
export function loadAccount(path) {
  if (!existsSync(path)) writeFileSync(path, generatePrivateKey() + "\n", { mode: 0o600 });
  return privateKeyToAccount(readFileSync(path, "utf8").trim());
}

export function clients(network, account) {
  const n = NETWORKS[network];
  if (!n) throw new Error(`unknown network ${network}`);
  const transport = fallback(n.rpcs.map((u) => http(u, { retryCount: 1 })), { rank: false, retryCount: 2 });
  return { pub: createPublicClient({ chain: n.chain, transport }), wallet: account ? createWalletClient({ chain: n.chain, transport, account }) : null, explorer: n.explorer };
}

export const usdcBalance = (pub, address) => pub.readContract({ address: USDC_ARC, abi: erc20Abi, functionName: "balanceOf", args: [address] }).then(Number);

/** Memo id = hash of the action id: the same action can be found on-chain and never paid twice. */
export const memoIdFor = (actionId) => keccak256(stringToHex(`tamias:${actionId}`));

/** Pay `micro` USDC to `to`, wrapped in a Memo carrying `note`. Returns the on-chain witness. */
export async function payWithMemo({ pub, wallet }, { to, micro, actionId, note }) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, BigInt(micro)] });
  const memoId = memoIdFor(actionId);
  const hash = await wallet.writeContract({ address: MEMO, abi: MEMO_ABI, functionName: "memo", args: [USDC_ARC, data, memoId, toHex(JSON.stringify(note).slice(0, 512))] });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (rc.status !== "success") throw new Error(`Arc transaction ${hash} reverted`);
  return witnessFromReceipt(pub, rc, to, micro);
}

// Arc's native USDC emits Transfer with 18 decimals, while the ERC-20 view (balanceOf,
// transfer) speaks 6. Measured on the first live payment: 0.05 USDC came back as 5e16.
// The event is normalized to micro-USDC and must equal what was sent, or nothing is booked.
export function toMicroFromEvent(value, expectedMicro) {
  const v = BigInt(value), m = BigInt(expectedMicro);
  if (v === m) return expectedMicro;
  if (v === m * 10n ** 12n) return expectedMicro;
  throw new Error(`Transfer event amount ${v} matches neither ${m} (6 decimals) nor ${m * 10n ** 12n} (18 decimals)`);
}

/** Turn a settled Arc receipt into the ledger witness (used after paying, and to recover). */
export async function witnessFromReceipt(pub, rc, to, micro) {
  const memos = parseEventLogs({ abi: MEMO_ABI, logs: rc.logs, eventName: "Memo" });
  const transfers = parseEventLogs({ abi: erc20Abi, logs: rc.logs, eventName: "Transfer" }).filter((l) => l.args.to.toLowerCase() === to.toLowerCase());
  if (!memos.length || !transfers.length) throw new Error(`Arc transaction ${rc.transactionHash} has no Memo + Transfer pair`);
  const block = await pub.getBlock({ blockNumber: rc.blockNumber });
  return { tx: rc.transactionHash, block: Number(rc.blockNumber), date: new Date(Number(block.timestamp) * 1000).toISOString(),
    memoId: memos[0].args.memoId, memoIndex: Number(memos[0].args.memoIndex), transferred: toMicroFromEvent(transfers[0].args.value, micro), logIndex: transfers[0].logIndex,
    // Gas on Arc is paid in USDC (18-decimal native units): it is a real expense, booked as such.
    gasMicro: Number((BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? 0n) + 10n ** 12n - 1n) / 10n ** 12n) }; // rounded up, like the 6-decimal balance view
}

/** The Memo log of an action already paid on-chain, or null.
 *  The public Arc RPC refuses log ranges above a few thousand blocks (measured: 10 000 fails,
 *  2 000 works). An earlier version caught that error and returned "not paid", which made the
 *  double-payment guard blind. Now the window is scanned in 2 000-block chunks, and any RPC
 *  failure THROWS: when the treasurer cannot prove an action was not paid, it does not pay. */
export async function paidLog(pub, sender, actionId, fromBlock, { chunk = 2000n, parallel = 2 } = {}) {
  const head = await pub.getBlockNumber();
  const ranges = [];
  for (let from = BigInt(fromBlock); from <= head; from += chunk) ranges.push([from, from + chunk - 1n > head ? head : from + chunk - 1n]);
  const args = { sender, memoId: memoIdFor(actionId) };
  for (let i = 0; i < ranges.length; i += parallel) {
    const batch = await Promise.all(ranges.slice(i, i + parallel).map(async ([a, b]) => {
      for (let t = 0; ; t++) {
        try { return await pub.getLogs({ address: MEMO, event: MEMO_ABI[1], args, fromBlock: a, toBlock: b }); }
        catch (e) { if (t < 4) { await new Promise((r) => setTimeout(r, 400 * 2 ** t)); continue; } throw new Error(`cannot read Arc logs ${a}-${b}: ${e.shortMessage || e.message}; refusing to pay without proof`); }
      }
    }));
    const hit = batch.flat()[0];
    if (hit) return hit;
  }
  return null;
}
