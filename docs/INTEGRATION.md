# PauliSwap Predict — integration constraints

What the Predict contracts must look like so that the existing interface and
the planned indexer can use them without special cases. Each constraint comes
from a measured property of the QIP-55 devnet; the evidence is in
`docs/QRVM.md` and in the sibling repos named below.

Target: the private QIP-55 devnet, `chainId` 3151908, the same chain that
`pauli-swap` V2 + V3 is deployed on (`pauli-swap/deployments/devnet.json`).

---

## 1. Toolchain

Build exactly like the QRVM line of `pauli-swap` (`docs/QRVM.md`, "Running it"):

| | |
| --- | --- |
| Compiler | hyperion `main` `f570687a` as the Docker image `hypc:local` (0.2.0-develop), output key `qrvm` |
| Node for local runs | `gqrl:local` (go-zond `b92884a3`, gqrl 0.3.3), `--dev` |
| Client | `@theqrl/web3` 1.0.3, `@theqrl/wallet.js` 6.3.0 |
| QRC base contracts | `@theqrl/qrl-contracts` at commit `d3c84ee` (npm alias `qrl-contracts-qip55`); the npm 0.1.0 release is 20 byte code (QRVM.md Q7) |

The Docker images are built from `QuantumArk/infra/devnet`. Deploy scripts can
follow `pauli-swap/scripts/qrvm/lib.js`, including its refusal of non-private
RPC URLs unless `ALLOW_PUBLIC_RPC=1`.

## 2. Contract rules (QRVM)

- **No public mapping keyed by `address`, `intN`, `bytesN` or a contract
  type.** The compiler's generated getter reads the wrong slot (OC-V3-02,
  QRVM.md Q2). Keep the mapping private and write an explicit view, e.g.
  `xpOf(address)`, `stakeOf(uint256 marketId, address user)`. `uintN` keys and
  arrays are fine as public.
- **No assembly that assumes 32 byte words.** Words are 512 bits, ABI words 64
  bytes, the free memory pointer is at `0x80` (QRVM.md, facts table and Q4).
  Prefer high level code.
- **No `FullMath.mulDiv` from upstream** (QRVM.md Q3). Use the QRVM version in
  `pauli-swap/contracts-qrvm` or plain checked arithmetic.
- **No CREATE2 address derivation on chain** (QRVM.md Q1). If markets are
  separate contracts, the factory stores and emits their addresses; off-chain
  code reads them from events or a view.
- **No `permit` / `ecrecover` / signature checks**: Zond has no `ecrecover`.
  Every spend is an explicit `approve`, and any off-chain attestation (e.g. a
  quest completion) must be a transaction from an authorised account, not a
  signature verified on chain.
- **Stay under `MaxCodeSize` 24,576** bytes; QRVM code is larger than EVM code
  for the same source (QRVM.md Q5). Prefer several small contracts to one large
  one.
- **Short revert strings.** The interface estimates gas before every write and
  shows the revert reason to the user.

## 3. Events

The interface and indexer read history from logs, not from getters.

- Topics are 64 bytes: topic0 is the keccak256 signature right-padded, indexed
  values left-padded. Both consumers already build such filters by hand and call
  `qrl_getLogs` directly (`pauli-swap-interface/src/lib/logs.ts`,
  `pauli-swap-indexer/docs/INDEXER.md` §3.1).
- Emit an event for every state change a screen needs to show history for:
  market created / resolved / cancelled, stake placed, claim, XP credited and
  debited, quest completed. Index the market id and the user address.
- Balances shown in the UI are derived from events where possible, because
  getters on other contracts compiled with this compiler may be wrong
  (INDEXER.md §5).
- Contracts whose addresses are not fixed at deploy time must be announced by
  an event from a contract that is (the factory pattern of INDEXER.md §4).

## 4. Deployment output

The interface pulls ABIs and addresses with `npm run sync:contracts`
(`pauli-swap-interface/scripts/sync-contracts.mjs`). It reads:

- `build/qrvm/index.json`, mapping contract name → `[unit, …]`, and
  `build/qrvm/<unit>/<Name>.json` with an `abi` field;
- `deployments/<network>.json` with `network`, `chainId`, `startBlock`,
  `deployedAt` and a flat `contracts` name → address map.

Produce the same layout here so the script can be pointed at this repo, or
deploy into `pauli-swap/deployments/devnet.json`'s shape under new keys.
`startBlock` matters: the indexer and the interface start log scans from it.

The devnet regenerates from genesis on redeploys. Deployment files must change
(`deployedAt`, addresses, `startBlock`) on every redeploy so consumers detect
the new chain (INDEXER.md §10).

## 5. Interface side

For whoever builds the Predict pages in `pauli-swap-interface`:

- Reads go through the same-origin `/rpc` proxy; the app never calls the RPC
  endpoint directly (CORS, see the interface README).
- Wallet: QRL Web3 Wallet via EIP-6963 (`rdns: theqrl.org`). Writes go through
  `qrl_sendTransaction` with a hex `gas` field (the wallet requires it);
  receipts are polled over HTTP.
- Addresses are 64 bytes (`Q` + 128 hex); compare case-insensitively.
- No mock data anywhere: every number on screen comes from the chain or the
  indexer.
- Routes would follow the existing hash router, e.g. `#/predict`,
  `#/predict/market/:id`, `#/predict/quests`, `#/predict/leaderboard`,
  `#/predict/rewards`.

## 6. Indexer side

`pauli-swap-indexer/docs/INDEXER.md` §15 lists Predict as a future handler
module on the same pipeline (XP, quests, leaderboards). If XP is computed
off chain from PauliSwap activity (`docs/PRODUCT.md` §3), the indexer is
where quest completion is detected. Its design (not built yet) already ingests
V2 and V3 `Swap` / `Mint` with the real transaction sender (INDEXER.md §6,
§7.3), and lists `WQRL` `Deposit` / `Withdrawal` as an optional stat (§8.4);
wrap quests would make that one required.
