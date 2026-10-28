# PauliSwap Predict — build plan

Status: steps 1 to 3 of §5 are built (`contracts/`, `scripts/`) and pass the
end to end run on a local `gqrl --dev` chain and on the private devnet (2026-10-28,
chain 3151908, 39/39 checks, throwaway contracts). After the cancel fix the
local run is 41/41. Standing devnet deployment: `deployments/devnet.json`
(block 4440).
Decisions it rests on are in `docs/PRODUCT.md` §3 ("Decided 2026-10-28"). The
product owner accepted the proposed defaults on 2026-10-28 and expects 3 to 20
players (§3.1).

Users earn **XP** (also called "EXP" in conversation; identifiers always use
`XP`) from daily quests on PauliSwap, stake it on Yes / No markets, and the top
3 wallets by XP held at the end of a season win the prizes in PRODUCT.md §1.

---

## 1. On-chain / off-chain split

| Component | Runs | Why |
| --- | --- | --- |
| XP balances, credit / debit | **On-chain** `PauliPredictXP` | Staking is a real write; the UI reads numbers from the chain (INTEGRATION §5) |
| Quest de-duplication (user, questId, day) | **On-chain** `PauliPredictXP` | A buggy or replayed attester cannot credit twice |
| Daily quest XP cap per wallet | **On-chain** `PauliPredictXP` | Bounds the damage of a leaked attester key |
| Markets, AMM, buy / sell, resolve, cancel, claim | **On-chain** `PredictMarket` | Stakes and outcomes must be public |
| Daily check-in (optional) | **On-chain** `PauliPredictXP.checkIn()` | The only quest the chain can verify by itself |
| Season result (top 3) | **On-chain** `SeasonClosed` event | Public record of who won at which block |
| Quest definitions (conditions, thresholds, XP) | **Off-chain** indexer config | Change quests without a redeploy |
| Quest detection (`Swap`, `Mint`, `Deposit`, Predict events) | **Off-chain** indexer | V2 / V3 are deployed; no hooks can be added |
| Writing credits | **Off-chain** attester bot → `creditQuest` tx | No `ecrecover` on Zond, so no signed attestations (INTEGRATION §2) |
| Streaks, one-time quests, "hold LP N hours" | **Off-chain** indexer | Needs multi-day history |
| Leaderboard, history, market prices over time | **Off-chain** indexer, from events | No ranking on chain; getters may be wrong (INDEXER.md §5) |
| Prize delivery (10 QRL, Qurrl WL) | **Manual**, admin | The WL is held by QUANTUMARK; sybil review happens first |

Trust assumptions: the **attester key** and **admin resolution** are
centralised. The on-chain daily cap and de-duplication limit what a bad
attester can do; nothing on chain limits a bad admin.

---

## 2. Contracts (`contracts/`)

Rules from `docs/QRVM.md` and INTEGRATION §2 apply to all of them: no public
mapping keyed by `address` / `bytesN` (private + explicit view), no assembly,
no upstream `FullMath.mulDiv`, short revert strings, every runtime under
24,576 bytes, no permit or signatures.

### 2.1 `PauliPredictXP`

- State: `currentSeason`; private
  `mapping(uint256 => mapping(address => uint256))` balance per season, so a
  new season starts every wallet at 0; private `mapping(bytes32 => bool)` quest
  done, key `keccak256(user, questId, day)`; private `mapping(bytes32 =>
  uint256)` quest XP per `(user, day)`; `dailyQuestCap`.
- Roles (owner is a multisig): `attester` credits quests; `market`
  (`PredictMarket`) debits on buy and credits on sell / claim / refund.
- Writes:
  - `creditQuest(address user, uint256 questId, uint256 day, uint256 amount)`,
    attester only. Reverts on a repeat, over the cap, or when `day` is neither
    today nor yesterday (the bot may run late past midnight UTC).
  - `checkIn()`: once per wallet per day, fixed XP.
  - `debit(address user, uint256 amount, bytes32 reason)` and `credit(...)`,
    market only.
  - `startSeason()`, `closeSeason(uint256 snapshotBlock, address[3] winners)`,
    owner only.
- Views: `xpOf(address)`, `xpOfSeason(uint256, address)`,
  `questDone(address, uint256 questId, uint256 day)`.
- No `transfer` / `approve`: XP is non-transferable.
- Events: `XPCredited(address indexed user, uint256 indexed season, uint256
  amount, bytes32 reason)`, `XPDebited(...)`, `QuestCompleted(address indexed
  user, uint256 indexed questId, uint256 day, uint256 amount)`,
  `SeasonStarted`, `SeasonClosed(uint256 indexed season, uint256 snapshotBlock,
  address[3] winners)`.
- Day = `block.timestamp / 1 days`, a 00:00 UTC reset (still a PRODUCT §2
  assumption).

### 2.2 `PredictMarket`

One contract, markets addressed by `uint256 id`: no factory, no CREATE2.

Pricing is a binary **fixed product market maker** (Gnosis FPMM): a constant
product over a Yes reserve and a No reserve. It needs no `exp` / `ln`, unlike
LMSR. Shares are non-transferable and kept in an internal ledger, not an
ERC-1155, to save code size.

- `createMarket(string question, uint256 closeTime, uint256 liquidity)`, owner
  only. `PauliPredictXP` mints `liquidity` XP as seed: `liquidity` Yes + `liquidity`
  No, price 50 / 50. The pool can lose at most `liquidity`, which bounds XP
  inflation per market.
- `buy(id, outcome, xpIn, minSharesOut)`: debit `xpIn`, add `xpIn` to both
  reserves, pay out shares of `outcome` so the product does not decrease. For
  Yes: `out = xpIn + poolYes - k / (poolNo + xpIn)`, rounded in the pool's
  favour.
- `sell(id, outcome, xpOut, maxSharesIn)`: the inverse, by XP wanted (Gnosis
  `calcSellAmount`, no `sqrt`). Credits `xpOut`.
- Optional trade fee kept in the pool; 0 in v1.
- `resolve(id, outcome)` after `closeTime`, `cancel(id)` before resolution,
  both owner only.
- `claim(id)`: resolved, each winning share pays 1 XP; cancelled, every share,
  Yes or No, pays 0.5 XP. A `netSpent` refund (XP paid in minus XP received
  from sells) was dropped: a wallet that sold for a profit kept it while the
  buyers it sold to were refunded in full, so a cancel could mint XP without
  bound. At 0.5 XP a share a cancelled market never pays out more than traders
  put in. The Figma line "a winning share pays N XP" must show this ratio.
- Claims credit the **current** season, so a market's `closeTime` must fall
  before its season ends.
- State: `Market[] public markets` (`closeTime`, `poolYes`, `poolNo`,
  `status`, `winningOutcome`; uint index, so public is safe); private
  `mapping(uint256 => mapping(address => Position))` with `yesShares`,
  `noShares`, `netSpent`.
- Views: `positionOf(uint256 id, address user)`, `priceOf(uint256 id)` (Yes =
  `poolNo / (poolYes + poolNo)`), `quoteBuy`, `quoteSell`.
- Events, indexed on `id` and `user`: `MarketCreated(uint256 indexed id, string
  question, uint256 closeTime, uint256 liquidity)`, `Bought(uint256 indexed id,
  address indexed user, uint8 outcome, uint256 xpIn, uint256 shares)`,
  `Sold(...)`, `MarketResolved(uint256 indexed id, uint8 outcome)`,
  `MarketCancelled(uint256 indexed id)`, `Claimed(uint256 indexed id, address
  indexed user, uint256 xp)`.
- XP has 18 decimals; `poolYes * poolNo` fits in uint256 while reserves stay
  under 1e38, so plain checked arithmetic is enough.

If the runtime goes over the limit, move `quote*` into a `PredictMarketLens`,
as `PauliV3PoolLens` does in `pauli-swap`.

### 2.3 Repo tooling

- Copy the QRVM build from `pauli-swap`: `scripts/compile.js` writing
  `build/qrvm/index.json` and `build/qrvm/<unit>/<Name>.json`, an OC-V3-02 lint
  like `check:qrvm`, and `scripts/qrvm/lib.js` with its private-RPC guard.
- `scripts/qrvm/deploy.js` writes `deployments/<network>.json` (`network`,
  `chainId`, `startBlock`, `deployedAt`, `contracts`), then calls
  `PauliPredictXP.setMarket`, `setAttester` and `startSeason`.

---

## 3. Proposed quests

All detection lives in the indexer, Predict actions included, and every credit
goes through `creditQuest`. Minimum amounts are valued in QRL from pool prices
so dust swaps do not count.

| Kind | Quest | Source | XP |
| --- | --- | --- | ---: |
| Daily | Check in | `PauliPredictXP.checkIn()`, on chain only | 10 |
| Daily | Swap ≥ 10 QRL in value | V2 / V3 `Swap`, real tx sender | 30 |
| Daily | Swap on 3 different pairs | V2 / V3 `Swap` | 40 |
| Daily | Wrap or unwrap QRL | WQRL `Deposit` / `Withdrawal` | 15 |
| Daily | Add liquidity | V2 `Mint`, V3 `IncreaseLiquidity` | 50 |
| Daily | Make a prediction | `PredictMarket.Bought` | 20 |
| Daily | Claim a winning market | `PredictMarket.Claimed` | 20 |
| Streak | 7 days in a row with ≥ 3 quests | indexer history | 150 |
| Hold | Keep an LP position ≥ 24 h (credited after 24 h) | V3 position / LP balance | 80 |
| One-time | First swap / first LP / first prediction | indexer | 50 each |
| Skill | 3 correct markets in a row | `MarketResolved` + positions | 200 |

### 3.1 Defaults for 3 to 20 players

Accepted 2026-10-28. `scripts/qrvm/deploy.js` uses the first three; the rest
are admin practice.

| Setting | Value | Reason |
| --- | --- | --- |
| Season length | 28 days (`SEASON_DAYS`) | Long enough for a streak and several markets with few players |
| Daily quest cap | 500 XP per wallet (`DAILY_QUEST_CAP_XP`) | Above a full day of quests plus a streak bonus, so it only bites on a bad attester |
| Check-in | 10 XP (`CHECK_IN_XP`) | |
| Seed liquidity | 100 XP for 3 to 10 players, 200 XP for 10 to 20 | Measured: 100 XP of trades on a 200 XP market moves Yes from 50% to 57%. Thicker seeds would barely move with this few traders |
| Markets open at once | 2 to 3 for 3 to 10 players, 3 to 5 for 10 to 20 | Spreading a few players over many markets leaves each one idle |
| Prize eligibility | ≥ 7 active days and ≥ 3 markets traded in the season | With 3 to 5 players, top 3 would otherwise be nearly everyone |
| Reset | 00:00 UTC | `block.timestamp / 1 days` |

XP minted by markets is bounded by their seeds: a season of 12 markets at
200 XP adds at most 2,400 XP, small next to ~150 XP of quests per player per
day.

Anti-farming: a pair counts once per wallet per day (no wash trading credit),
the on-chain daily cap, non-transferable XP, and an admin review of funding
sources and duplicate behaviour before prizes go out. Sybil attacks with many
wallets are **not** solved at the contract level and stay an open risk.

---

## 4. Off-chain work

1. **Indexer** (`pauli-swap-indexer`, the Predict module of INDEXER.md §15):
   ingest `PauliPredictXP` and `PredictMarket` events from `startBlock`, make WQRL
   `Deposit` / `Withdrawal` required, keep `quest_progress(user, quest_id,
   day)` and `xp_balance(season, user)` from `XPCredited` / `XPDebited`; the
   leaderboard is the top of the season balance.
2. **Attester bot**: credits eligible quests with `creditQuest`; idempotent
   through on-chain de-duplication; estimates gas before sending. Its key holds
   only the attester role.
3. **Interface** (`pauli-swap-interface`): routes `#/predict`,
   `#/predict/market/:id`, `#/predict/quests`, `#/predict/leaderboard`,
   `#/predict/rewards` per `docs/DESIGN.md`. Balance from `xpOf`, history from
   `qrl_getLogs` (`src/lib/logs.ts`), quests and leaderboard from the indexer.
4. **Season end**, in this order:
   1. Resolve or cancel every market of the season.
   2. Leave a claim window (e.g. 48 h). The ranking is `xp_balance +
      claimable`, where claimable is the winning shares and, on cancelled
      markets, half of all shares not yet claimed (from `Bought` / `Sold` / `Claimed` on settled markets),
      so a wallet that won but has not claimed is not ranked at 0.
   3. Pick `snapshotBlock`; the indexer exports the top 3 among eligible
      wallets (§3.1); admin reviews for sybils.
   4. `closeSeason` (once per season, enforced on chain), send 10 QRL by hand,
      submit the WL wallets to QUANTUMARK.
   5. Only then `startSeason`, which reverts until `closeSeason` has run.
      `credit` has no season check, so a claim made after the next season
      starts would land in the new season.

---

## 5. Order of work

1. QRVM build, lint and deploy tooling in this repo. **Done.**
2. `PauliPredictXP` and tests. **Done.**
3. `PredictMarket` and tests; measure code size. **Done**: runtime 7,042
   bytes, `PauliPredictXP` 4,793, so no lens is needed.
4. Deploy on `gqrl --dev` (**done**), then the devnet.
5. Indexer module and attester bot.
6. Interface pages.

Commands:

```
cp .env.local-qrvm.example .env.local-qrvm   # fill DEPLOYER_MNEMONIC
npm run check:qrvm    # compile with hypc:local + OC-V3-02 lint
npm run test:qrvm     # e2e on the local chain, ~1 min (waits for a market to close)
QRVM_ENV=.env.devnet npm run deploy:qrvm
```

---

## 6. Verification

- `compile:qrvm` with `hypc:local`; the lint finds no public mapping keyed by
  `address` / `bytesN`; every runtime under 24,576 bytes.
What `npm run test:qrvm` (`scripts/qrvm/e2e.js`) checks on `gqrl --dev`,
fresh contracts and three throwaway wallets:

- Quests: credit, `questDone`, yesterday accepted; reverts on repeat, over the
  cap, a day two back, quest id 0, a non-attester. Check-in once per day.
- Market: `buy` Yes / No from three wallets and a partial `sell`; the product
  never decreases, shares equal the quote, the pool mints at most its seed.
- Reverts: slippage, selling more shares than held, staking more XP than held,
  `quoteSell` beyond the reserve, non-owner `createMarket`, a market past the
  season end, `resolve` before close and with an invalid outcome, buy after
  close, double claim, a loser's claim, cancel of a settled market,
  `startSeason` / `closeSeason` while the season is live.
- Cancel after a wallet sold for more than it paid: every share pays 0.5 XP and
  the market mints nothing net.
- Every balance rebuilt from `qrl_getLogs` (64 byte topics) equals `xpOf`.

No manual storage slot read is needed: every address-keyed mapping is read
through a hand-written view, never a generated getter, and the only generated
getters are `markets` (uint-indexed array) and `seasonClosed` (uint key), both
safe per `docs/QRVM.md` Q2.

Devnet run: `QRVM_ENV=.env.devnet npm run test:qrvm`, 39/39 on 2026-10-28. The
devnet misses slots (12 s slots, gaps up to 120 s measured), so the test sizes
market 0's close window from recent block gaps; the run takes ~15 min.

Not covered yet: `closeSeason` and the `startSeason` close guard (both need a
season that has ended); checked by hand on a local chain on 2026-10-28.
