const fs = require('fs');
const path = require('path');
const { ROOT, loadEnv, Chain } = require('./lib');
const { settleMarket } = require('./attester');

/// Owner tooling for PredictMarket and the season of PauliPredictXP. Signs with
/// DEPLOYER_MNEMONIC, which must be the owner. Every command that writes is a
/// dry run unless --send: it prints the plan and runs the call through
/// qrl_call, so a revert shows up before anything is signed.
///   QRVM_ENV=.env.devnet node scripts/qrvm/market.js <command> [--send]
///
///   list [--md]                                every market; --md prints README rows
///   create "<question>" <closeTime> [seedXP]   seedXP defaults to 100
///   resolve <id> yes|no
///   cancel <id>
///   settle <id>                                pays every holder of a settled market
///   season:close --snapshot <file>                 refuses while a market is open,
///   season:close --block <n> --winners <q1,q2,q3>  unless --allow-open
///   season:start <endsAt>
///
/// `settle` is what the attester does on its own each tick, for when it is
/// down. It needs no indexer: holders come from the market's Bought logs, and
/// anyone may send it, so it does not check the owner.
///
/// Times are unix seconds or ISO 8601 with an explicit zone ("2026-11-12T00:00Z").
///
/// --snapshot takes the file pauli-swap-indexer's `predict:snapshot` writes;
/// its `closeSeason: { snapshotBlock, winners }` is what gets sent, and its
/// warnings are printed again. A hand-made file may use the same shape or
///   { "season": 1, "snapshotBlock": 26000, "winners": ["Q…", "Q…", "Q…"] }
/// Winners are ranked first to third. Fewer than three are padded with the
/// zero address, since closeSeason takes a fixed address[3].

const XP = 10n ** 18n;
const ZERO = 'Q' + '0'.repeat(128);
const ADDRESS = /^Q[0-9a-fA-F]{128}$/;
const STATUS = ['open', 'resolved', 'cancelled'];

const argv = process.argv.slice(2);
const send = argv.includes('--send');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--snapshot', '--block', '--winners'].includes(argv[i - 1])));
const [command, ...params] = positional;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseTime(text, what) {
  if (/^\d+$/.test(text || '')) return Number(text);
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(text || '')) fail(`${what} "${text}": give unix seconds or ISO 8601 with a zone, e.g. 2026-11-12T00:00Z`);
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) fail(`${what} "${text}" is not a date`);
  return Math.floor(ms / 1000);
}

const iso = (t) => new Date(Number(t) * 1000).toISOString().replace(/(:00)?\.000Z$/, 'Z');
const pct = (p) => `${(Number((BigInt(p) * 10000n) / XP) / 100).toFixed(2)}%`;

async function setup() {
  const env = loadEnv();
  const network = env.QRVM_NETWORK || 'local-qrvm';
  const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', `${network}.json`), 'utf8'));
  const chain = await new Chain(env).init();
  if (deployment.chainId !== undefined && Number(deployment.chainId) !== chain.chainId) fail(`deployments/${network}.json is for chain ${deployment.chainId}, the node is ${chain.chainId}`);
  // A regenerated chain keeps the chain id; the contracts are then gone.
  if ((await chain.web3.qrl.getCode(deployment.contracts.PredictMarket)) === '0x') fail(`no code at PredictMarket ${deployment.contracts.PredictMarket}; deployments/${network}.json is stale`);
  const xp = chain.at('PauliPredictXP', deployment.contracts.PauliPredictXP);
  const pm = chain.at('PredictMarket', deployment.contracts.PredictMarket);
  const head = await chain.web3.qrl.getBlock('latest');
  // Calls run against the head's timestamp and a transaction lands in a later
  // block, so "must be before" checks use the larger of head and wall clock.
  const chainNow = Number(head.timestamp);
  const now = Math.max(chainNow, Math.floor(Date.now() / 1000));
  console.log(`network ${network}  chain ${chain.chainId}  block ${head.number}  ${send ? 'SENDING' : 'dry run'}`);
  return { network, deployment, chain, xp, pm, head: Number(head.number), chainNow, now };
}

async function requireOwner(chain, contract) {
  const owner = String(await chain.call(contract, 'owner'));
  if (owner.toLowerCase() !== chain.address.toLowerCase()) fail(`signer ${chain.address} is not ${contract.label}.owner() ${owner}`);
}

async function execute(chain, contract, method, args) {
  console.log(`call      ${contract.label}.${method}(${args.map((a) => JSON.stringify(typeof a === 'bigint' ? a.toString() : a)).join(', ')})`);
  const reason = await chain.revertReason(contract, method, args);
  if (reason) fail(`simulation reverts: ${reason}`);
  if (!send) return console.log('simulation passes; nothing sent. Re-run with --send to execute.');
  const receipt = await chain.tx(contract, method, args);
  console.log(`sent      ${receipt.transactionHash} in block ${Number(receipt.blockNumber)}`);
  return receipt;
}

async function market(ctx, id) {
  const count = Number(await ctx.chain.call(ctx.pm, 'marketCount'));
  if (!(Number.isInteger(id) && id >= 0 && id < count)) fail(`no market ${id}; there are ${count}`);
  const m = await ctx.chain.call(ctx.pm, 'markets', id);
  return { closeTime: Number(m.closeTime), status: Number(m.status), outcome: Number(m.outcome) };
}

async function list(ctx) {
  const { chain, pm, deployment } = ctx;
  const count = Number(await chain.call(pm, 'marketCount'));
  const from = deployment.startBlock || 0;
  const [created, resolved, cancelled] = await Promise.all(['MarketCreated', 'MarketResolved', 'MarketCancelled'].map((e) => chain.events(pm, e, from)));
  const rows = [];
  for (let id = 0; id < count; id++) {
    const m = await chain.call(pm, 'markets', id);
    const c = created.find((e) => Number(e.id) === id);
    const settled = resolved.find((e) => Number(e.id) === id) || cancelled.find((e) => Number(e.id) === id);
    const by = settled ? (await chain.web3.qrl.getTransaction(settled.transactionHash)).from : null;
    rows.push({
      id,
      closes: iso(m.closeTime),
      status: STATUS[Number(m.status)],
      outcome: Number(m.status) === 1 ? (Number(m.outcome) === 0 ? 'Yes' : 'No') : '',
      yes: pct(await chain.call(pm, 'priceYes', id)),
      seedXP: c ? String(BigInt(c.liquidity) / XP) : '?',
      createdIn: c ? c.blockNumber : '?',
      settledIn: settled ? settled.blockNumber : '',
      by: by ? `${by.slice(0, 11)}…${by.slice(-4)}` : '',
      question: c ? c.question : '?',
    });
  }
  if (argv.includes('--md')) {
    // Same columns as the README table; the resolution rule is written by hand.
    console.log('| # | Closes (UTC) | Question | How to resolve | Status | Outcome | Settled in block | By |');
    console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const closes = r.closes.replace('T', ' ').replace(/Z$/, '');
      console.log(`| ${r.id} | ${closes} | ${r.question} | — | ${r.status} | ${r.outcome || '—'} | ${r.settledIn || '—'} | ${r.by ? `\`${r.by}\`` : '—'} |`);
    }
  } else {
    console.table(rows);
  }
}

async function create(ctx, question, closeText, seedText = '100') {
  if (!question) fail('create needs a question');
  const closeTime = parseTime(closeText, 'closeTime');
  if (!/^\d+$/.test(seedText) || seedText === '0') fail(`seedXP "${seedText}" must be a whole number of XP above 0`);
  const seasonEndsAt = Number(await ctx.chain.call(ctx.xp, 'seasonEndsAt'));
  // The contract only says "PM: close" / "PM: past season".
  if (closeTime <= ctx.now) fail(`closeTime ${iso(closeTime)} is not in the future (now ${iso(ctx.now)})`);
  if (closeTime > seasonEndsAt) fail(`closeTime ${iso(closeTime)} is after the season ends at ${iso(seasonEndsAt)}`);
  await requireOwner(ctx.chain, ctx.pm);
  console.log(`market    #${await ctx.chain.call(ctx.pm, 'marketCount')}  closes ${iso(closeTime)}  seed ${seedText} XP each side`);
  console.log(`question  ${question}`);
  await execute(ctx.chain, ctx.pm, 'createMarket', [question, closeTime, BigInt(seedText) * XP]);
}

async function resolve(ctx, idText, answer) {
  const id = Number(idText);
  const outcome = { yes: 0, no: 1 }[String(answer).toLowerCase()];
  if (outcome === undefined) fail('resolve needs an outcome: yes or no');
  const m = await market(ctx, id);
  if (m.status !== 0) fail(`market ${id} is already ${STATUS[m.status]}`);
  if (ctx.chainNow < m.closeTime) fail(`market ${id} does not close until ${iso(m.closeTime)} (chain time ${iso(ctx.chainNow)})`);
  await requireOwner(ctx.chain, ctx.pm);
  await execute(ctx.chain, ctx.pm, 'resolve', [id, outcome]);
}

async function cancel(ctx, idText) {
  const id = Number(idText);
  const m = await market(ctx, id);
  if (m.status !== 0) fail(`market ${id} is already ${STATUS[m.status]}`);
  await requireOwner(ctx.chain, ctx.pm);
  console.log(`market    #${id}: every Yes and No share will redeem for 0.5 XP`);
  await execute(ctx.chain, ctx.pm, 'cancel', [id]);
}

async function settle(ctx, idText) {
  const { chain, pm, deployment } = ctx;
  const id = Number(idText);
  const m = await market(ctx, id);
  if (m.status === 0) fail(`market ${id} is still open; resolve or cancel it first`);
  const holders = (await chain.events(pm, 'Bought', deployment.startBlock || 0)).filter((e) => Number(e.id) === id).map((e) => e.user);
  const rows = await settleMarket(chain, pm, id, holders, { send });
  if (!rows.length) return console.log(`market    #${id}: nobody left to pay`);
  for (const r of rows) console.log(`settle    #${id}  ${r.users} users  ${Number(r.xp / 10n ** 15n) / 1000} XP  ${r.status}${r.gasUsed ? `  gas ${r.gasUsed}` : ''}`);
  if (rows.some((r) => !r.status.startsWith('sent') && r.status !== 'settle')) process.exitCode = 1;
  else if (!send) console.log('simulation passes; nothing sent. Re-run with --send to execute.');
}

function readSnapshot() {
  const file = flag('--snapshot');
  if (file) {
    const s = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const call = s.closeSeason || s;
    if (!Array.isArray(call.winners)) fail(`${file} has no winners list (closeSeason.winners or winners)`);
    if (s.closeSeason && Number(s.closeSeason.snapshotBlock) !== Number(s.snapshotBlock)) fail(`${file}: closeSeason.snapshotBlock differs from snapshotBlock`);
    for (const w of s.warnings || []) console.warn(`snapshot  WARN ${w}`);
    return { season: s.season, snapshotBlock: Number(call.snapshotBlock), winners: call.winners.filter((w) => w.toLowerCase() !== ZERO.toLowerCase()) };
  }
  if (flag('--block') === undefined || flag('--winners') === undefined) fail('season:close needs --snapshot <file>, or --block <n> --winners <q1,q2,q3>');
  return { season: undefined, snapshotBlock: Number(flag('--block')), winners: flag('--winners').split(',').filter(Boolean) };
}

async function seasonClose(ctx) {
  const { chain, xp } = ctx;
  const snap = readSnapshot();
  if (!Number.isInteger(snap.snapshotBlock) || snap.snapshotBlock < 0) fail('snapshotBlock must be a block number');
  if (snap.winners.length > 3) fail(`${snap.winners.length} winners given; closeSeason records 3`);
  const bad = snap.winners.find((w) => !ADDRESS.test(w));
  if (bad) fail(`winner "${bad}" is not a 64 byte Q address`);
  if (new Set(snap.winners.map((w) => w.toLowerCase())).size !== snap.winners.length) fail('a wallet is listed twice');
  const winners = [...snap.winners, ZERO, ZERO, ZERO].slice(0, 3);

  const season = Number(await chain.call(xp, 'currentSeason'));
  const endsAt = Number(await chain.call(xp, 'seasonEndsAt'));
  if (season === 0) fail('no season has started');
  if (snap.season !== undefined && Number(snap.season) !== season) fail(`snapshot is for season ${snap.season}, the chain is in season ${season}`);
  if (await chain.call(xp, 'seasonClosed', season)) fail(`season ${season} is already closed`);
  if (ctx.chainNow < endsAt) fail(`season ${season} runs until ${iso(endsAt)} (chain time ${iso(ctx.chainNow)})`);
  if (snap.snapshotBlock > ctx.head) fail(`snapshotBlock ${snap.snapshotBlock} is past the head ${ctx.head}`);

  const open = [];
  const count = Number(await chain.call(ctx.pm, 'marketCount'));
  for (let id = 0; id < count; id++) if (Number((await chain.call(ctx.pm, 'markets', id)).status) === 0) open.push(id);
  // Not enforced on chain: an open market can still be resolved and claimed
  // later, and that XP would land after the snapshot.
  if (open.length && !argv.includes('--allow-open')) fail(`markets still open: ${open.join(', ')}; resolve or cancel them first, or pass --allow-open`);
  if (open.length) console.warn(`warning   markets still open: ${open.join(', ')}`);

  await requireOwner(chain, xp);
  console.log(`season    ${season}, ended ${iso(endsAt)}, snapshot block ${snap.snapshotBlock}`);
  winners.forEach((w, i) => console.log(`winner ${i + 1}  ${w === ZERO ? '(none)' : w}`));
  await execute(chain, xp, 'closeSeason', [snap.snapshotBlock, winners]);
}

async function seasonStart(ctx, endsText) {
  const { chain, xp } = ctx;
  const endsAt = parseTime(endsText, 'endsAt');
  const season = Number(await chain.call(xp, 'currentSeason'));
  const current = Number(await chain.call(xp, 'seasonEndsAt'));
  if (ctx.chainNow < current) fail(`season ${season} runs until ${iso(current)}`);
  if (season !== 0 && !(await chain.call(xp, 'seasonClosed', season))) fail(`season ${season} is not closed; run season:close first`);
  if (endsAt <= ctx.now) fail(`endsAt ${iso(endsAt)} is not in the future`);
  await requireOwner(chain, xp);
  console.log(`season    ${season + 1}, ends ${iso(endsAt)}`);
  await execute(chain, xp, 'startSeason', [endsAt]);
}

const COMMANDS = { list, create, resolve, cancel, settle, 'season:close': seasonClose, 'season:start': seasonStart };

async function main() {
  const run = COMMANDS[command];
  if (!run) fail(`unknown command "${command || ''}"; use ${Object.keys(COMMANDS).join(', ')}`);
  await run(await setup(), ...params);
}

main().catch((e) => fail(e.message || String(e)));
