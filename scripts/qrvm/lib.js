const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Web3 } = require('qrl-web3-qip55');
const { MLDSA87 } = require('qrl-wallet-qip55');

/// QIP-55 plumbing, trimmed from pauli-swap/scripts/qrvm/lib.js: env loading
/// with the private-RPC guard, artifacts, and a signer that sends locally
/// signed ML-DSA-87 transactions.

const ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACTS = path.join(ROOT, 'build', 'qrvm');
const DEPLOYMENTS = path.join(ROOT, 'deployments');

/// Reads only the env file named by QRVM_ENV, never process.env, as pauli-swap does.
function loadEnv() {
  const file = path.resolve(ROOT, process.env.QRVM_ENV || '.env.local-qrvm');
  if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} missing; copy its .example`);
  const env = dotenv.parse(fs.readFileSync(file));
  if (env.ALLOW_PUBLIC_RPC !== '1') {
    const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
    if (!local.test(env.QRL_RPC_URL || '')) {
      throw new Error(`QRL_RPC_URL "${env.QRL_RPC_URL}" is not a private network; set ALLOW_PUBLIC_RPC=1 to override`);
    }
  }
  return env;
}

function artifact(name) {
  const index = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'index.json'), 'utf8'));
  const units = index[name];
  if (!units) throw new Error(`No QRVM artifact for "${name}". Run npm run compile:qrvm.`);
  return JSON.parse(fs.readFileSync(path.join(ARTIFACTS, units[0], `${name}.json`), 'utf8'));
}

const strip = (hex) => hex.replace(/^(0x|Q)/i, '').toLowerCase();

class Chain {
  constructor(env, account) {
    this.env = env;
    this.web3 = new Web3(env.QRL_RPC_URL);
    if (!account) {
      const words = (env.DEPLOYER_MNEMONIC || '').trim().split(/\s+/);
      if (words.length !== 34) throw new Error(`DEPLOYER_MNEMONIC must be 34 words, got ${words.length}`);
      account = this.web3.qrl.accounts.seedToAccount(MLDSA87.newWalletFromMnemonic(words.join(' ')).getHexExtendedSeed());
    }
    if (strip(account.address).length !== 128) throw new Error('QIP-55 needs a 64 byte address');
    this.account = account;
    this.address = account.address;
  }

  async init() {
    this.chainId = Number(await this.web3.qrl.getChainId());
    if (this.env.QRL_CHAIN_ID && Number(this.env.QRL_CHAIN_ID) !== this.chainId) {
      throw new Error(`node reports chain ${this.chainId}, env expects ${this.env.QRL_CHAIN_ID}`);
    }
    return this;
  }

  /// A signer for a fresh random wallet on the same node.
  async newSigner() {
    const account = this.web3.qrl.accounts.seedToAccount(MLDSA87.newWallet().getHexExtendedSeed());
    return new Chain(this.env, account).init();
  }

  /// The nonce is floored at one past the last one this signer used: on the
  /// devnet a node has answered the pending count one short right after
  /// returning the previous receipt (pauli-swap lib.js).
  async send({ to, data = '0x', value = 0n, gas, label }) {
    const from = this.address;
    const [pending, block] = await Promise.all([
      this.web3.qrl.getTransactionCount(from, 'pending'),
      this.web3.qrl.getBlock('latest'),
    ]);
    const nonce = this.nextNonce !== undefined && this.nextNonce > BigInt(pending) ? this.nextNonce : BigInt(pending);
    if (!gas) {
      const estimate = await this.web3.qrl.estimateGas({ from, to, data, value: '0x' + BigInt(value).toString(16) });
      gas = (BigInt(estimate) * 13n) / 10n + 20000n;
    }
    const tip = 1_000_000_000n;
    const baseFee = BigInt(block.baseFeePerGas || 7);
    const signed = await this.account.signTransaction({
      ...(to ? { to } : {}),
      data,
      value: BigInt(value).toString(),
      gas: gas.toString(),
      nonce: Number(nonce),
      chainId: this.chainId,
      type: 2,
      maxPriorityFeePerGas: tip.toString(),
      maxFeePerGas: (baseFee * 2n + tip).toString(),
    });
    const receipt = await this.web3.qrl.sendSignedTransaction(signed.rawTransaction);
    this.nextNonce = nonce + 1n;
    if (BigInt(receipt.status) !== 1n) throw new Error(`${label || 'transaction'} reverted in ${receipt.transactionHash}`);
    return receipt;
  }

  async deploy(name, args = []) {
    const art = artifact(name);
    const data = new this.web3.qrl.Contract(art.abi).deploy({ data: art.bytecode, arguments: args }).encodeABI();
    const receipt = await this.send({ data, label: `deploy ${name}` });
    return this.at(name, receipt.contractAddress);
  }

  at(name, address) {
    const c = new this.web3.qrl.Contract(artifact(name).abi, address);
    c.label = name;
    return c;
  }

  call(contract, method, ...args) {
    return contract.methods[method](...args).call({ from: this.address });
  }

  tx(contract, method, args = [], { value = 0n } = {}) {
    const data = contract.methods[method](...args).encodeABI();
    return this.send({ to: contract.options.address, data, value, label: `${contract.label}.${method}` });
  }

  /// Runs a call that must revert and returns the decoded reason, or null if it did not revert.
  async revertReason(contract, method, args = []) {
    const data = contract.methods[method](...args).encodeABI();
    try {
      await this.web3.qrl.call({ from: this.address, to: contract.options.address, data });
    } catch (error) {
      const inner = error.innerError || error.cause || {};
      return inner.message || error.message || 'reverted';
    }
    return null;
  }

  balance(address) {
    return this.web3.qrl.getBalance(address).then(BigInt);
  }

  /// QRVM topics are 64 byte words (signature right padded) and web3 1.0.3
  /// builds 32 byte filters the node rejects, so the filter is built here and
  /// sent straight to qrl_getLogs, as pauli-swap-interface/src/lib/logs.ts does.
  async events(contract, name, fromBlock) {
    const abi = contract.options.jsonInterface.find((x) => x.type === 'event' && x.name === name);
    const topic0 = '0x' + strip(this.web3.qrl.abi.encodeEventSignature(abi)).padEnd(128, '0');
    const logs = await this.web3.requestManager.send({
      method: 'qrl_getLogs',
      params: [{ address: contract.options.address, fromBlock: '0x' + fromBlock.toString(16), toBlock: 'latest', topics: [topic0] }],
    });
    return logs.map((l) => this.web3.qrl.abi.decodeLog(abi.inputs, l.data, l.topics.slice(1)));
  }
}

function writeDeployment(network, data) {
  fs.mkdirSync(DEPLOYMENTS, { recursive: true });
  const file = path.join(DEPLOYMENTS, `${network}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

module.exports = { ROOT, loadEnv, artifact, Chain, writeDeployment, strip };
