const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, loadEnv, Chain, writeDeployment } = require('./lib');

/// The faucet service's per-IP limit under parallel claims, against a fresh
/// QrlFaucet on a QIP-55 node. Runs scripts/qrvm/faucet-server.js as a child
/// on a free port with its own claim log, so a faucet already serving on this
/// machine is not touched.
///   QRVM_ENV=.env.local-qrvm node scripts/qrvm/faucet-test.js
///
/// With FAUCET_IP_LIMIT=3: one claim, a repeat that cools down and must give
/// its slot back, then 8 parallel claims for fresh wallets from the same IP,
/// of which exactly 2 may drip.

const QRL = 10n ** 18n;
const LIMIT = 3;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

function startServer(envFile) {
  const child = spawn(process.execPath, [path.join(__dirname, 'faucet-server.js')], { env: { ...process.env, QRVM_ENV: envFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`faucet server did not start:\n${log}`)), 30000);
    const onData = (d) => {
      log += d;
      if (/listening on/.test(log)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`faucet server exited ${code}:\n${log}`)));
  });
  return { child, ready };
}

async function main() {
  const env = loadEnv();
  if ((env.QRVM_NETWORK || 'local-qrvm') !== 'local-qrvm') throw new Error('run this against the local chain (.env.local-qrvm)');
  const admin = await new Chain(env).init();
  console.log(`chain ${admin.chainId}  operator ${admin.address.slice(0, 12)}…`);

  const faucet = await admin.deploy('QrlFaucet', [1n * QRL, 3600n]);
  await admin.send({ to: faucet.options.address, value: 20n * QRL, label: 'fund faucet' });
  writeDeployment('faucet-local-qrvm', { network: 'local-qrvm', chainId: admin.chainId, operator: admin.address, contracts: { QrlFaucet: faucet.options.address } });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pauli-faucet-test-'));
  const port = await freePort();
  const claimLog = path.join(tmp, 'claims.jsonl');
  const envFile = path.join(tmp, '.env');
  fs.writeFileSync(
    envFile,
    [
      fs.readFileSync(path.resolve(ROOT, process.env.QRVM_ENV || '.env.local-qrvm'), 'utf8'),
      'QRVM_NETWORK=local-qrvm',
      `FAUCET_MNEMONIC="${env.DEPLOYER_MNEMONIC}"`,
      'FAUCET_HOST=127.0.0.1',
      `FAUCET_PORT=${port}`,
      `FAUCET_IP_LIMIT=${LIMIT}`,
      `FAUCET_CLAIM_LOG="${claimLog.split(path.sep).join('/')}"`,
    ].join('\n')
  );

  const { child, ready } = startServer(envFile);
  try {
    await ready;
    const claim = (address) =>
      fetch(`http://127.0.0.1:${port}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) }).then(async (r) => ({
        status: r.status,
        body: await r.json(),
      }));
    const fresh = async () => (await admin.newSigner()).address;

    console.log('sequential');
    const first = await fresh();
    const r1 = await claim(first);
    check('first claim drips', r1.status === 200, `${r1.status}`);
    const r2 = await claim(first);
    check('repeat cools down', r2.status === 429 && r2.body.error === 'cooling-down', `${r2.status} ${r2.body.error}`);

    console.log(`8 parallel claims, ${LIMIT - 1} slots left`);
    const wallets = await Promise.all(Array.from({ length: 8 }, fresh));
    const results = await Promise.all(wallets.map(claim));
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429 && r.body.error === 'ip-limit').length;
    check(`exactly ${LIMIT - 1} drip`, ok === LIMIT - 1, `${ok} x 200`);
    check('the rest hit the IP limit', limited === 8 - (LIMIT - 1), `${limited} x ip-limit`);

    const total = BigInt(await admin.call(faucet, 'totalDripped'));
    check(`chain shows ${LIMIT} drips in all`, total === BigInt(LIMIT) * QRL, `${total / QRL} QRL`);
    const logged = fs.readFileSync(claimLog, 'utf8').trim().split('\n').length;
    // ip-limit refusals return before the log; the other 4 requests are in it.
    check('claims past the IP check went to the test claim log', logged === 4, `${logged} lines`);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
