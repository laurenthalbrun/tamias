// Arc execution. Every USDC payment goes through Arc's Memo contract, so the transfer carries
// the ledger reference on-chain: anyone reading Arc can tie the payment to the entry that
// justified it, and the treasurer reads its own receipts back as the external witness.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, encodeFunctionData, erc20Abi, parseEventLogs, keccak256, stringToHex, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

export const USDC_ARC = "0x3600000000000000000000000000000000000000"; // ERC-20 view of native USDC, 6 decimals
export const MEMO = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
const MEMO_ABI = [
  { type: "function", name: "memo", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }, { name: "memoId", type: "bytes32" }, { name: "memoData", type: "bytes" }], outputs: [] },
  { type: "event", name: "Memo", anonymous: false, inputs: [{ name: "sender", type: "address", indexed: true }, { name: "target", type: "address", indexed: true }, { name: "callDataHash", type: "bytes32", indexed: false }, { name: "memoId", type: "bytes32", indexed: true }, { name: "memo", type: "bytes", indexed: false }, { name: "memoIndex", type: "uint256", indexed: false }] },
];

export const NETWORKS = {
  "arc-testnet": { chain: { ...arcTestnet, rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } } }, explorer: "https://testnet.arcscan.app" },
  "arc-mainnet": { chain: arc, explorer: "https://explorer.arc.io" },
};

/** Load the treasurer's key from a 0600 file, creating it on first use. Never printed. */
export function loadAccount(path) {
  if (!existsSync(path)) writeFileSync(path, generatePrivateKey() + "\n", { mode: 0o600 });
  return privateKeyToAccount(readFileSync(path, "utf8").trim());
}

export function clients(network, account) {
  const n = NETWORKS[network];
  if (!n) throw new Error(`unknown network ${network}`);
  const transport = http(n.chain.rpcUrls.default.http[0], { retryCount: 3 });
  return { pub: createPublicClient({ chain: n.chain, transport }), wallet: account ? createWalletClient({ chain: n.chain, transport, account }) : null, explorer: n.explorer };
}

export const usdcBalance = (pub, address) => pub.readContract({ address: USDC_ARC, abi: erc20Abi, functionName: "balanceOf", args: [address] }).then(Number);

/** Memo id = hash of the action id: the same action can be found on-chain and never paid twice. */
export const memoIdFor = (actionId) => keccak256(stringToHex(`tamias:${actionId}`));

/** Has this action already been paid on-chain? Reads Memo events from the treasurer. */
export async function alreadyPaid(pub, sender, actionId, fromBlock) {
  const logs = await pub.getLogs({ address: MEMO, event: MEMO_ABI[1], args: { sender, memoId: memoIdFor(actionId) }, fromBlock, toBlock: "latest" }).catch(() => null);
  return logs === null ? null : logs.length > 0;
}

/** Pay `micro` USDC to `to`, wrapped in a Memo carrying `note`. Returns the on-chain witness. */
export async function payWithMemo({ pub, wallet }, { to, micro, actionId, note }) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, BigInt(micro)] });
  const memoId = memoIdFor(actionId);
  const hash = await wallet.writeContract({ address: MEMO, abi: MEMO_ABI, functionName: "memo", args: [USDC_ARC, data, memoId, toHex(JSON.stringify(note).slice(0, 512))] });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (rc.status !== "success") throw new Error(`Arc transaction ${hash} reverted`);
  const memos = parseEventLogs({ abi: MEMO_ABI, logs: rc.logs, eventName: "Memo" });
  const transfers = parseEventLogs({ abi: erc20Abi, logs: rc.logs, eventName: "Transfer" }).filter((l) => l.args.to.toLowerCase() === to.toLowerCase());
  if (!memos.length || !transfers.length) throw new Error(`Arc transaction ${hash} settled without the expected Memo and Transfer events`);
  const block = await pub.getBlock({ blockNumber: rc.blockNumber });
  return { tx: hash, block: Number(rc.blockNumber), date: new Date(Number(block.timestamp) * 1000).toISOString(),
    memoId, memoIndex: Number(memos[0].args.memoIndex), transferred: Number(transfers[0].args.value), logIndex: transfers[0].logIndex };
}
