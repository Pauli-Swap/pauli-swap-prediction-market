# AcornSwap Predict

Prediction markets for [AcornSwap](https://github.com/PhuocNG0308/acorn-swap)
on the private QRL QIP-55 devnet (`chainId` 3151908). Users stake **XP**,
earned from daily quests on AcornSwap, on Yes / No questions; the top 3 by XP
win Qurrl whitelist spots.

Status: **reference docs only, nothing built yet.** No contracts are deployed,
the interface has no Predict pages, and the indexer has no Predict handlers.

## Docs

| File | What it holds |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Product rules: what is decided, what the design assumed, open questions for the contract design |
| [docs/DESIGN.md](docs/DESIGN.md) | Figma file and node map of the Predict screens, the minimal-design contract, theme |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | What the contracts must look like for the QIP-55 toolchain, the interface and the indexer |
| [docs/QRVM.md](docs/QRVM.md) | Copy of `acorn-swap/docs/QRVM.md`: measured QIP-55 / QRVM facts and every deviation from EVM code. The acorn-swap copy is canonical |
| [CLAUDE.md](CLAUDE.md) | Coding rules shared with `acorn-swap` (comments, English only) |

Start with PRODUCT.md §2 and §3: several rules the screens show are
assumptions, and the open questions decide the contract architecture.

## Related repos

| Repo | Role for Predict |
| --- | --- |
| `acorn-swap` | QRVM toolchain, deploy scripts and devnet deployment to follow |
| `acorn-swap-interface` | Vite + React dApp that will host the Predict pages |
| `acorn-swap-indexer` | Planned indexer; Predict is a future handler module (INDEXER.md §15) |
| `pqlymarket` | Earlier Polymarket-style prototype on the 20 byte Zond line; ideas only (PRODUCT.md §4) |

The local checkouts sit side by side under `Projects/Blockchains/`, so paths in
these docs such as `acorn-swap-interface/src/lib/logs.ts` are relative to that
folder.
