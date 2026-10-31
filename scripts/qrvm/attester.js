const fs = require('fs');
const http = require('http');
const path = require('path');
const { ROOT, loadEnv, Chain } = require('./lib');

/// The quest attester: credits what pauli-swap-indexer's questQueue reports
/// as met and not yet credited, through PauliPredictXP.creditQuest. The
/// indexer owns the rules (src/quests.ts); this bot only re-checks on chain
/// and signs. Without --send it prints the credits it would make.
///
/// It also pays out settled markets: for every resolved or cancelled market,
/// the holders the indexer still shows as claimable are re-checked with
/// positionOf and paid through PredictMarket.settle, SETTLE_BATCH per
/// transaction. Denylisted wallets are paid too; the denylist only blocks
/// quest XP.
///   QRVM_ENV=.env.devnet node scripts/qrvm/attester.js [--send] [--once] [--interval 60]
///
/// Each tick looks at today and yesterday (creditQuest accepts both, so
/// activity just before 00:00 UTC is still credited after it). Season quests
/// come only under today; one that does not fit today's dailyQuestCap is
/// offered again tomorrow. Wallets on quests/denylist.json are skipped.
///
/// In loop mode it serves GET /health on ATTESTER_HEALTH_HOST (default
/// 127.0.0.1) : ATTESTER_HEALTH_PORT (default 8549): last tick, last credit,
/// failed credits since start, last settle, failed settles, the settled
/// markets that still have someone to pay, and the attester's QRL balance. `ok` is false when the last tick failed or none ran
/// for 3 intervals. Balance thresholds belong to the monitoring side.

const XP = 10n ** 18n;
const SETTLE_BATCH = 20;
const RESOLVED = 1;
const YES = 0;

function denylist() {
  try {
    return new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'quests', 'denylist.json'), 'utf8')).wallets.map((w) => String(w).toLowerCase()));
  } catch {
    return new Set();
  }
}

function newStats() {
  return {
    startedAt: new Date().toISOString(),
    lastTickAt: null,
    lastTickOk: null,
    lastError: null,
    lastCreditAt: null,
    credits: 0,
    failedCredits: 0,
    lastSettleAt: null,
    lastSettleTx: null,
    settles: 0,
    failedSettles: 0,
    unpaidMarkets: [],
  };
}

/// What PredictMarket.settle pays a position, mirroring its _pay.
function payout(market, position) {
  const yes = BigInt(position.yesShares);
  const no = BigInt(position.noShares);
  if (Number(market.status) === RESOLVED) return Number(market.outcome) === YES ? yes : no;
  return (yes + no) / 2n;
}

/// Pays `holders` of settled market `id` in batches. Each holder is checked
/// with positionOf first, so one the chain already paid (the indexer lagging,
/// a restart, a claim from the interface) is not sent again. Without `send`
/// each batch is only simulated. Returns one row per batch.
async function settleMarket(chain, pm, id, holders, { send, batch = SETTLE_BATCH, stats = newStats() }) {
  const m = await chain.call(pm, 'markets', id);
  if (Number(m.status) === 0) throw new Error(`market ${id} is still open`);
  const due = [];
  const seen = new Set();
  for (const user of holders) {
    if (seen.has(user.toLowerCase())) continue;
    seen.add(user.toLowerCase());
    const xp = payout(m, await chain.call(pm, 'positionOf', id, user));
    if (xp > 0n) due.push({ user, xp });
  }
  const rows = [];
  for (let i = 0; i < due.length; i += batch) {
    const chunk = due.slice(i, i + batch);
    const users = chunk.map((d) => d.user);
    const row = { market: id, users: users.length, xp: chunk.reduce((t, d) => t + d.xp, 0n), status: 'settle', gasUsed: null };
    rows.push(row);
    if (!send) {
      const reason = await chain.revertReason(pm, 'settle', [id, users]);
      if (reason) row.status = `simulation reverts: ${reason}`;
      continue;
    }
    try {
      const r = await chain.tx(pm, 'settle', [id, users]);
      row.status = `sent ${r.transactionHash}`;
      row.gasUsed = Number(r.gasUsed);
      stats.settles++;
      stats.lastSettleAt = new Date().toISOString();
      stats.lastSettleTx = r.transactionHash;
    } catch (e) {
      row.status = `error: ${String(e.innerError?.message || e.message || e).slice(0, 80)}`;
      stats.failedSettles++;
    }
  }
  return rows;
}

/// Holders of market `id` the indexer shows with something left to collect.
async function claimableHolders(gql, id) {
  const users = [];
  for (let skip = 0; ; skip += 1000) {
    const { predictPositions } = await gql('query($m: Int, $skip: Int) { predictPositions(market: $m, first: 1000, skip: $skip) { user claimable } }', { m: id, skip });
    users.push(...predictPositions.filter((p) => p.claimable !== '0').map((p) => p.user));
    if (predictPositions.length < 1000) return users;
  }
}

async function settleTick(chain, pm, { send, gql, stats, batch }) {
  const rows = [];
  const count = Number(await chain.call(pm, 'marketCount'));
  for (let id = 0; id < count; id++) {
    if (Number((await chain.call(pm, 'markets', id)).status) === 0) continue;
    const holders = await claimableHolders(gql, id);
    if (holders.length) rows.push(...(await settleMarket(chain, pm, id, holders, { send, batch, stats })));
  }
  stats.unpaidMarkets = [...new Set(rows.filter((r) => !r.status.startsWith('sent')).map((r) => r.market))];
  return rows;
}

/// One pass over the queue, then over settled markets when `pm` is given.
/// `gql` and `denied` are passed in so the test can drive it without an
/// indexer or the real denylist. Returns the credit rows, with the settle
/// rows as `plan.settles`.
async function tick(chain, xp, { send, gql, denied = denylist(), stats = newStats(), pm, batch }) {
  const [today, cap, attester] = await Promise.all([chain.call(xp, 'today').then(Number), chain.call(xp, 'dailyQuestCap').then(BigInt), chain.call(xp, 'attester')]);
  if (String(attester).toLowerCase() !== chain.address.toLowerCase()) throw new Error(`signer ${chain.address} is not the attester ${attester}`);
  const plan = [];
  for (const day of [today, today - 1]) {
    const { questQueue } = await gql('query($day: Int) { questQueue(day: $day) { user questId day xp kind } }', { day });
    // XP already planned this tick per wallet and day, on top of what the chain has.
    const used = new Map();
    for (const c of questQueue) {
      const row = { ...c, status: 'credit' };
      plan.push(row);
      if (denied.has(c.user.toLowerCase())) {
        row.status = 'skip: denylist';
        continue;
      }
      if (await chain.call(xp, 'questDone', c.user, c.questId, c.day)) {
        row.status = 'skip: done on chain';
        continue;
      }
      const key = `${c.user}:${c.day}`;
      if (!used.has(key)) used.set(key, BigInt(await chain.call(xp, 'questXpOnDay', c.user, c.day)));
      const amount = BigInt(c.xp) * XP;
      if (used.get(key) + amount > cap) {
        row.status = c.kind === 'season' ? 'wait: daily cap, tomorrow' : 'skip: daily cap';
        continue;
      }
      used.set(key, used.get(key) + amount);
      if (!send) continue;
      try {
        const r = await chain.tx(xp, 'creditQuest', [c.user, c.questId, c.day, amount]);
        row.status = `sent ${r.transactionHash}`;
        stats.credits++;
        stats.lastCreditAt = new Date().toISOString();
      } catch (e) {
        row.status = `error: ${String(e.innerError?.message || e.message || e).slice(0, 80)}`;
        stats.failedCredits++;
      }
    }
  }
  plan.today = today;
  plan.settles = pm ? await settleTick(chain, pm, { send, gql, stats, batch }) : [];
  return plan;
}

function report(plan, send) {
  const stamp = new Date().toISOString();
  if (!plan.length) console.log(`${stamp} nothing to credit (day ${plan.today})`);
  else {
    console.log(`${stamp} ${send ? 'credits' : 'dry run, would credit'}:`);
    console.table(plan.map((p) => ({ user: `${p.user.slice(0, 10)}…${p.user.slice(-4)}`, quest: p.questId, day: p.day, xp: p.xp, status: p.status })));
  }
  if (plan.settles.length) {
    console.log(`${stamp} ${send ? 'settles' : 'dry run, would settle'}:`);
    console.table(plan.settles.map((r) => ({ market: r.market, users: r.users, xp: Number(r.xp / 10n ** 15n) / 1000, gas: r.gasUsed ?? '', status: r.status })));
  }
}

function serveHealth(chain, stats, { host, port, interval }) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || (req.url || '').split('?')[0] !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"not-found"}');
    }
    let balancePlanck = null;
    try {
      balancePlanck = (await chain.balance(chain.address)).toString();
    } catch (e) {
      stats.lastError = `balance: ${e.message || e}`;
    }
    // The ops monitoring bot marks an HTTP flow failed on `ok: false`, so a
    // failing or stalled loop alerts without the bot knowing this payload.
    const sinceTick = stats.lastTickAt ? (Date.now() - Date.parse(stats.lastTickAt)) / 1000 : 0;
    const ok = stats.lastTickOk !== false && sinceTick <= 3 * interval + 60;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok, attester: chain.address, intervalSeconds: interval, ...stats, balancePlanck }));
  });
  // A taken port must cost only /health: an unhandled 'error' would kill the
  // process, and under restart: unless-stopped stop all crediting.
  server.on('error', (e) => console.error(`${new Date().toISOString()} health disabled: ${e.message}`));
  server.listen(port, host, () => console.log(`health on http://${host}:${port}/health`));
}

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const once = args.includes('--once');
  const interval = Number(args[args.indexOf('--interval') + 1]) || 60;

  const env = loadEnv();
  const network = env.QRVM_NETWORK || 'local-qrvm';
  const indexerUrl = env.INDEXER_URL || 'http://127.0.0.1:4000/graphql';
  const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', `${network}.json`), 'utf8'));
  const gql = async (query, variables) => {
    const res = await fetch(indexerUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    const body = await res.json();
    if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data;
  };

  const chain = await new Chain(env).init();
  const xp = chain.at('PauliPredictXP', deployment.contracts.PauliPredictXP);
  const pm = chain.at('PredictMarket', deployment.contracts.PredictMarket);
  const stats = newStats();
  console.log(`attester ${chain.address}  indexer ${indexerUrl}  ${send ? 'SENDING' : 'dry run'}`);
  if (!once) serveHealth(chain, stats, { host: env.ATTESTER_HEALTH_HOST || '127.0.0.1', port: Number(env.ATTESTER_HEALTH_PORT || 8549), interval });
  for (;;) {
    stats.lastTickAt = new Date().toISOString();
    try {
      report(await tick(chain, xp, { send, gql, stats, pm }), send);
      stats.lastTickOk = true;
    } catch (e) {
      stats.lastTickOk = false;
      stats.lastError = String(e.message || e);
      console.error(`${new Date().toISOString()} tick failed: ${stats.lastError}`);
      if (once) process.exitCode = 1;
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

module.exports = { tick, settleMarket, SETTLE_BATCH };

if (require.main === module) main();
