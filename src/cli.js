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
import { evaluate } from "./policy.js";
import { briefing, propose as agentPropose } from "./agent.js";
import { loadAccount, clients, usdcBalance, payWithMemo, alreadyPaid } from "./arc.js";
import { ACCOUNTS as A, toMicro } from "./ledger.js";
import { appendFileSync } from "node:fs";

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

const POLICY = () => JSON.parse(readFileSync(`${ROOT}config/policy.json`, "utf8"));
const PROPOSALS = `${ROOT}data/proposals.json`;
const APPROVALS = `${ROOT}data/approvals.jsonl`;
const KEY = `${ROOT}.arc-treasury.secret`;
const network = () => (flag("mainnet") ? "arc-mainnet" : POLICY().network);
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const MOVES = ["REFUND", "TOPUP", "SWEEP"];

function spentToday(ledger) {
  const day = new Date().toISOString().slice(0, 10);
  return ledger.entries.filter((e) => MOVES.includes(e.meta.kind) && e.date.startsWith(day)).reduce((s, e) => s + (e.meta.amountMicro || 0), 0);
}

/** Bring the Arc treasury into the books: the chain balance is the bank statement. */
async function arcContext(ledger, policy) {
  const account = loadAccount(KEY);
  const c = clients(network(), account);
  const onChain = await usdcBalance(c.pub, account.address);
  const booked = ledger.balances()[A.TREASURY_ARC] || 0;
  if (onChain !== booked) {
    // Loud repair: an unexplained difference is posted to a named account, never hidden.
    const diff = onChain - booked;
    ledger.post({ doc: `arc:balance:${network()}:${Date.now()}`, date: new Date().toISOString(), memo: diff > 0 ? "deposit to the Arc treasury seen on-chain" : "Arc treasury lower than the books",
      postings: [{ account: A.TREASURY_ARC, micro: diff }, { account: diff > 0 ? "Equity:OwnerFunding" : "Imbalance:ArcBalance", micro: -diff }], meta: { class: "ARC_BALANCE", network: network() } });
  }
  const payeeBalances = {};
  for (const p of policy.payees) if (!/^0x0{40}$/.test(p.address)) payeeBalances[p.address.toLowerCase()] = await usdcBalance(c.pub, p.address);
  return { account, c, treasuryMicro: onChain, payeeBalances };
}

async function proposeCmd() {
  const ledger = new Ledger(LEDGER);
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const policy = POLICY();
  const { treasuryMicro, payeeBalances, account } = await arcContext(ledger, policy);
  const brief = briefing({ ledger, state, policy, treasuryMicro, payeeBalances });
  const plan = await agentPropose(brief);
  const executedIds = new Set(ledger.entries.map((e) => e.meta.actionId).filter(Boolean));
  let spent = spentToday(ledger);
  const decisions = plan.actions.map((a) => {
    const d = evaluate(a, { policy, ledger, screened: state.screened, spentToday: spent, treasuryMicro, balances: payeeBalances, executedIds });
    if (d.ok) spent += d.action.amountMicro;
    return { proposed: a, ...d };
  });
  const out = { at: new Date().toISOString(), network: network(), treasury: account.address, treasuryMicro, by: plan.by, model: plan.model ?? null, summary: plan.summary, decisions };
  writeFileSync(PROPOSALS, JSON.stringify(out, null, 2));
  console.log(`treasury ${account.address} on ${network()}: ${usd(treasuryMicro)}`);
  console.log(`plan by ${plan.by}${plan.model ? ` (${plan.model})` : ""}: ${plan.summary}`);
  for (const d of decisions) {
    const a = d.ok ? d.action : d.proposed;
    console.log(`  ${d.ok ? (d.needsHuman ? "NEEDS OWNER" : "ALLOWED    ") : "REFUSED    "} ${a.kind.padEnd(6)} ${a.amountMicro ? usd(a.amountMicro).padStart(16) : "".padStart(16)}  ${d.ok ? (a.id?.slice(0, 8) ?? "") : ""}  ${d.reason}${a.reason ? ` | ${a.reason}` : ""}`);
  }
}

function approveCmd() {
  const id = process.argv[3];
  if (!id) return console.log("usage: tamias approve <action-id-prefix>");
  const p = JSON.parse(readFileSync(PROPOSALS, "utf8"));
  const d = p.decisions.find((x) => x.ok && x.action.id.startsWith(id));
  if (!d) return console.log(`no allowed action starting with ${id}`);
  appendFileSync(APPROVALS, JSON.stringify({ id: d.action.id, approvedAt: new Date().toISOString(), by: process.env.USER, action: d.action }) + "\n");
  console.log(`approved ${d.action.id}: ${d.action.kind} ${usd(d.action.amountMicro)} to ${d.action.to}`);
}

async function executeCmd() {
  const ledger = new Ledger(LEDGER);
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const policy = POLICY();
  const p = JSON.parse(readFileSync(PROPOSALS, "utf8"));
  if (p.network !== network()) throw new Error(`proposals were made for ${p.network}, not ${network()}: run propose again`);
  const approved = new Set(readJsonl(APPROVALS).map((a) => a.id));
  const { account, c, treasuryMicro, payeeBalances } = await arcContext(ledger, policy);
  const executedIds = new Set(ledger.entries.map((e) => e.meta.actionId).filter(Boolean));
  let spent = spentToday(ledger), treasury = treasuryMicro;
  const fromBlock = BigInt(Math.max(0, Number(await c.pub.getBlockNumber()) - 150_000));
  for (const d of p.decisions.filter((x) => x.ok)) {
    // Re-evaluate against the current state: the proposal file is input, not authority.
    const again = evaluate(d.action.kind === "REFUND" ? { ...d.action } : { ...d.action, payee: d.action.payee }, { policy, ledger, screened: state.screened, spentToday: spent, treasuryMicro: treasury, balances: payeeBalances, executedIds });
    if (!again.ok) { console.log(`skip ${d.action.id.slice(0, 8)}: ${again.reason}`); continue; }
    const a = again.action;
    if (a.kind === "FLAG") { appendFileSync(`${ROOT}data/flags.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...a }) + "\n"); console.log(`flag   ${a.subject}`); continue; }
    if (again.needsHuman && !approved.has(a.id)) { console.log(`wait   ${a.id.slice(0, 8)} ${a.kind} ${usd(a.amountMicro)}: above the approval threshold, run \`tamias approve ${a.id.slice(0, 8)}\``); continue; }
    if (!flag("yes")) { console.log(`dry    ${a.id.slice(0, 8)} ${a.kind} ${usd(a.amountMicro)} -> ${a.to} (add --yes to send)`); continue; }
    const paid = await alreadyPaid(c.pub, account.address, a.id, fromBlock);
    if (paid === true) { console.log(`skip   ${a.id.slice(0, 8)}: memo already on-chain, not paying twice`); continue; }
    const note = { app: "tamias", action: a.id, kind: a.kind, doc: a.doc, payee: a.payee, reason: a.reason };
    const w = await payWithMemo(c, { to: a.to, micro: a.amountMicro, actionId: a.id, note });
    const debit = a.kind === "REFUND" ? A.UNDELIVERED : a.kind === "SWEEP" ? A.RESERVE_ARC : `Assets:Arc:Payee:${a.payee}`;
    ledger.post({ doc: `arc:${w.tx}:${w.logIndex}`, date: w.date, memo: `${a.kind} ${a.payee ?? a.doc}: ${a.reason}`,
      postings: [{ account: debit, micro: w.transferred }, { account: A.TREASURY_ARC, micro: -w.transferred }],
      meta: { class: "ARC_PAYMENT", kind: a.kind, actionId: a.id, amountMicro: w.transferred, to: a.to, tx: w.tx, memoId: w.memoId, network: network() } });
    spent += w.transferred; treasury -= w.transferred; executedIds.add(a.id);
    console.log(`paid   ${a.kind} ${usd(w.transferred)} -> ${a.to}  ${c.explorer}/tx/${w.tx}`);
  }
}

const cmd = process.argv[2];
const run = { sync, report, propose: proposeCmd, approve: approveCmd, execute: executeCmd }[cmd];
if (!run) { console.log("usage: tamias sync|report|propose|execute"); process.exit(2); }
await run();
