const { loadEnv, Chain, writeDeployment } = require('./lib');

/// Deploys PauliPredictXP and PredictMarket, wires them, and opens season 1.
///   QRVM_ENV=.env.devnet node scripts/qrvm/deploy.js
/// Defaults are sized for 3 to 20 players; docs/PLAN.md §3.1 explains them.

const XP = 10n ** 18n;

async function main() {
  const env = loadEnv();
  const network = env.QRVM_NETWORK || 'local-qrvm';
  const chain = await new Chain(env).init();
  const startBlock = Number(await chain.web3.qrl.getBlockNumber());
  console.log(`network ${network}  chain ${chain.chainId}  block ${startBlock}`);

  const dailyCap = BigInt(env.DAILY_QUEST_CAP_XP || 500) * XP;
  const checkIn = BigInt(env.CHECK_IN_XP || 10) * XP;
  const seasonDays = Number(env.SEASON_DAYS || 28);

  const predictXP = await chain.deploy('PauliPredictXP', [dailyCap, checkIn]);
  const market = await chain.deploy('PredictMarket', [predictXP.options.address]);
  await chain.tx(predictXP, 'setMarket', [market.options.address]);
  await chain.tx(predictXP, 'setAttester', [env.ATTESTER_ADDRESS || chain.address]);
  const endsAt = Math.floor(Date.now() / 1000) + seasonDays * 86400;
  await chain.tx(predictXP, 'startSeason', [endsAt]);

  const out = {
    network,
    chainId: chain.chainId,
    deployer: chain.address,
    startBlock,
    deployedAt: new Date().toISOString(),
    contracts: { PauliPredictXP: predictXP.options.address, PredictMarket: market.options.address },
    season: { id: 1, endsAt },
  };
  console.log(JSON.stringify(out.contracts, null, 2));
  console.log(`wrote ${writeDeployment(network, out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
