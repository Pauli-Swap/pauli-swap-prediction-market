# Season-end runbook

For the PauliSwap Predict admin. Every command runs from this repo with the
devnet tunnel up (`npm run vps:tunnel` in `QuantumArk/infra/devnet`) and signs
with `DEPLOYER_MNEMONIC` in `.env.devnet`, the owner of both contracts. Each
one is a dry run until `--send` is added: it prints the call and simulates it.
Arguments after the npm script name go after `--`.

```
export QRVM_ENV=.env.devnet
```

Season 1 ends **2026-11-25 17:27:48 UTC** (`seasonEndsAt` 1795627668).

## Why the order matters

- `PauliPredictXP.credit` is not gated on the season, so a payout made late
  still lands in whatever season is current. Markets must be settled and
  paid while season 1 is still current.
- `closeSeason` reverts until `block.timestamp >= seasonEndsAt`, and only
  once per season.
- `startSeason` reverts until the current season is closed, so season 2
  cannot start before step 7.
- Every market's `closeTime` is before the season end (enforced by
  `createMarket`), so all markets can be resolved before the season ends.

## 1. Resolve or cancel every market

```
npm run market:list
npm run market:resolve -- <id> yes|no            # after the market's closeTime
npm run market:resolve -- <id> yes|no --send
npm run market:cancel  -- <id> --send            # if the question cannot be answered
```

`market:resolve` refuses a market that has not closed yet. Resolve each one
from the rule in the README's market table, and record the outcome, the block
and who resolved it there (`npm run market:list -- --md` prints the rows).

Cancel only when the question has no fair answer: a cancelled market pays
0.5 XP for every Yes and No share, so a wallet that bought below 50% gains and
one that bought above it loses.

## 2. Check that every holder is paid

Nobody has to claim: on its next tick after a market is resolved or
cancelled, the attester pays every holder through `PredictMarket.settle`.
Check that it did:

```
npm run market:list                              # no market is open
curl -s http://127.0.0.1:8549/health             # on the chain host: "unpaidMarkets": []
```

If the attester is down or `unpaidMarkets` stays non-empty, pay by hand. It
reads the holders from the chain, needs no indexer, and anyone may send it:

```
npm run market:settle -- <id>
npm run market:settle -- <id> --send
```

A second run prints "nobody left to pay".

## 3. Sybil review

```
# in pauli-swap-indexer, with the private sybil module installed
npm run predict:sybil -- --season 1
```

Review the flags. Add every wallet that is refused to
`quests/denylist.json` here (`wallets`, with a note). The faucet service and
the attester re-read it on every use, and the snapshot drops those wallets.
On the chain host the file is baked into the predict image, so a change takes
effect only after the ops repo pushes it (`scripts/push_chain_host.sh`).

## 4. Snapshot

Pick `snapshotBlock`: a block after the last `settle` of step 2. The ranking
is `xp_balance + claimable` at that block, where claimable is the winning
shares of resolved markets and half of all shares of cancelled markets not
yet paid; after step 2 it is 0 for everyone. Eligibility and the tie break are the rules of PRODUCT.md §3 and
docs/PROPOSAL-SEASON-1-OPS.md §6, which the product owner has to settle
first.

```
# in pauli-swap-indexer, against the database that indexes the devnet
npm run predict:snapshot -- --season 1 --block <snapshotBlock> --denylist ../pauli-swap-prediction-market/quests/denylist.json
```

It writes `snapshot-season-1-block-<B>.json` with every wallet's score and
`closeSeason: { snapshotBlock, winners }`, and exits 2 on a warning (a market
open at B, B before the season end or past the indexer cursor, a winner
flagged by the sybil report) unless `--force`. Settle every warning rather
than forcing it. The indexer database lives on the chain host; running the
command there is the ops repo's job (`PauliSwap/docs/PROPOSAL-SEASON-1.md`).

Keep the file with the season's records.

## 5. Record the winners on chain

```
npm run season:close -- --snapshot snapshot-season-1-block-<B>.json
npm run season:close -- --snapshot snapshot-season-1-block-<B>.json --send
```

The command sends the file's `closeSeason` and prints its warnings again. It
refuses if the season has not ended, is already closed, the file is for
another season, `snapshotBlock` is past the head, or a market is still open
(unless `--allow-open`). Fewer than three winners are padded with the zero
address. The `SeasonClosed` event is the public record of who won.

## 6. Prizes and whitelist

- Send the 10 QRL prize by hand to each winner, and note the transaction
  hashes next to the snapshot file.
- Send the winners' wallets to QuantumArk for the Qurrl whitelist.

## 7. Season 2

```
npm run season:start -- 2026-12-30T00:00Z
npm run season:start -- 2026-12-30T00:00Z --send
```

Every wallet starts season 2 at 0 XP. Then create the new markets with
`npm run market:create -- "<question>" <closeTime> [seedXP]`; a `closeTime`
after the new season end is refused up front.
