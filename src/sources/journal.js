// Source 2: the business's own service journal. One row per paid API call, written by the
// x402 server after it settled the payment and served (or failed to serve) the request.
// Columns used: ts, route, status, paid, amount_usd, payer, tx_hash.
export async function paidCalls({ url = process.env.JOURNAL_URL, key = process.env.JOURNAL_KEY, since } = {}) {
  if (!url || !key) return { rows: [], available: false, reason: "JOURNAL_URL / JOURNAL_KEY not set" };
  const rows = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const q = new URLSearchParams({ select: "id,ts,route,status,amount_usd,payer,tx_hash,network", paid: "eq.true", order: "ts.desc", limit: String(page), offset: String(offset) });
    if (since) q.append("ts", `gte.${since}`);
    const r = await fetch(`${url}/rest/v1/api_calls?${q}`, { headers: { apikey: key, authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return { rows, available: false, reason: `journal HTTP ${r.status}` };
    const batch = await r.json();
    rows.push(...batch.map((x) => ({ ...x, payer: x.payer?.toLowerCase() ?? null, tx_hash: x.tx_hash?.toLowerCase() ?? null })));
    if (batch.length < page) break;
  }
  return { rows, available: true };
}
