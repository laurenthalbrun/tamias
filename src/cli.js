#!/usr/bin/env node
// tamias: command line.
//   sync     read chain + journal, three-way match, post to the ledger, screen payers
//   report   balances, exceptions and customer concentration, from the ledger on disk
//   propose  ask the agent for treasury actions, validated by the policy (never executed here)
//   execute  run approved actions on Arc (testnet unless --mainnet), each with an on-chain memo
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { Ledger, fromMicro } from "./ledger.js";
import { settlements, settlementFromReceipt } from "./sources/base.js";
import { paidCalls } from "./sources/journal.js";
import { reconcile } from "./reconcile.js";
import { Screener } from "./counterparty.js";

const ROOT = new URL("..", import.meta.url).pathname;
const cfg = JSON.parse(readFileSync(`${ROOT}config/business.json`, "utf8"));
const LEDGER = `${ROOT}data/ledger.jsonl`;
const STATE = `${ROOT}data/state.json`;
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const usd = (m) => `${fromMicro(m)} USDC`;

async function sync() {
  const since = arg("since", cfg.since);
  const [chain, journal] = await Promise.all([
    settlements(cfg.payTo, { since }),
    paidCalls({ since }),
  ]);
  if (!journal.available) console.warn(`journal unavailable (${journal.reason}): every settlement will be unmatched`);
  // Journal rows whose tx the indexer did not return get a second witness: the Base node.
  const onChain = new Set(chain.items.map((s) => s.tx));
  let recovered = 0;
  for (const row of journal.rows) {
    if (!row.tx_hash || onChain.has(row.tx_hash) || (row.network && row.network !== "eip155:8453")) continue;
    const w = await settlementFromReceipt(row.tx_hash, cfg.payTo);
    if (w.found) { chain.items.push(w.settlement); onChain.add(row.tx_hash); recovered++; }
  }
  if (recovered) console.log(`recovered ${recovered} settlements the indexer missed, confirmed by a Base node`);
  const { entries, exceptions } = reconcile({ settlements: chain.items, calls: journal.rows, ourWallets: cfg.ourWallets, knownAddresses: cfg.knownAddresses || [] });
  const ledger = new Ledger(LEDGER, { lockedBefore: cfg.lockedBefore });
  let posted = 0, dup = 0;
  for (const e of entries.sort((a, b) => a.date.localeCompare(b.date))) {
    const r = ledger.post(e);
    r.status === "posted" ? posted++ : dup++;
  }
  // Screen every external payer seen in this window.
  const screener = new Screener({ ourWallets: cfg.ourWallets, sellerWallets: cfg.sellerWallets || [] });
  const payers = [...new Set(entries.filter((e) => ["DELIVERED", "UNDELIVERED", "MISMATCH", "UNMATCHED"].includes(e.meta.class)).map((e) => e.meta.payer))];
  const screened = new Map();
  for (const p of payers) screened.set(p, await screener.screen(p));
  const state = { syncedAt: new Date().toISOString(), since, chainComplete: chain.complete, settlements: chain.items.length, journalRows: journal.rows.length,
    posted, duplicates: dup, exceptions, screened: Object.fromEntries(screened), concentration: Screener.concentration(screened) };
  mkdirSync(`${ROOT}data`, { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`read ${chain.items.length} settlements${chain.complete ? "" : " (pagination cap: floor)"} and ${journal.rows.length} journal rows since ${since}`);
  console.log(`posted ${posted} entries, ${dup} already in the ledger, ${exceptions.length} exceptions, ${payers.length} payers screened`);
}

function report() {
  if (!existsSync(STATE)) return console.log("nothing synced yet: run `tamias sync`");
  const ledger = new Ledger(LEDGER);
  const s = JSON.parse(readFileSync(STATE, "utf8"));
  const broken = ledger.verifyChain();
  console.log(`ledger: ${ledger.entries.length} entries, hash chain ${broken ? `BROKEN at ${broken.id}` : "intact"}`);
  for (const [acct, m] of Object.entries(ledger.balances()).sort()) console.log(`  ${acct.padEnd(36)} ${usd(m).padStart(18)}`);
  const byKind = {};
  for (const x of s.exceptions) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
  console.log(`exceptions:`, byKind);
  const byClass = {};
  for (const v of Object.values(s.screened)) byClass[v.class] = (byClass[v.class] || 0) + 1;
  console.log(`payers by class:`, byClass);
  if (s.concentration.length) console.log(`concentration: ${s.concentration.map((c) => `${c.funder.slice(0, 10)}… funds ${c.payers} payers`).join("; ")}`);
}

const cmd = process.argv[2];
const run = { sync, report }[cmd];
if (!run) { console.log("usage: tamias sync|report|propose|execute"); process.exit(2); }
await run();
