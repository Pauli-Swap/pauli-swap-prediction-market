# AcornSwap Predict — product rules

Status: product rules for the Prediction Market ("Predict") feature of
AcornSwap. Nothing is built: no contracts, no indexer handlers, no interface
pages. The Figma screens exist (`docs/DESIGN.md`).

The rules are split into what the product owner decided and what the design
assumed to fill gaps. Build against section 1. Confirm anything in section 2
with the product owner before it reaches a contract.

---

## 1. Decided (product owner, 2026-10-27)

### Currency: XP, not QRL

- A wallet joins prediction markets with **XP**. QRL and tokens are never staked
  on a prediction.
- XP is earned from **daily quests** that involve using AcornSwap: swap, add
  liquidity, wrap, predict, and similar actions.
- Quests **reset daily**.
- Every amount in Predict is shown in XP units.

### Access

- Anyone can **browse** markets, quests, the leaderboard and rewards without a
  wallet.
- **Staking needs a connected wallet.** Without one, the screens show a guest
  banner and a "Connect wallet" button where Buy would be.
- Guest banner: the title is QRL orange (`qrl/default`), the body text is white.

### Prizes: top 3 by XP, no tiers

| Rank | Prize |
| --- | --- |
| #1 | 1 Qurrl whitelist spot + 10 QRL |
| #2 | 1 Qurrl whitelist spot |
| #3 | 1 Qurrl whitelist spot |

- There are **no tiers** and no other prize bands. Do not add them.
- The whitelist is for **Qurrl**, QUANTUMARK's QRC-721 collection on QRL
  (10,500 max supply). As of 2026-10-27 it is at the design stage, with no mint
  date or price. Always name it ("Qurrl WL") and link the source:
  <https://quantumark.fi/qurrl>.

### Navigation

Predict has its own sub-nav: **Markets · Quests · Leaderboard · Rewards**.
Trending / New / Ending soon / Resolved is a filter inside Markets, not a tab.

---

## 2. Assumed in the design, not confirmed

These appear in the Figma screens but were the designer's choices. Each needs
a yes from the product owner before contract work depends on it.

| Assumption | Where it shows up |
| --- | --- |
| Quests reset at **00:00 UTC** | Quests screen countdown; quest contract or indexer day boundary |
| A winning share pays **100 XP** | Market screen explanation line; payout math |
| Winnings are taken with an explicit **Claim** step | Rewards / Market screens; a `claim` write instead of an automatic payout |
| #2 and #3 get **one whitelist spot each** | Rewards screen. The owner's wording was "2 whitelist cho top 2 và 3" ("2 whitelist for top 2 and 3"), which reads as one each but was not stated per rank |

---

## 3. Open questions

None of these has an answer yet. They decide the contract design.

- **Where XP lives.** An on-chain balance (non-transferable token or a
  contract ledger) or an off-chain ledger computed by the indexer from
  AcornSwap events. Quests reward actions on other contracts (swap, add
  liquidity, wrap), so someone must observe those actions: an on-chain hook in
  AcornSwap, a trusted attester that writes completions, or the indexer.
- **Transferability.** Whether XP can move between wallets. If it can, one
  person can farm quests on many wallets and pool the XP.
- **Pricing of outcome shares.** Fixed-price shares, a pari-mutuel pool, or an
  AMM / bonding curve. The design only promises "a winning share pays N XP".
- **Market creation.** Admin only, or open to users.
- **Resolution.** Who resolves a market (admin, multisig, oracle), how a
  dispute is handled, and what happens to stakes on a market that is cancelled.
- **Leaderboard period.** Whether the top 3 is for one season, a week, or all
  time, and whether ranking uses XP held, XP earned, or XP won.
- **Prize delivery.** The 10 QRL and the whitelist spots are paid by hand or by
  a contract, and how a winner's address reaches the Qurrl whitelist.
- **Sybil resistance.** Whether anything limits one person with many wallets,
  given that prizes have real value.

---

## 4. Prior art

`PhuocNG0308/pqlymarket` (`../pqlymarket`) is a Polymarket-style prediction
market by the same team on the older **20 byte Zond line** (`@theqrl/hypc`
0.0.2, chain 1337): `MarketFactory`, `PredictionMarket`, `ConditionalToken`
(ERC-1155), `BondingCurve`, `LiquidityPool`, `Oracle`, `GovernanceOracle`.

Use it for ideas only:

- It settles in QRL / an ERC-20 through an AMM; Predict uses XP.
- It is 32 byte EVM-style code. Moving any of it to the QIP-55 devnet needs
  every deviation in `docs/QRVM.md` applied (64 byte words, private
  address-keyed mappings, no on-chain CREATE2 derivation, `mulDiv`, assembly
  word sizes).
