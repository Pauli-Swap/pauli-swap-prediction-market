# PauliSwap Predict

Prediction markets for [PauliSwap](https://github.com/PhuocNG0308/acorn-swap)
on the private QRL QIP-55 devnet (`chainId` 3151908). Users stake **XP**,
earned from daily quests on PauliSwap, on Yes / No questions; the top 3 by XP
win Qurrl whitelist spots.

Status: `PauliPredictXP` and `PredictMarket` are written and pass the end to end run
on a local QIP-55 chain and on the private devnet (`npm run test:qrvm`). No standing devnet deployment yet;
the interface has no Predict pages and the indexer has no Predict handlers.
Plan and remaining steps: [docs/PLAN.md](docs/PLAN.md).

## Quests, attester and faucet

- `quests/catalog.json`: the public quest catalogue (daily, season tiers).
  The rules are evaluated by pauli-swap-indexer (`src/quests.ts`).
  Hidden quests live in `quests/hidden.json`, which is gitignored and
  installed from the private ops repo; `sync:predict` in the indexer merges
  it into the catalogue when present.
- `quests/denylist.json`: wallets the faucet and the attester refuse.
- `npm run attester`: credits what the indexer's `questQueue` reports via
  `creditQuest`. Dry run unless `--send`; `--once`, `--interval <s>`.
- `contracts/QrlFaucet.hyp`: QuantumArk's sponsored faucet, with
  `lastClaimAt` private behind `lastClaimOf` (OC-V3-02).
  `npm run gen:wallet` creates its operator key, `npm run faucet:deploy`
  (dry run unless `--send`) funds and deploys it into
  `deployments/faucet-devnet.json`, and `npm run faucet` serves
  `POST /claim` on 127.0.0.1:8548 for the interface's `/faucet` proxy.

All of these read `QRVM_ENV=.env.devnet`; see `.env.devnet.example`.

## Docs

| File | What it holds |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Product rules: what is decided, what the design assumed, open questions for the contract design |
| [docs/PROPOSAL.md](docs/PROPOSAL.md) | Proposal for the product owner: XP is PauliSwap Predict event points, naming that follows |
| [docs/PLAN.md](docs/PLAN.md) | Build plan: on-chain / off-chain split, `PauliPredictXP` and `PredictMarket`, proposed quests, order of work |
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
| `pauli-swap-interface` | Vite + React dApp that will host the Predict pages |
| `pauli-swap-indexer` | Planned indexer; Predict is a future handler module (INDEXER.md §15) |
| `pqlymarket` | Earlier Polymarket-style prototype on the 20 byte Zond line; ideas only (PRODUCT.md §4) |

The local checkouts sit side by side under `Projects/Blockchains/`, so paths in
these docs such as `pauli-swap-interface/src/lib/logs.ts` are relative to that
folder.

## License

GNU General Public License v2.0 or later; see [LICENSE](LICENSE). The one
exception is `contracts/QrlFaucet.hyp`, which comes from QuantumArk and keeps
its MIT license (SPDX header in the file).
