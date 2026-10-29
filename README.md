# PauliSwap Predict

Prediction markets for [PauliSwap](https://github.com/PhuocNG0308/acorn-swap)
on the private QRL QIP-55 devnet (`chainId` 3151908). Users stake **XP**,
earned from daily quests on PauliSwap, on Yes / No questions; the top 3 by XP
win Qurrl whitelist spots.

Status: season 1 is live on the devnet until 2026-11-25 17:27 UTC.
`PauliPredictXP`, `PredictMarket` and `QrlFaucet` are deployed
(`deployments/devnet.json`, `deployments/faucet-devnet.json`), the interface
has the Predict pages and the owner tools, and pauli-swap-indexer indexes
Predict and serves the quest queue. Faucet and attester run on the chain host.
Plan: [docs/PLAN.md](docs/PLAN.md); what season 1 still needs:
[docs/PROPOSAL-SEASON-1-OPS.md](docs/PROPOSAL-SEASON-1-OPS.md).

## Markets

Owner tooling, dry run unless `--send` (`scripts/qrvm/market.js`):

```
export QRVM_ENV=.env.devnet
npm run market:list                      # add -- --md for the rows below
npm run market:create  -- "<question>" 2026-11-20T00:00Z [seedXP]
npm run market:resolve -- <id> yes|no
npm run market:cancel  -- <id>
npm run season:close   -- --snapshot <file>
npm run season:start   -- <endsAt>
```

Season 1 schedule. Markets 0 to 3 were created 2026-10-29 by the owner
`Qa1A64D6E7…34Ca` in blocks 1860 to 1863, each seeded with 100 XP. When a
market is settled, copy its last four cells from `npm run market:list -- --md`;
new markets get a row from it too, with the resolution rule written in.

| # | Closes (UTC) | Question | How to resolve | Status | Outcome | Settled in block | By |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 2026-10-30 12:00 | Will the PauliSwap faucet have sent out at least 500 QRL by Oct 30, 2026 12:00 UTC? | `QrlFaucet` total dripped (`/faucet/status` `totalDrippedPlanck`) at the close block | open | — | — | — |
| 1 | 2026-11-01 00:00 | Will the QRL devnet pass block 26,000 by Nov 1, 2026 00:00 UTC? | Block number of the last block before the close time | open | — | — | — |
| 2 | 2026-11-05 00:00 | Will PauliSwap have at least 10 pools (V2 + V3) by Nov 5, 2026 00:00 UTC? | `PairCreated` + `PoolCreated` count up to the close block | open | — | — | — |
| 3 | 2026-11-12 00:00 | Will at least 10 wallets hold Predict XP by Nov 12, 2026 00:00 UTC? | Wallets with `xpOf > 0` at the close block (indexer leaderboard) | open | — | — | — |

Season end, step by step: [docs/SEASON-END.md](docs/SEASON-END.md).

## Quests, attester and faucet

- `quests/catalog.json`: the public quest catalogue (daily, season tiers).
  The rules are evaluated by pauli-swap-indexer (`src/quests.ts`).
  Hidden quests live in `quests/hidden.json`, which is gitignored and
  installed from the private ops repo; `sync:predict` in the indexer merges
  it into the catalogue when present.
- `quests/denylist.json`: wallets the faucet and the attester refuse.
- `npm run attester`: credits what the indexer's `questQueue` reports via
  `creditQuest`. Dry run unless `--send`; `--once`, `--interval <s>`. In
  loop mode it serves `GET /health` on `127.0.0.1:ATTESTER_HEALTH_PORT`
  (default 8549): last tick, last credit, failed credits, QRL balance.
- `contracts/QrlFaucet.hyp`: QuantumArk's sponsored faucet, with
  `lastClaimAt` private behind `lastClaimOf` (OC-V3-02).
  `npm run gen:wallet` creates its operator key, `npm run faucet:deploy`
  (dry run unless `--send`) funds and deploys it into
  `deployments/faucet-devnet.json`, and `npm run faucet` serves
  `POST /claim` on 127.0.0.1:8548 for the interface's `/faucet` proxy.

All of these read `QRVM_ENV=.env.devnet`; see `.env.devnet.example`.

Tests, all against the local chain (`QRVM_ENV=.env.local-qrvm`) unless noted:
`npm run test:qrvm` (contracts end to end, also run on the devnet),
`npm run test:attester` (cap, denylist, no double credit),
`npm run test:faucet` (parallel claims stay within `FAUCET_IP_LIMIT`).

## Docs

| File | What it holds |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Product rules: what is decided, what the design assumed, open questions for the contract design |
| [docs/PROPOSAL.md](docs/PROPOSAL.md) | Proposal for the product owner: XP is PauliSwap Predict event points, naming that follows |
| [docs/PROPOSAL-SEASON-1-OPS.md](docs/PROPOSAL-SEASON-1-OPS.md) | What this repo still owes season 1: market CLI, market schedule, attester health, season-end runbook, rules to decide |
| [docs/PLAN.md](docs/PLAN.md) | Build plan: on-chain / off-chain split, `PauliPredictXP` and `PredictMarket`, proposed quests, order of work |
| [docs/SEASON-END.md](docs/SEASON-END.md) | Season-end runbook: settle markets, claim window, sybil review, snapshot, `closeSeason`, prizes, season 2 |
| [docs/DESIGN.md](docs/DESIGN.md) | Figma file and node map of the Predict screens, the minimal-design contract, theme |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | What the contracts must look like for the QIP-55 toolchain, the interface and the indexer |
| [docs/QRVM.md](docs/QRVM.md) | Copy of `pauli-swap/docs/QRVM.md`: measured QIP-55 / QRVM facts and every deviation from EVM code. The pauli-swap copy is canonical |
| [CLAUDE.md](CLAUDE.md) | Coding rules shared with `pauli-swap` (comments, English only) |

Start with PRODUCT.md §2 and §3: several rules the screens show are
assumptions, and the open questions decide the contract architecture.

## Related repos

| Repo | Role for Predict |
| --- | --- |
| `pauli-swap` | QRVM toolchain, deploy scripts and devnet deployment to follow |
| `pauli-swap-interface` | Vite + React dApp; hosts the Predict pages and the owner tools |
| `pauli-swap-indexer` | Indexer; its Predict module serves quest progress and the attester's `questQueue` (`src/predict.ts`, `src/quests.ts`) |
| `pqlymarket` | Earlier Polymarket-style prototype on the 20 byte Zond line; ideas only (PRODUCT.md §4) |

The local checkouts sit side by side under `Projects/Blockchains/`, so paths in
these docs such as `pauli-swap-interface/src/lib/logs.ts` are relative to that
folder.

## License

GNU General Public License v2.0 or later; see [LICENSE](LICENSE). The one
exception is `contracts/QrlFaucet.hyp`, which comes from QuantumArk and keeps
its MIT license (SPDX header in the file).
