# Tamias

**An AI treasurer for a business that AI agents pay.**

Tamias (ταμίας, Greek for treasurer) runs the money side of a real, live API business: [api.x-402.online](https://api.x-402.online), where AI agents buy data and tools per call in USDC over the x402 protocol on Base. It keeps double-entry books from the chain and checks who is really paying. Money moves on Arc only inside a policy a human wrote.

Built for the [Tameion Agents Hackathon](https://tameion.thecanteenapp.com/) (Canteen × Circle). Everything below runs against production data, not a mock.

## The problem

An x402 business gets paid by wallets, not by customers. After two months of running one, we learned three things the hard way:

- **The payment and the service can disagree.** Our own service journal went down for hours on three separate days. Money kept arriving on-chain with nothing recording what it paid for. The chain indexer we relied on also silently missed 32 real settlements.
- **Wallet counts lie.** Twelve "customers" turned out to be mostly one operator funding seven agent wallets. Elsewhere on the rail, sellers fund the wallets that buy from them.
- **The history is hostile.** Our payTo wallet received dust and two fake zero-value "transfers" from addresses that imitate wallets we actually pay. Copy a payee from the history and you pay an attacker.

A ledger that balances catches none of this. Canteen's [Agents and Ledgers](https://thecanteenapp.com/analysis/2026/09/12/agents-and-ledgers.html) makes the same point about accounting agents in general. Tamias is our answer for this one business.

## What it does

```
  Base (where buyers pay)                      Arc (where the treasury operates)
  ─────────────────────────                    ──────────────────────────────────
  USDC settlements ──┐                          ┌─> Memo contract: every payment
  service journal ───┼─> three-way match ──> ledger     carries its ledger reference
  Base node (witness)┘        │                 │   ─> receipt read back as witness
                              v                 │
                    payer screening        agent proposes ──> policy decides
                   (who funded this?)       (DeepSeek or        (deterministic,
                                             rule-based)         caps, vendor list,
                                                                 owner approval)
                                                  │
                     Circle CCTP (Bridge Kit) <───┘  sweep Base revenue to Arc
                                                     only when fees stay under a ceiling
```

1. **Three-way match.** A settlement counts as revenue only when the chain, the offered price and a delivered call agree. Everything else goes to a named account: paid but failed (owed back to the buyer), no service record, amount mismatch, look-alike dust.
2. **Two witnesses for the chain.** Settlements come from Blockscout. Any service record without a settlement is checked directly against a Base node before being called fictitious. That is how the 32 missed settlements were recovered.
3. **Books equal to the bank statement.** The payTo wallet's on-chain balance is read from a node. The first gap becomes the opening balance; any later gap is booked to a visible imbalance account and raised.
4. **Payer screening.** Every payer is traced one hop back to whoever funded it with USDC. Our own wallets, wallets funded by us, and wallets funded by a known seller are never counted as customers and never refunded. Shared funders are reported as customer concentration.
5. **An agent that proposes, a policy that decides.** The agent reads a summary of the books and proposes refunds, top-ups, sweeps or flags. Its output is input only: `src/policy.js` re-derives every amount from the ledger, pays only payees from a human-edited vendor list, enforces per-action and daily caps and a minimum float, and holds anything above the approval threshold for the owner. If the model is unavailable, a rule-based planner takes over.
6. **Payments on Arc with an on-chain memo.** Each payment goes through Arc's `Memo` contract. The memo id is derived from the action id, so an action already paid is found on-chain and never paid twice, even after a crash. The receipt is read back and becomes the ledger entry.
7. **Fee-aware sweeps.** Revenue accrues on Base. Tamias batches it and bridges it to the Arc treasury through Circle CCTP (Bridge Kit) only when the full cost, gas on both sides included, stays under `maxFeeBps`, and always leaves a reserve on Base for refunds. The burn and the mint are booked around an in-transit account, so money between chains is never invisible.

## Results on production data

Books since 1 September 2026, read from Base and from the business's service journal:

| | |
|---|---|
| Settlements booked | 534, each tied to its transaction |
| Revenue delivered (three-way matched) | 1.643109 USDC |
| From our own wallets, excluded from revenue | 3.544604 USDC |
| Settlements with no service record | 143 (journal outages on 18, 21 and 22 September) |
| Settlements the indexer missed, recovered from a Base node | 32 |
| Address poisoning attempts | 3 |
| External paying wallets | 13, of which 7 are funded by the same operator |
| Base treasury, books vs chain | 2.924833 USDC on both |
| Ledger | 538 entries, hash chain intact |

Today's sweep decision: bridge 2.724833 USDC to Arc at 91 bps, keeping 0.20 USDC on Base. The amounts are small because the business is small. The controls do not depend on the amounts.

## Controls, mapped to the failure modes

| Failure | Control in Tamias |
|---|---|
| Retry pays twice | Document id is the idempotency key in the ledger; memo id on Arc is checked on-chain before paying |
| Payee substitution | Agent can only name a payee id; addresses live in `config/policy.json`, edited by a human |
| Fictitious entry | Service records without a settlement are refused until a Base node confirms them |
| Omission | Settlements without a service record are booked to `Imbalance:UnmatchedSettlement`, never dropped |
| Editing history | Each entry hashes the previous one; `tamias report` verifies the chain |
| Back-dated entry | Period lock rejects entries before `lockedBefore` |
| Model overreach | Model output is re-evaluated by a deterministic policy; caps, float and approval threshold apply |
| Silent source failure | A failed source is reported and the balance check is skipped, instead of booking a false gap |

## Circle stack used

- **Arc** mainnet and testnet: native USDC (ERC-20 interface at `0x3600…0000`), `Memo` contract `0x5294E9927c3306DcBaDb03fe70b92e01cCede505`.
- **CCTP** through `@circle-fin/bridge-kit` and `@circle-fin/adapter-viem-v2`, Base to Arc, with fee estimates before every decision.
- **USDC** on Base as the business's revenue rail, via x402.

## Run it

```bash
npm install
cp .env.example .env            # JOURNAL_URL, JOURNAL_KEY, optional LLM_API_KEY
node --env-file=.env src/cli.js sync        # read chain + journal, match, post, screen payers
node src/cli.js report                      # balances, exceptions, concentration, hash check
node --env-file=.env src/cli.js propose     # agent proposes, policy decides
node --env-file=.env src/cli.js execute     # dry run; add --yes to pay on Arc
node --env-file=.env src/cli.js bridge      # fee-aware Base to Arc sweep decision
node src/cli.js dashboard                   # writes site/index.html
npm test                                    # 18 tests, no network
```

The treasurer's Arc key is created on first use in `.arc-treasury.secret` (mode 0600) and never printed. The bridge stays disabled until the owner sets `bridge.enabled` and points `bridge.sourceKeyPath` at the payTo wallet key.

## Status

Built and running: books, matching, witnesses, screening, policy, agent, Arc payment path, CCTP decision, dashboard, tests.

Not yet done at the time of writing: the Arc treasury has not been funded, so no payment has been executed on Arc yet, and the owner has not enabled the live sweep. This section will be updated with transaction links when that happens.

## License

MIT
