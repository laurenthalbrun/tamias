// Chain witness through Coinbase's CDP SQL index (decoded Base events, ~2 s behind the head).
//
// Why: on 16 October 2026 base.blockscout.com started answering our requests with a Cloudflare
// bot challenge (HTTP 403). Every sync failed. CDP indexes the same events with the same log
// index, so document ids (`base:<tx>:<logIndex>`) stay identical and nothing is booked twice.
// Blockscout stays the fallback when no CDP key is configured.

import { generateJwt } from "@coinbase/cdp-sdk/auth";

const HOST = "api.cdp.coinbase.com";
const PATH = "/platform/v2/data/query/run";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const START = "2026-07-21T00:00:00Z";
// One query may not scan too much: 30 days pass, the whole history does not (measured 16/10/2026).
const WINDOW_DAYS = 20;
const PAGE = 5000;

export const cdpAvailable = () => !!(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);

const addr = (a) => {
  const s = String(a || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(s)) throw new Error(`invalid address: ${a}`);
  return s;
};

async function query(sql) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const jwt = await generateJwt({ apiKeyId: process.env.CDP_API_KEY_ID, apiKeySecret: process.env.CDP_API_KEY_SECRET,
        requestMethod: "POST", requestHost: HOST, requestPath: PATH, expiresIn: 120 });
      const r = await fetch(`https://${HOST}${PATH}`, { method: "POST", signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify({ sql }) });
      const text = await r.text();
      if (r.ok) return JSON.parse(text).result ?? [];
      last = new Error(`cdp sql ${r.status}: ${text.slice(0, 200)}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
    await new Promise((s) => setTimeout(s, 800 * (i + 1)));
  }
  // Fail closed: an unreadable chain is an error, never an empty list.
  throw last;
}

/** USDC transfers on Base to or from `address` since `since`, newest first, every window read. */
export async function usdcTransfers({ to, from, since, limit } = {}) {
  if (!to === !from) throw new Error("usdcTransfers: give to OR from");
  const filter = to ? `parameters['to']::String = '${addr(to)}'` : `parameters['from']::String = '${addr(from)}'`;
  const start = new Date(since || START).getTime();
  const max = Number(limit) > 0 ? Math.floor(Number(limit)) : Infinity;
  const rows = [];
  for (let end = Date.now() + 60_000; end > start && rows.length < max; end -= WINDOW_DAYS * 864e5) {
    const begin = Math.max(start, end - WINDOW_DAYS * 864e5);
    for (let offset = 0; rows.length < max; offset += PAGE) {
      const size = Math.min(PAGE, max - rows.length);
      const page = await query(
        `SELECT block_timestamp, transaction_hash, log_index, parameters['from']::String AS f, parameters['to']::String AS t, parameters['value']::UInt256 AS v
         FROM base.events
         WHERE address = '${USDC}' AND event_name = 'Transfer' AND ${filter}
           AND block_timestamp >= parseDateTimeBestEffort('${new Date(begin).toISOString()}')
           AND block_timestamp < parseDateTimeBestEffort('${new Date(end).toISOString()}')
         ORDER BY block_timestamp DESC, log_index DESC
         LIMIT ${size} OFFSET ${offset}`);
      rows.push(...page);
      if (page.length < size) break;
    }
  }
  return rows.map((l) => ({
    tx: l.transaction_hash, logIndex: Number(l.log_index), date: new Date(l.block_timestamp).toISOString(),
    from: String(l.f).toLowerCase(), to: String(l.t).toLowerCase(), micro: Number(l.v),
  }));
}
