const { loadEnv, Chain } = require('./lib');
const { tick } = require('./attester');

/// Attester run against fresh contracts on a QIP-55 node, with a stub in place
/// of the indexer's questQueue: the daily cap, a season quest that does not fit
/// and waits, the denylist, no double credit across ticks or within one, a
/// failed credit counted, a dry run that sends nothing, and a wrong signer.
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
  const stats = { credits: 0, failedCredits: 0, lastCreditAt: null };
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

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
