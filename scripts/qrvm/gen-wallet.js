const fs = require('fs');
const path = require('path');
const { MLDSA87 } = require('qrl-wallet-qip55');
const { Web3 } = require('qrl-web3-qip55');
const { ROOT } = require('./lib');

/// Generates a fresh ML-DSA-87 wallet into the env file named by QRVM_ENV,
/// under KEY (default FAUCET_MNEMONIC). The faucet operator gets its own key
/// so its claims never race the deployer / attester nonce.
///   QRVM_ENV=.env.devnet node scripts/qrvm/gen-wallet.js [KEY] [--force]
/// From QuantumArk/infra/devnet/scripts/gen-deployer.js.

const file = path.resolve(ROOT, process.env.QRVM_ENV || '.env.local-qrvm');
const key = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'FAUCET_MNEMONIC';
const force = process.argv.includes('--force');

function upsert(text, name, value) {
  const line = `${name}="${value}"`;
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return (text.endsWith('\n') || text === '' ? text : text + '\n') + line + '\n';
}

const addressOf = (mnemonic) => new Web3().qrl.accounts.seedToAccount(MLDSA87.newWalletFromMnemonic(mnemonic).getHexExtendedSeed()).address;

let env = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const existing = env.match(new RegExp(`^\\s*${key}\\s*=\\s*"?(.+?)"?\\s*$`, 'm'));
if (existing && existing[1].trim().split(/\s+/).length === 34 && !force) {
  console.log(`${path.basename(file)} already holds ${key}; reusing it.`);
  console.log(`  address ${addressOf(existing[1])}`);
  console.log('  pass --force to replace it (the old key becomes unrecoverable)');
} else {
  const wallet = MLDSA87.newWallet();
  const mnemonic = wallet.getMnemonic().trim();
  env = upsert(env, key, mnemonic);
  fs.writeFileSync(file, env);
  console.log(`generated ${key}`);
  console.log(`  address  ${addressOf(mnemonic)}`);
  console.log(`  mnemonic ${mnemonic.split(/\s+/).length} words -> ${path.basename(file)} (never commit it)`);
}
