const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { MLDSA87 } = require('qrl-wallet-qip55');
const { ROOT, loadEnv, artifact, Chain, writeDeployment } = require('./lib');

/// Deploys the PauliSwap QrlFaucet, funded from a wallet that holds devnet
/// QRL. Prints the plan and sends nothing unless --send is given.
///   QRVM_ENV=.env.devnet node scripts/qrvm/faucet-deploy.js [--send]
///
/// Two transactions with --send: the funder sends FUND + GAS QRL to the
/// faucet operator (FAUCET_MNEMONIC), then the operator deploys QrlFaucet
/// with FUND as its value. The funder defaults to the QuantumArk devnet
/// operator (FUNDER_ENV, its DEPLOYER_MNEMONIC), a key other services also
/// sign with, so it sends exactly one transfer and waits for its receipt.

const QRL = 10n ** 18n;
const send = process.argv.includes('--send');

function accountFrom(chain, mnemonic, name) {
  const words = (mnemonic || '').trim().split(/\s+/);
  if (words.length !== 34) throw new Error(`${name} must be 34 words, got ${words.length}`);
  return chain.web3.qrl.accounts.seedToAccount(MLDSA87.newWalletFromMnemonic(words.join(' ')).getHexExtendedSeed());
}

const fmt = (planck) => `${(Number(planck) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 4 })} QRL`;

async function main() {
  const env = loadEnv();
  const network = env.QRVM_NETWORK || 'local-qrvm';
  const drip = BigInt(env.FAUCET_DRIP_QRL || 50) * QRL;
  const cooldown = BigInt(env.FAUCET_COOLDOWN_SECONDS || 86_400);
  const fund = BigInt(env.FAUCET_FUND_QRL || 10_000) * QRL;
  const gas = BigInt(env.FAUCET_GAS_QRL || 50) * QRL;

  const base = await new Chain(env).init();
  const operator = await new Chain(env, accountFrom(base, env.FAUCET_MNEMONIC, 'FAUCET_MNEMONIC')).init();
  const funderFile = path.resolve(ROOT, env.FUNDER_ENV || '../QuantumArk/infra/devnet/.env');
  const funderEnv = dotenv.parse(fs.readFileSync(funderFile));
  const funder = await new Chain(env, accountFrom(base, funderEnv.DEPLOYER_MNEMONIC, `DEPLOYER_MNEMONIC in ${funderFile}`)).init();

  const [opBalance, funderBalance, block] = await Promise.all([operator.balance(operator.address), funder.balance(funder.address), base.web3.qrl.getBlockNumber()]);
  const topUp = fund + gas > opBalance ? fund + gas - opBalance : 0n;
  console.log(`network ${network}  chain ${base.chainId}  block ${block}`);
  console.log(`terms     ${fmt(drip)} per claim, cooldown ${cooldown}s, fund ${fmt(fund)}`);
  console.log(`operator  ${operator.address}  holds ${fmt(opBalance)}`);
  console.log(`funder    ${funder.address}  holds ${fmt(funderBalance)}  (${path.relative(ROOT, funderFile)})`);
  console.log(`plan      1. funder -> operator ${fmt(topUp)}${topUp === 0n ? ' (skipped, already funded)' : ''}`);
  console.log(`          2. operator deploys QrlFaucet(${drip}, ${cooldown}) with ${fmt(fund)}`);
  if (!send) return console.log('\ndry run: nothing sent. Re-run with --send to execute.');

  if (topUp > 0n) {
    if (funderBalance < topUp) throw new Error('funder balance too low');
    const r = await funder.send({ to: operator.address, value: topUp, label: 'fund operator' });
    console.log(`funded operator in ${r.transactionHash}`);
  }
  const startBlock = Number(await base.web3.qrl.getBlockNumber());
  const art = artifact('QrlFaucet');
  const data = new base.web3.qrl.Contract(art.abi).deploy({ data: art.bytecode, arguments: [drip, cooldown] }).encodeABI();
  const receipt = await operator.send({ data, value: fund, label: 'deploy QrlFaucet' });
  const out = {
    network,
    chainId: base.chainId,
    operator: operator.address,
    startBlock,
    deployedAt: new Date().toISOString(),
    terms: { dripPlanck: drip.toString(), cooldownSeconds: Number(cooldown) },
    contracts: { QrlFaucet: receipt.contractAddress },
  };
  console.log(JSON.stringify(out.contracts, null, 2));
  console.log(`wrote ${writeDeployment(`faucet-${network}`, out)}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
