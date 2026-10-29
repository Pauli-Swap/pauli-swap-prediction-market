const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { MLDSA87 } = require('qrl-wallet-qip55');
const { ROOT, loadEnv, Chain } = require('./lib');

/// The PauliSwap faucet service: sponsored QRL claims for devnet testers, who
/// arrive with an empty account and cannot pay gas themselves.
///   GET  /status            faucet, terms and balance
///   POST /claim {address}   sends QrlFaucet.claimFor(address), gas paid by the operator
/// Both answer under /faucet/… as well, the path the interface proxies.
///
/// The contract enforces one drip per address per cooldown; this service adds
/// a per-IP limit the chain cannot see, refuses wallets on
/// quests/denylist.json, and sends one transaction at a time. Each claim is
/// appended to data/faucet-claims.jsonl with a salted hash of the client IP,
/// never the IP itself, for the sybil report.
/// Ported from QuantumArk/infra/devnet/scripts/faucet-server.js.
///   QRVM_ENV=.env.devnet node scripts/qrvm/faucet-server.js

const env = loadEnv();
const network = env.QRVM_NETWORK || 'local-qrvm';
const HOST = env.FAUCET_HOST || '127.0.0.1';
const PORT = Number(env.FAUCET_PORT || 8548);
const TRUSTED_PROXY = env.FAUCET_TRUSTED_PROXY || '';
const IP_LIMIT = Number(env.FAUCET_IP_LIMIT || 5);
const IP_WINDOW_MS = 24 * 3600 * 1000;
const ADDRESS = /^[Qq][0-9a-fA-F]{128}$/;

const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', `faucet-${network}.json`), 'utf8'));
const faucetAddress = deployment.contracts.QrlFaucet;
const DENYLIST = path.join(ROOT, 'quests', 'denylist.json');
const CLAIM_LOG = path.join(ROOT, 'data', 'faucet-claims.jsonl');
const SALT = env.FAUCET_IP_SALT || faucetAddress;

const words = (env.FAUCET_MNEMONIC || '').trim().split(/\s+/);
if (words.length !== 34) throw new Error('FAUCET_MNEMONIC missing; run scripts/qrvm/gen-wallet.js');
const base = new Chain(env);
const operator = new Chain(env, base.web3.qrl.accounts.seedToAccount(MLDSA87.newWalletFromMnemonic(words.join(' ')).getHexExtendedSeed()));
const faucet = operator.at('QrlFaucet', faucetAddress);

const byIp = new Map();

function clientIp(req) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const forwarded = req.headers['x-forwarded-for'];
  if (TRUSTED_PROXY !== '' && peer === TRUSTED_PROXY && typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return peer;
}

/// Only drips count toward the limit, so a refused claim (cooling down, bad
/// address) does not use up a visitor's slots.
function recentDrips(ip) {
  const now = Date.now();
  const recent = (byIp.get(ip) || []).filter((at) => now - at < IP_WINDOW_MS);
  byIp.set(ip, recent);
  return recent;
}

/// Re-read on every claim so the admin can edit the file without a restart.
function denied(address) {
  try {
    const list = JSON.parse(fs.readFileSync(DENYLIST, 'utf8'));
    return (list.wallets || []).some((w) => String(w).toLowerCase() === address.toLowerCase());
  } catch {
    return false;
  }
}

function record(entry) {
  fs.mkdirSync(path.dirname(CLAIM_LOG), { recursive: true });
  fs.appendFileSync(CLAIM_LOG, JSON.stringify(entry) + '\n');
}

let queue = Promise.resolve();
const serial = (job) => {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function status() {
  const [balance, drip, cooldown, total] = await Promise.all([
    operator.balance(faucetAddress),
    faucet.methods.dripAmount().call(),
    faucet.methods.cooldown().call(),
    faucet.methods.totalDripped().call(),
  ]);
  return {
    faucet: faucetAddress,
    balancePlanck: balance.toString(),
    dripPlanck: BigInt(drip).toString(),
    cooldownSeconds: Number(cooldown),
    totalDrippedPlanck: BigInt(total).toString(),
  };
}

async function claim(address) {
  const next = Number(await faucet.methods.nextClaimAt(address).call());
  if (next !== 0) return { status: 429, body: { error: 'cooling-down', nextClaimAt: next } };
  const [balance, drip] = await Promise.all([operator.balance(faucetAddress), faucet.methods.dripAmount().call()]);
  if (balance < BigInt(drip)) return { status: 503, body: { error: 'faucet-empty' } };
  const receipt = await serial(() => operator.tx(faucet, 'claimFor', [address]));
  return { status: 200, body: { hash: receipt.transactionHash, blockNumber: Number(receipt.blockNumber), amountPlanck: BigInt(drip).toString() } };
}

const route = (url) => (url || '').split('?')[0].replace(/^\/faucet(?=\/)/, '');

const server = http.createServer(async (req, res) => {
  try {
    const url = route(req.url);
    if (req.method === 'GET' && url === '/status') return send(res, 200, await status());
    if (req.method === 'POST' && url === '/claim') {
      let address;
      try {
        address = JSON.parse(await readBody(req)).address;
      } catch {
        return send(res, 400, { error: 'bad-request' });
      }
      if (typeof address !== 'string' || !ADDRESS.test(address)) return send(res, 400, { error: 'bad-address' });
      address = `Q${address.slice(1)}`;
      if (denied(address)) return send(res, 403, { error: 'denied' });
      const ip = clientIp(req);
      const slots = recentDrips(ip);
      if (slots.length >= IP_LIMIT) return send(res, 429, { error: 'ip-limit' });
      // The slot is taken before the await: checking now and pushing after the
      // claim let N parallel requests from one IP all pass the limit.
      const slot = Date.now();
      slots.push(slot);
      const release = () => {
        const recent = recentDrips(ip);
        const i = recent.indexOf(slot);
        if (i !== -1) recent.splice(i, 1);
      };
      let result;
      try {
        result = await claim(address);
      } catch (error) {
        release();
        throw error;
      }
      if (result.status !== 200) release();
      const ipHash = crypto.createHash('sha256').update(`${SALT}:${ip}`).digest('hex').slice(0, 16);
      record({ at: new Date().toISOString(), address, ipHash, status: result.status, hash: result.body.hash ?? null });
      console.log(`${new Date().toISOString()} claim ${address.slice(0, 12)}… -> ${result.status}${result.body.hash ? ` ${result.body.hash}` : ''}`);
      return send(res, result.status, result.body);
    }
    return send(res, 404, { error: 'not-found' });
  } catch (error) {
    console.error(`${new Date().toISOString()} error`, error.message);
    return send(res, 502, { error: 'chain-error' });
  }
});

operator.init().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`faucet ${faucetAddress} operator ${operator.address}`);
    console.log(`listening on http://${HOST}:${PORT}`);
  });
});
