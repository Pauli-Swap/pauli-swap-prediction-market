# Proposal: what this repo still owes season 1

Status: proposed 2026-10-29; §1, §2, §4, §5, §7 and the attester half of §3
done the same day (see each box). Open: the faucet alert in §3 (ops repo),
§6 (product owner), §8, and of §9 (added 2026-10-30: automatic payout and a
Predict redeploy) the server side of the sync, the gas figure, the rules
and CI; its contract, attester, CLI and runbook work was done 2026-10-30 and
the redeploy 2026-10-31. From the cross-repo TODO in
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

## 9. Pay winnings automatically, redeploy Predict (from `pauli-swap-interface/docs/PROPOSAL-SEASON-1.md`)

Decided 2026-10-30: a settled market pays every holder without the holder
calling `claim`. `claim(id)` only pays `msg.sender`, so this needs a contract
change, and the whole Predict pair is redeployed while season 1 has about 3
test wallets (snapshot 2026-10-29). The 48 h claim window and the interface's
claim banner are dropped.

### 9.1 Contracts

- [x] `PredictMarket.settle(uint256 id, address[] calldata users)`:
      permissionless, pays each user exactly what `claim` would (winning
      side, or `(yes + no) / 2` when cancelled) to that user, skips users
      with nothing, deletes the position and emits the same
      `Claimed(id, user, xp)`, so the indexer and the interface read it
      unchanged. Reverts `PM: not settled` on an open market. `claim(id)`
      stays as the fallback.
- [x] No loop over holders inside `resolve` / `cancel`: the holder count has
      no bound, so neither would the gas, and a market could become
      unresolvable. The holder list comes from off chain (§9.3).
- [x] `PauliPredictXP`: `setMarket(address)` becomes
      `setMarket(address market, bool allowed)` with a private
      `mapping(address => bool)` and an explicit `isMarket(address)` view
      (OC-V3-02: no generated getter on an address-keyed mapping). Next
      time only the market is replaced; a retired market can still pay its
      claims. `reason` stays `bytes32(id)`; with two live markets the
      indexer tells them apart by the emitting market, not by `reason`.
- [x] e2e (`npm run test:qrvm`): `settle` after resolve and after cancel,
      a batch mixing winners, losers and empty wallets, a second `settle` on
      the same users paying nothing, `claim` after `settle` reverting
      `PM: nothing`, `settle` on an open market reverting. Local chain
      2026-10-30, devnet 2026-10-31: 49/49.

### 9.2 Redeploy

- [x] `deploy:qrvm` both contracts; `setMarket(market, true)`,
      `setAttester`, `setParams` as today. `deploy.js` now sends
      `setMarket(market, true)` and takes `SEASON_ENDS_AT`. Deployed
      2026-10-31 from block 15247 (`deployments/devnet.json`); same attester,
      500 XP cap, 10 XP check-in.
- [x] `startSeason(1795627668)` (`SEASON_ENDS_AT=1795627668` in
      `.env.devnet`): the same `endsAt`, so the season-end date
      on the site and in every doc stays 2026-11-25 17:27 UTC.
- [x] Recreate the test markets with the README questions and the same close
      times (the one closing 2026-10-30 12:00 UTC gets a new near close, it
      doubles as the resolve test). Update the README market table. Blocks
      15255 to 15258; market 0 now closes 2026-10-31 12:00 UTC, its
      question dated to match.
- [ ] Sync: `sync:predict` in the interface and the indexer (the indexer
      rebuilds only its `predict_*` tables, TODO 2.3), then the ops repo
      pushes the attester with the new addresses and the interface reruns
      `push_web.sh`.
- [x] Note the old addresses and the reset in the README, so nobody reads the
      old contract's events as season 1.

### 9.3 Attester pays settled markets

- [x] A second pass in `tick`: for each market with `MarketResolved` or
      `MarketCancelled` that still has holders, read them with
      `predictPositions(market: id)` (empty positions are left out by
      default) and call `settle(id, users)` in batches (start at 20; measure
      the gas). Denylisted wallets are paid too: the denylist blocks quest
      XP, not market winnings, and the snapshot drops denied wallets anyway.
- [x] Idempotent across restarts and indexer lag: a user the indexer still
      lists but the chain already paid costs gas and pays nothing, so check
      `positionOf` before adding a user to the batch.
- [x] `/health`: settled markets with holders left, last `settle` tx.
- [x] `market:settle <id>` in `scripts/qrvm/market.js` (dry run unless
      `--send`), the same batch, for when the attester is down. It reads the
      holders from the market's `Bought` logs, so it needs no indexer.
- [x] `test:attester`: a resolved market is paid on the next tick, a second
      tick sends nothing.
- [ ] Attester gas: the 50 QRL alert in the ops repo §3 was sized for
      `creditQuest` only; measure again once `settle` runs. Local chain,
      2026-10-30: 402,516 gas for a batch of 20 winners (about 20,000 a
      user), 47,244 for one, so 20 stays the batch size. Confirm on the
      devnet and hand the figure to the ops repo.

### 9.4 Runbook and rules

- [x] `SEASON-END.md` step 2: replace the 48 h claim window with a check
      that every market is settled and paid: `market:list` shows no open
      market and the attester's `/health` reports no holders left (or run
      `market:settle`). Step 4's `claimable` is then 0 for everyone.
- [ ] Once §6 is decided, write the rules here and point `SEASON-END.md` at
      this section. It points at PRODUCT.md §3, which has no eligibility
      rule (the 7 days / 3 markets threshold is only in PLAN.md).
- [ ] CI (`.github/workflows/ci.yml`): `compile:qrvm`, `test:attester`,
      `test:faucet` on a local chain (TODO 4.1). Only the indexer has CI
      today.
