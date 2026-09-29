// Renders the treasurer's books as one self-contained HTML page (no external scripts), so the
// same file can be opened locally or deployed as the public demo link.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { Ledger, ACCOUNTS as A } from "./ledger.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (m) => ((m || 0) === 0 ? 0 : m / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const jsonl = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const BASESCAN = "https://basescan.org/tx/";

const KIND_LABEL = {
  SETTLEMENT_WITHOUT_JOURNAL: "Payment with no service record",
  JOURNAL_WITHOUT_SETTLEMENT: "Service record with no payment",
  PAID_NOT_DELIVERED: "Paid, service failed",
  AMOUNT_MISMATCH: "Amount differs from price",
  ADDRESS_POISONING: "Address poisoning",
  UNEXPLAINED_OUTFLOW: "Unexplained outflow",
  BALANCE_GAP: "Balance differs from chain",
  ZERO_VALUE_TRANSFER: "Zero-value transfer",
};

export function render(root) {
  const ledger = new Ledger(`${root}data/ledger.jsonl`);
  const state = JSON.parse(readFileSync(`${root}data/state.json`, "utf8"));
  const proposals = existsSync(`${root}data/proposals.json`) ? JSON.parse(readFileSync(`${root}data/proposals.json`, "utf8")) : null;
  const bridge = jsonl(`${root}data/bridge-decisions.jsonl`).at(-1);
  const b = ledger.balances();
  const chainOk = ledger.verifyChain() === null;

  const classes = {};
  for (const e of ledger.entries) classes[e.meta.class] = (classes[e.meta.class] || 0) + (e.postings.find((p) => p.account === A.TREASURY_BASE && p.micro > 0)?.micro ? 1 : 0);
  const count = (c) => ledger.entries.filter((e) => e.meta.class === c).length;
  const settled = count("DELIVERED") + count("UNDELIVERED") + count("UNMATCHED") + count("INTERNAL") + count("POISONING") + count("MISMATCH");
  const funnel = [
    ["Delivered at the offered price", count("DELIVERED"), "ok"],
    ["From our own wallets (not revenue)", count("INTERNAL"), "muted"],
    ["No service record found", count("UNMATCHED"), "warn"],
    ["Paid, service failed (owed back)", count("UNDELIVERED"), "warn"],
    ["Look-alike dust (poisoning)", count("POISONING"), "bad"],
  ];
  const kinds = {};
  for (const x of state.exceptions) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  const payerClasses = {};
  for (const v of Object.values(state.screened)) payerClasses[v.class] = (payerClasses[v.class] || 0) + 1;
  const external = Object.values(state.screened).filter((v) => v.class === "EXTERNAL").length;
  const top = state.concentration[0];

  const kpis = [
    ["Revenue delivered", usd(-(b[A.INCOME_API] || 0)), "USDC, three-way matched"],
    ["Base treasury", usd(b[A.TREASURY_BASE] || 0), "USDC, equal to the chain balance"],
    ["Arc treasury", usd(b[A.TREASURY_ARC] || 0), "USDC"],
    ["Owed back to buyers", usd(-(b[A.UNDELIVERED] || 0)), "USDC, paid and not delivered"],
    ["Unmatched", usd(-(b[A.UNMATCHED] || 0)), "USDC, awaiting explanation"],
  ];

  const decisions = (proposals?.decisions || []).map((d) => {
    const a = d.ok ? d.action : d.proposed;
    const status = !d.ok ? ["Refused", "bad"] : d.needsHuman ? ["Needs owner", "warn"] : ["Allowed", "ok"];
    return `<tr><td><span class="tag ${status[1]}">${status[0]}</span></td><td>${esc(a.kind)}</td><td class="num">${a.amountMicro ? usd(a.amountMicro) : "&nbsp;"}</td><td>${esc(a.subject || a.payee || (a.doc ? short(a.doc.split(":")[1]) : ""))}</td><td class="why">${esc(d.reason)}${a.reason ? `<br><span class="sub">${esc(a.reason)}</span>` : ""}</td></tr>`;
  }).join("");

  const recent = [...ledger.entries].sort((x, y) => y.date.localeCompare(x.date)).slice(0, 12).map((e) => {
    const main = e.postings.find((p) => p.micro > 0);
    const tx = e.meta.tx && /^0x[0-9a-f]{64}$/i.test(e.meta.tx) ? `<a href="${e.meta.network === "arc-mainnet" ? "https://explorer.arc.io/tx/" : e.meta.network === "arc-testnet" ? "https://testnet.arcscan.app/tx/" : e.meta.net === "mainnet" && e.doc.startsWith("cctp:mint") ? "https://explorer.arc.io/tx/" : BASESCAN}${e.meta.tx}">${short(e.meta.tx)}</a>` : "";
    return `<tr><td>${esc(e.date.slice(0, 16).replace("T", " "))}</td><td>${esc(e.memo)}</td><td>${esc(main?.account)}</td><td class="num">${usd(main?.micro || 0)}</td><td>${tx}</td><td class="mono">${esc(e.id.slice(0, 8))}</td></tr>`;
  }).join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tamias Treasury</title><link rel="icon" href="data:,">
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#0b1f3a;--sub:#5b6b82;--line:#e3e7ee;--navy:#0b2a5b;--ok:#0f7a4f;--okbg:#e7f5ee;--warn:#9a5b00;--warnbg:#fdf3e1;--bad:#b42318;--badbg:#fdecea;--mutedbg:#eef1f5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b1220;--card:#111a2b;--ink:#e8edf5;--sub:#9aa8bd;--line:#223049;--navy:#8fb3ff;--okbg:#10301f;--warnbg:#33260d;--badbg:#3a1512;--mutedbg:#1a2436;--ok:#5fd39c;--warn:#f0b75a;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
header{background:var(--navy);color:#fff;padding:28px 16px}header .in,main{max-width:1120px;margin:0 auto}
@media (prefers-color-scheme:dark){header{background:#0f2247}}
h1{margin:0;font-size:22px;font-weight:650;letter-spacing:-.01em}header p{margin:6px 0 0;opacity:.85;font-size:14px}
main{padding:24px 16px 48px}h2{font-size:15px;font-weight:650;margin:32px 0 12px;text-transform:uppercase;letter-spacing:.06em;color:var(--sub)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.kpi .v{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums}.kpi .l{font-size:13px;color:var(--sub)}.kpi .s{font-size:12px;color:var(--sub)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:760px){.grid2{grid-template-columns:1fr}}
.bar{display:grid;grid-template-columns:1fr auto;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);gap:12px}.bar.m{grid-template-columns:minmax(0,1fr) 140px 56px}.bar:last-child{border:0}
.meter{height:8px;background:var(--mutedbg);border-radius:4px;overflow:hidden}.meter i{display:block;height:100%}
.ok i,.meter .ok{background:var(--ok)}.meter .warn{background:var(--warn)}.meter .bad{background:var(--bad)}.meter .muted{background:var(--sub)}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.tag.ok{background:var(--okbg);color:var(--ok)}.tag.warn{background:var(--warnbg);color:var(--warn)}.tag.bad{background:var(--badbg);color:var(--bad)}.tag.muted{background:var(--mutedbg);color:var(--sub)}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--sub);font-weight:600;text-transform:uppercase;letter-spacing:.04em}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--sub)}.why{max-width:460px}.sub{color:var(--sub);font-size:13px}
a{color:var(--navy)}.note{color:var(--sub);font-size:13px;margin-top:8px}.big{font-size:15px}
</style></head><body>
<header><div class="in"><h1>Tamias, the treasurer of an autonomous API business</h1>
<p>AI agents pay this business per call in USDC on Base. Tamias keeps the books, checks every payer, and moves money on Arc only inside a written policy.</p></div></header>
<main>
<div class="kpis">${kpis.map(([l, v, s]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join("")}</div>
<p class="note">Synced ${esc(state.syncedAt.slice(0, 16).replace("T", " "))} UTC from ${state.settlements} Base settlements and ${state.journalRows} service records since ${esc(state.since.slice(0, 10))}. Ledger: ${ledger.entries.length} entries, hash chain <strong>${chainOk ? "intact" : "BROKEN"}</strong>.</p>

<h2>Three-way match</h2>
<div class="grid2">
<div class="card">${funnel.map(([l, n, c]) => `<div class="bar m"><span>${l}</span><span class="meter"><i class="${c}" style="width:${settled ? Math.max(2, (n / settled) * 100) : 0}%"></i></span><strong class="num">${n}</strong></div>`).join("")}
<p class="note">A payment is revenue only when the chain, the price and a delivered call agree.</p></div>
<div class="card">${Object.entries(kinds).map(([k, n]) => `<div class="bar"><span>${esc(KIND_LABEL[k] || k)}</span><strong class="num">${n}</strong></div>`).join("") || "<p>No exceptions.</p>"}
<p class="note">Exceptions are booked to named accounts, never hidden in expenses.</p></div>
</div>

<h2>Who is paying</h2>
<div class="grid2">
<div class="card">${Object.entries(payerClasses).map(([k, n]) => `<div class="bar"><span>${esc(k)}</span><strong class="num">${n}</strong></div>`).join("")}
<p class="note">Each payer is traced one hop back to whoever funded it. Wallets funded by us or by a seller are never counted as customers and never refunded.</p></div>
<div class="card"><div class="big">${top ? `<strong>${top.payers} of ${external}</strong> external paying wallets are funded by the same address, <span class="mono">${esc(short(top.funder))}</span>.` : "No shared funder among payers."}</div>
<p class="note">Revenue that looks like ${external} customers depends on ${top ? "one operator" : "independent buyers"}. The agent flags it for the owner.</p></div>
</div>

<h2>Agent decisions</h2>
<div class="card scroll">${proposals ? `<p class="sub" style="margin-top:0">Plan by ${esc(proposals.by)}${proposals.model ? ` (${esc(proposals.model)})` : ""} on ${esc(proposals.network)}. ${esc(proposals.summary)}</p>
<table><thead><tr><th>Policy</th><th>Action</th><th class="num">USDC</th><th>Subject</th><th>Reason</th></tr></thead><tbody>${decisions}</tbody></table>` : "<p>No proposals yet.</p>"}
<p class="note">The model proposes; a deterministic policy decides. Payees come only from a human-edited vendor list, amounts are capped per action and per day, and anything above the threshold waits for the owner.</p></div>

<h2>Base to Arc sweep</h2>
<div class="card">${bridge ? `<div class="big">${esc(bridge.reason)}</div><p class="note">Checked ${esc(bridge.at.slice(0, 16).replace("T", " "))} UTC. Base balance ${usd(bridge.baseMicro)} USDC. The sweep batches revenue until the CCTP cost stays under the policy ceiling, and keeps a reserve on Base for refunds.</p>` : "<p>No sweep decision yet.</p>"}</div>

<h2>Latest ledger entries</h2>
<div class="card scroll"><table><thead><tr><th>Date (UTC)</th><th>Memo</th><th>Debit</th><th class="num">USDC</th><th>Tx</th><th>Entry</th></tr></thead><tbody>${recent}</tbody></table></div>
</main></body></html>`;
  mkdirSync(`${root}site`, { recursive: true });
  writeFileSync(`${root}site/index.html`, html);
  return `${root}site/index.html`;
}
