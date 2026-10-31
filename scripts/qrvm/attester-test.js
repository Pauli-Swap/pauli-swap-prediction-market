const { loadEnv, Chain } = require('./lib');
const { tick } = require('./attester');

/// Attester run against fresh contracts on a QIP-55 node, with a stub in place
/// of the indexer's questQueue: the daily cap, a season quest that does not fit
/// and waits, the denylist, no double credit across ticks or within one, a
/// failed credit counted, a dry run that sends nothing, and a wrong signer.
/// Then the settle pass, with a stub of predictPositions that lists every
/// holder as claimable the way a lagging indexer would: a resolved market paid
/// in batches on the next tick, a loser and a self-claimed winner left out,
/// and nothing sent on the tick after. It prints the gas of a full batch.
///   QRVM_ENV=.env.local-qrvm node scripts/qrvm/attester-test.js
///
/// Not covered: the season quest actually landing on the next UTC day. A
/// `gqrl --dev` chain has no clock to move, so the retry is shown by raising
/// the cap instead, which takes the same code path on the next tick.

const XP = 10n ** 18n;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const admin = await new Chain(loadEnv()).init();
  console.log(`chain ${admin.chainId}  attester ${admin.address.slice(0, 12)}…`);
  const xp = await admin.deploy('PauliPredictXP', [500n * XP, 10n * XP]);
  await admin.tx(xp, 'setAttester', [admin.address]);
  await admin.tx(xp, 'startSeason', [Math.floor(Date.now() / 1000) + 86400]);
  const today = Number(await admin.call(xp, 'today'));

  const [u1, u2, u3] = await Promise.all([admin.newSigner(), admin.newSigner(), admin.newSigner()]).then((s) => s.map((x) => x.address));
  const queue = {
    [today]: [
      { user: u1, questId: 1, day: today, xp: 300, kind: 'daily' },
      { user: u1, questId: 2, day: today, xp: 300, kind: 'daily' },
      { user: u1, questId: 101, day: today, xp: 300, kind: 'season' },
      { user: u2, questId: 1, day: today, xp: 100, kind: 'daily' },
      { user: u3, questId: 1, day: today, xp: 100, kind: 'daily' },
      { user: u3, questId: 1, day: today, xp: 100, kind: 'daily' },
    ],
    [today - 1]: [{ user: u1, questId: 3, day: today - 1, xp: 450, kind: 'daily' }],
  };
  const gql = async (_query, { day }) => ({ questQueue: queue[day] || [] });
  const denied = new Set([u2.toLowerCase()]);
  const xpOf = async (u) => BigInt(await admin.call(xp, 'xpOf', u));
  const status = (plan, user, questId, nth = 0) => plan.filter((r) => r.user === user && r.questId === questId)[nth]?.status || '';

  console.log('dry run');
  let plan = await tick(admin, xp, { send: false, gql, denied });
  check('dry run plans credits', status(plan, u1, 1) === 'credit');
  check('dry run sends nothing', (await xpOf(u1)) === 0n);

  console.log('tick 1');
  const stats = { credits: 0, failedCredits: 0, lastCreditAt: null, settles: 0, failedSettles: 0, lastSettleAt: null, lastSettleTx: null, unpaidMarkets: [] };
  plan = await tick(admin, xp, { send: true, gql, denied, stats });
  check('first daily quest credited', status(plan, u1, 1).startsWith('sent'));
  check('second daily quest over the cap skipped', status(plan, u1, 2) === 'skip: daily cap');
  check('season quest over the cap waits', status(plan, u1, 101) === 'wait: daily cap, tomorrow');
  check('yesterday has its own cap', status(plan, u1, 3).startsWith('sent'));
  check('denylisted wallet skipped', status(plan, u2, 1) === 'skip: denylist');
  check('duplicate row credited once', status(plan, u3, 1).startsWith('sent') && status(plan, u3, 1, 1) === 'skip: done on chain');
  check('balances on chain', (await xpOf(u1)) === 750n * XP && (await xpOf(u2)) === 0n && (await xpOf(u3)) === 100n * XP, `${(await xpOf(u1)) / XP} / ${(await xpOf(u2)) / XP} / ${(await xpOf(u3)) / XP} XP`);
  check('today counts 300 XP, under the 500 cap', BigInt(await admin.call(xp, 'questXpOnDay', u1, today)) === 300n * XP);
  check('stats count 3 credits', stats.credits === 3 && stats.lastCreditAt !== null, `${stats.credits}`);

  console.log('tick 2, same queue');
  plan = await tick(admin, xp, { send: true, gql, denied, stats });
  check('credited quests are not sent again', ['sent', 'credit'].every((s) => !plan.some((r) => r.status.startsWith(s))), plan.map((r) => r.status).join(', '));
  check('no new credits', stats.credits === 3 && (await xpOf(u1)) === 750n * XP);

  console.log('tick 3, cap raised');
  await admin.tx(xp, 'setParams', [1000n * XP, 10n * XP]);
  plan = await tick(admin, xp, { send: true, gql, denied, stats });
  check('waiting season quest credited on a later tick', status(plan, u1, 101).startsWith('sent'));
  check('skipped daily quest credited on a later tick', status(plan, u1, 2).startsWith('sent'));
  check('balance after retry', (await xpOf(u1)) === 1350n * XP, `${(await xpOf(u1)) / XP} XP`);

  console.log('failures');
  queue[today] = [{ user: u3, questId: 0, day: today, xp: 10, kind: 'daily' }];
  plan = await tick(admin, xp, { send: true, gql, denied, stats });
  check('a reverting credit is reported', status(plan, u3, 0).startsWith('error'), status(plan, u3, 0));
  check('and counted', stats.failedCredits === 1);
  await admin.tx(xp, 'setAttester', [u3]);
  let threw = null;
  try {
    await tick(admin, xp, { send: true, gql, denied, stats });
  } catch (e) {
    threw = e.message;
  }
  check('refuses to run as a non-attester', /is not the attester/.test(threw || ''), threw || 'did not throw');
  await admin.tx(xp, 'setAttester', [admin.address]);

  console.log('settle');
  const pm = await admin.deploy('PredictMarket', [xp.options.address]);
  await admin.tx(xp, 'setMarket', [pm.options.address, true]);
  const traders = [];
  for (let i = 0; i < 23; i++) {
    const t = await admin.newSigner();
    await admin.send({ to: t.address, value: 2n * XP, label: 'fund trader' });
    await admin.tx(xp, 'creditQuest', [t.address, 7, today, 50n * XP]);
    t.pm = t.at('PredictMarket', pm.options.address);
    traders.push(t);
  }
  const [loser, selfClaimer] = traders;
  // A --dev chain stamps each block at least a second after the last, so a
  // burst of transactions runs chain time ahead of the wall clock: close
  // against the head, and later mine until the head passes it.
  const headTime = async () => Number((await admin.web3.qrl.getBlock('latest')).timestamp);
  const closeTime = (await headTime()) + 40;
  await admin.tx(pm, 'createMarket', ['settle test', closeTime, 100n * XP]);
  await loser.tx(loser.pm, 'buy', [0, 1, 10n * XP, 0]);
  for (const t of traders.slice(1)) await t.tx(t.pm, 'buy', [0, 0, 10n * XP, 0]);
  const positions = { 0: traders.map((t) => ({ user: t.address, claimable: '1' })) };
  const gqlBoth = async (query, vars) => (query.includes('predictPositions') ? { predictPositions: vars.skip ? [] : positions[vars.m] || [] } : { questQueue: [] });

  plan = await tick(admin, xp, { send: true, gql: gqlBoth, denied, stats, pm });
  check('an open market is not settled', plan.settles.length === 0);

  while ((await headTime()) < closeTime) await admin.send({ to: admin.address, label: 'mine a block' });
  await admin.tx(pm, 'resolve', [0, 0]);
  await selfClaimer.tx(selfClaimer.pm, 'claim', [0]);
  const yesOf = async (t) => BigInt((await admin.call(pm, 'positionOf', 0, t.address)).yesShares);
  const owed = await Promise.all(traders.map(yesOf));
  const before = await Promise.all(traders.map((t) => xpOf(t.address)));

  plan = await tick(admin, xp, { send: false, gql: gqlBoth, denied, stats, pm });
  check('dry run plans the settle', plan.settles.length === 2 && plan.settles.every((r) => r.status === 'settle'), plan.settles.map((r) => r.status).join(', '));
  check('dry run sends nothing', stats.settles === 0 && (await yesOf(traders[2])) === owed[2]);
  check('unpaid market reported', stats.unpaidMarkets.join() === '0');

  plan = await tick(admin, xp, { send: true, gql: gqlBoth, denied, stats, pm });
  check('resolved market paid on the next tick, in batches of 20', plan.settles.map((r) => r.users).join() === '20,1' && plan.settles.every((r) => r.status.startsWith('sent')), plan.settles.map((r) => `${r.users} ${r.status.slice(0, 12)}`).join(', '));
  const after = await Promise.all(traders.map((t) => xpOf(t.address)));
  check('every unclaimed winner paid its shares', traders.every((_, i) => i < 2 || after[i] - before[i] === owed[i]));
  check('loser and self-claimed winner not paid', after[0] === before[0] && after[1] === before[1]);
  check('health fields', stats.settles === 2 && stats.lastSettleTx && stats.unpaidMarkets.length === 0, `${stats.settles} settles`);
  const full = plan.settles[0].gasUsed;
  console.log(`    gas: ${full} for a batch of 20 (${Math.round(full / 20)} a user), ${plan.settles[1].gasUsed} for 1`);

  plan = await tick(admin, xp, { send: true, gql: gqlBoth, denied, stats, pm });
  check('a second tick sends nothing', plan.settles.length === 0 && stats.settles === 2);

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
