# Proposal: what this repo still owes season 1

Status: proposed 2026-10-29; §1, §2, §4, §5, §7 and the attester half of §3
done the same day (see each box). Open: the faucet alert in §3 (ops repo),
§6 (product owner) and §8. From the cross-repo TODO in
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
- The test markets (README, Markets) were created with a one-off script, not with tooling
  from this repo.

## 1. Market admin CLI (TODO 1.1)

The interface tools need a browser wallet holding the owner key. A CLI is
still needed for scripted runs and for the season-end steps.

- [x] `scripts/qrvm/market.js` with `create`, `resolve`, `cancel`, `list`:
      dry run unless `--send`, signs with `DEPLOYER_MNEMONIC` (the owner),
      checks `owner()` before sending. `create` checks
      `block.timestamp < closeTime <= seasonEndsAt()` up front, because the
      contract only says `PM: close` / `PM: past season`.
- [x] npm scripts `market:create`, `market:resolve`, `market:cancel`,
      `market:list`, plus `season:close` and `season:start`.
- [x] `season:close` in the same script (dry run by default): calls
      `closeSeason(snapshotBlock, winners)`. `--snapshot` reads the file of
      the indexer's `predict:snapshot` (its `closeSeason` block), or
      `--block` / `--winners` by hand. `season:start` was added for the
      runbook's last step.

## 2. Market schedule (TODO 1.1: record it in the README)

The schedule (markets 0 to 3, created 2026-10-29 in blocks 1860 to 1863)
now lives in the README's Markets section.

- [x] Move this table into the README, and keep it current as markets are
      added and resolved (who resolved, outcome, block): the README table has
      those columns and `npm run market:list -- --md` prints them.

## 3. Attester health and faucet alerts (TODO 1.2)

- [x] Attester `GET /health` on a loopback port: last tick time, last
      successful credit, failed `creditQuest` count since start, the
      attester wallet's QRL balance. `ATTESTER_HEALTH_PORT`, default 8549.
      `ok` is false when the loop failed or stalled.
- [ ] (ops repo, handed over in `Servers/OracleCloud/PauliSwap/docs/PROPOSAL-SEASON-1.md`:
      publish the port, redeploy the attester) Faucet `/status` already returns the balance. The monitoring bot only
      checks that it answers HTTP 200. Add a threshold that warns when the
      balance falls under 1,000 QRL (20 claims), plus the same for the
      attester's gas. The threshold values belong in the ops repo, not here.

## 4. Out-of-date docs

- [x] README "Status": it still says there is no standing devnet deployment,
      the interface has no Predict pages and the indexer has no Predict
      handlers. All three exist now.
- [x] README "Related repos": `pauli-swap-indexer` is no longer "planned".
- [x] PLAN.md §5: steps 4 (devnet deploy), 5 (indexer module and attester)
      and 6 (interface pages) are done.

## 5. Season-end runbook (TODO 2.4)

- [x] `docs/SEASON-END.md`, step by step: resolve or cancel every market;
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

- [x] Rerun the cancel scenario of `e2e.js` on the devnet: buy, sell at a
      profit, cancel; claims must pay `(yes + no) / 2`. Full e2e on the
      devnet, 41/41 on 2026-10-29.
- [x] Attester: the 500 XP daily cap, a milestone moving to the next day,
      denylist, no double credit. `npm run test:attester`, local chain. The
      move to the next UTC day itself is not driven (a `--dev` chain has no
      clock); the waiting quest is shown landing on a later tick instead.
- [x] Faucet: parallel claims from one IP stay within `FAUCET_IP_LIMIT`
      (the race fixed in 75aec24). `npm run test:faucet`, local chain; the
      pre-75aec24 server fails it.

## 8. Before the public testnet (TODO 6.1)

- [ ] Separate wallets for owner, attester and faucet operator. The owner
      key should not be the deployer, and should not sit in a browser
      wallet used day to day.
- [ ] Faucet funding on the testnet, and a review of 50 QRL per claim, 24 h
      cooldown, 5 claims per IP.
