# Proposal: what this repo still owes season 1

Status: proposed 2026-10-29, from the cross-repo TODO in
`pauli-swap-interface/TODO.md`. Season 1 ends 2026-11-25 17:27 UTC
(`endsAt` 1795627668, after the devnet was regenerated on 2026-10-28).

Where things stand on 2026-10-29:

- `PauliPredictXP`, `PredictMarket` and `QrlFaucet` are deployed on the
  regenerated devnet (`deployments/devnet.json`, `deployments/faucet-devnet.json`).
- Faucet and attester run 24/7 on the chain host (docker compose under
  systemd, restart `unless-stopped`, rotated logs, `data/` on a host volume).
  The ops repo `Servers/OracleCloud/PauliSwap` deploys them.
- The interface has owner-only tools (New market, Resolve Yes / No, Cancel),
  shown when the connected wallet is `PredictMarket.owner()`.
- The test markets below were created with a one-off script, not with tooling
  from this repo.

## 1. Market admin CLI (TODO 1.1)

The interface tools need a browser wallet holding the owner key. A CLI is
still needed for scripted runs and for the season-end steps.

- [ ] `scripts/qrvm/market.js` with `create`, `resolve`, `cancel`, `list`:
      dry run unless `--send`, signs with `DEPLOYER_MNEMONIC` (the owner),
      checks `owner()` before sending. `create` checks
      `block.timestamp < closeTime <= seasonEndsAt()` up front, because the
      contract only says `PM: close` / `PM: past season`.
- [ ] npm scripts `market:create`, `market:resolve`, `market:cancel`,
      `market:list`.
- [ ] `season:close` in the same script (dry run by default): reads the
      snapshot from the indexer's `predict:snapshot` and calls
      `closeSeason(snapshotBlock, winners)`.

## 2. Market schedule (TODO 1.1: record it in the README)

Created 2026-10-29 by the owner `Qa1A64D6E7…34Ca` in blocks 1860 to 1863, each
seeded with 100 XP.
Every question can be checked on chain.

| # | Closes (UTC) | Question | How to resolve |
| --- | --- | --- | --- |
| 0 | 2026-10-30 12:00 | Will the PauliSwap faucet have sent out at least 500 QRL by Oct 30, 2026 12:00 UTC? | `QrlFaucet` total dripped (`/faucet/status` `totalDrippedPlanck`) at the close block |
| 1 | 2026-11-01 00:00 | Will the QRL devnet pass block 26,000 by Nov 1, 2026 00:00 UTC? | Block number of the last block before the close time |
| 2 | 2026-11-05 00:00 | Will PauliSwap have at least 10 pools (V2 + V3) by Nov 5, 2026 00:00 UTC? | `PairCreated` + `PoolCreated` count up to the close block |
| 3 | 2026-11-12 00:00 | Will at least 10 wallets hold Predict XP by Nov 12, 2026 00:00 UTC? | Wallets with `xpOf > 0` at the close block (indexer leaderboard) |

- [ ] Move this table into the README, and keep it current as markets are
      added and resolved (who resolved, outcome, block).

## 3. Attester health and faucet alerts (TODO 1.2)

- [ ] Attester `GET /health` on a loopback port: last tick time, last
      successful credit, failed `creditQuest` count since start, the
      attester wallet's QRL balance.
- [ ] Faucet `/status` already returns the balance. The monitoring bot only
      checks that it answers HTTP 200. Add a threshold that warns when the
      balance falls under 1,000 QRL (20 claims), plus the same for the
      attester's gas. The threshold values belong in the ops repo, not here.

## 4. Out-of-date docs

- [ ] README "Status": it still says there is no standing devnet deployment,
      the interface has no Predict pages and the indexer has no Predict
      handlers. All three exist now.
- [ ] README "Related repos": `pauli-swap-indexer` is no longer "planned".
- [ ] PLAN.md §5: steps 4 (devnet deploy), 5 (indexer module and attester)
      and 6 (interface pages) are done.

## 5. Season-end runbook (TODO 2.4)

- [ ] `docs/SEASON-END.md`, step by step: resolve or cancel every market;
      wait 48 h for claims; pick `snapshotBlock`; run the snapshot; admin
      reviews sybil flags and edits `quests/denylist.json`; `closeSeason`;
      send the 10 QRL prize by hand; send the WL list to QuantumArk;
      `startSeason` for season 2.

## 6. Rules the product owner has to decide (TODO 2.1)

The snapshot cannot be final until these are settled. Proposed defaults:

- Active day: a UTC day with a `QuestCompleted`, `Bought` or `Sold`.
- Traded market: at least one `Bought` on it.
- Eligibility: at least 7 active days and 3 markets.
- Tie break: the wallet that reached its score first ranks higher.
- Public board shows `score` (XP + claimable), not only the XP balance.

## 7. Tests (TODO 2.3, 4.1)

- [ ] Rerun the cancel scenario of `e2e.js` on the devnet: buy, sell at a
      profit, cancel; claims must pay `(yes + no) / 2`.
- [ ] Attester: the 500 XP daily cap, a milestone moving to the next day,
      denylist, no double credit.
- [ ] Faucet: parallel claims from one IP stay within `FAUCET_IP_LIMIT`
      (the race fixed in 75aec24).

## 8. Before the public testnet (TODO 6.1)

- [ ] Separate wallets for owner, attester and faucet operator. The owner
      key should not be the deployer, and should not sit in a browser
      wallet used day to day.
- [ ] Faucet funding on the testnet, and a review of 50 QRL per claim, 24 h
      cooldown, 5 claims per IP.
