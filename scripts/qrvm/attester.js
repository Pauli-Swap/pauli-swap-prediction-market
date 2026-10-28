const fs = require('fs');
const path = require('path');
const { ROOT, loadEnv, Chain } = require('./lib');

/// The quest attester: credits what pauli-swap-indexer's questQueue reports
/// as met and not yet credited, through PauliPredictXP.creditQuest. The
/// indexer owns the rules (src/quests.ts); this bot only re-checks on chain
/// and signs. Without --send it prints the credits it would make.
///   QRVM_ENV=.env.devnet node scripts/qrvm/attester.js [--send] [--once] [--interval 60]
///
/// Each tick looks at today and yesterday (creditQuest accepts both, so
/// activity just before 00:00 UTC is still credited after it). Season quests
/// come only under today; one that does not fit today's dailyQuestCap is
/// offered again tomorrow. Wallets on quests/denylist.json are skipped.

const XP = 10n ** 18n;
const args = process.argv.slice(2);
const send = args.includes('--send');
const once = args.includes('--once');
const interval = Number(args[args.indexOf('--interval') + 1]) || 60;

const env = loadEnv();
const network = env.QRVM_NETWORK || 'local-qrvm';
const INDEXER_URL = env.INDEXER_URL || 'http://127.0.0.1:4000/graphql';
const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments', `${network}.json`), 'utf8'));

async function gql(query, variables) {
  const res = await fetch(INDEXER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data;
}

function denylist() {
  try {
    return new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'quests', 'denylist.json'), 'utf8')).wallets.map((w) => String(w).toLowerCase()));
  } catch {
    return new Set();
  }
}

async function tick(chain, xp) {
  const [today, cap, attester] = await Promise.all([chain.call(xp, 'today').then(Number), chain.call(xp, 'dailyQuestCap').then(BigInt), chain.call(xp, 'attester')]);
  if (String(attester).toLowerCase() !== chain.address.toLowerCase()) throw new Error(`signer ${chain.address} is not the attester ${attester}`);
  const denied = denylist();
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
      } catch (e) {
        row.status = `error: ${String(e.message || e).slice(0, 80)}`;
      }
    }
  }
  const stamp = new Date().toISOString();
  if (!plan.length) return console.log(`${stamp} nothing to credit (day ${today})`);
  console.log(`${stamp} ${send ? 'credits' : 'dry run, would credit'}:`);
  console.table(plan.map((p) => ({ user: `${p.user.slice(0, 10)}…${p.user.slice(-4)}`, quest: p.questId, day: p.day, xp: p.xp, status: p.status })));
}

async function main() {
  const chain = await new Chain(env).init();
  const xp = chain.at('PauliPredictXP', deployment.contracts.PauliPredictXP);
  console.log(`attester ${chain.address}  indexer ${INDEXER_URL}  ${send ? 'SENDING' : 'dry run'}`);
  for (;;) {
    try {
      await tick(chain, xp);
    } catch (e) {
      console.error(`${new Date().toISOString()} tick failed: ${e.message || e}`);
      if (once) process.exitCode = 1;
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

main();
