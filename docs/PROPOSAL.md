# Proposal: Predict is a PauliSwap XP event, not a money market

Status: proposed 2026-10-28, waiting for the product owner. The first rename
below is already applied in this repo; everything under "Recommended" is not.

## 1. What we ask the product owner to confirm

1. **XP is the event's own points.** It belongs to PauliSwap Predict and to
   nothing else: it is earned from PauliSwap quests, spent on Yes / No
   questions inside the event, and counted for the event's ranking. It is not
   a token, has no price, cannot be transferred, bought or sold, and never
   turns into QRL.
2. **Predict is presented as an event.** A season is a campaign with a start,
   an end, quests, a leaderboard and fixed prizes (PRODUCT.md §1). It is not a
   prediction market in the Polymarket sense, where people stake money for a
   money payout.
3. **Names follow from 1 and 2.** Contracts, screens and copy avoid words that
   suggest money: ledger, balance sheet, deposit, bet, wager, payout in a
   currency.

## 2. Why

- **Players.** Every amount in Predict is already XP (PRODUCT.md §1), and the
  only things of value are the top 3 prizes. Calling the XP contract a
  "ledger" and the questions "markets" tells players their stakes are money.
- **Partners and listings.** A "prediction market where users stake" is read
  as gambling or a derivatives venue. A quest event with points and a
  leaderboard is not, and this one has nothing a player can cash out.
- **Accuracy.** Nothing in the contracts moves value: XP is credited by quests,
  debited when a player commits it to a question, credited back on sells and
  claims, and never leaves the event.

## 3. Names

### Applied

| Was | Now | Why |
| --- | --- | --- |
| `XPLedger` | `PauliPredictXP` | The XP of the PauliSwap Predict event; no "ledger" |
| `IXPLedger` | `IPauliPredictXP` | Follows the contract |
| `PredictMarket.ledger()` | `PredictMarket.predictXP()` | Same |

Events (`XPCredited`, `XPDebited`, `QuestCompleted`, `SeasonStarted`,
`SeasonClosed`) and functions (`xpOf`, `creditQuest`, `checkIn`, …) already
say XP and keep their names.

### Recommended, not applied

| Today | Proposed | Note |
| --- | --- | --- |
| `PredictMarket` | `PauliPredictEvent` | One contract holds every question of the event |
| market | question (or round) | `createMarket` → `createQuestion`, `MarketCreated` → `QuestionCreated`, `markets` → `questions` |
| stake / buy | commit XP | `buy` / `sell` can keep their names on chain; the UI says "Commit XP" / "Withdraw XP" |
| shares | outcome points | A winning outcome point pays 1 XP |
| "Markets" tab | "Questions" | Sub-nav becomes Questions · Quests · Leaderboard · Rewards; needs a Figma change (DESIGN.md) |

Renaming on chain is cheap while nothing is deployed: there is no standing
devnet deployment (PLAN.md), so a rename costs only a recompile and the e2e
run. After the first deployment the indexer and interface would have to follow.

## 4. What does not change

- Mechanics: per-season XP, the attester and daily cap, the binary fixed
  product AMM, admin resolution, claim and cancel refunds (PLAN.md §2).
- Prizes and eligibility (PRODUCT.md §1, PLAN.md §3.1).
- The open questions in PRODUCT.md §3: leaderboard period, prize delivery,
  sybil resistance.

## 5. Decision needed

- Yes / no on §1.
- Yes / no on each row of "Recommended", or other names.
- Whether players see the word "prediction" at all, or only "PauliSwap Predict"
  as the event's name.
