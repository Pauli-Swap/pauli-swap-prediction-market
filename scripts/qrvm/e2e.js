const { loadEnv, Chain } = require('./lib');

/// End to end run on a QIP-55 node with fresh contracts and three throwaway
/// traders: quests, check-in, buy / sell, cancel + settle, resolve + claim +
/// settle, and a rebuild of every balance from logs, as the indexer will do it.
///   QRVM_ENV=.env.local-qrvm node scripts/qrvm/e2e.js

const XP = 10n ** 18n;
const YES = 0;
const NO = 1;

/// Seconds until market 0 closes. Its trades must all land before then, and
/// the devnet misses slots (gaps of 120 s were measured between 12 s slots),
/// so the window scales with the worst recent gap; a --dev chain mines on
/// demand and gets the floor. Genesis is skipped: a fresh --dev chain stamps
/// it with time 0, which would make the first gap decades long.
async function closeWindow(web3) {
  const head = await web3.qrl.getBlockNumber();
  let worst = 0;
  let prev;
  for (let i = head > 31n ? head - 30n : 1n; i <= head; i++) {
    const t = Number((await web3.qrl.getBlock(i)).timestamp);
    if (prev !== undefined) worst = Math.max(worst, t - prev);
    prev = t;
  }
  return Math.max(45, 4 * worst + 60);
}

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function expectRevert(signer, contract, method, args, reason) {
  const got = await signer.revertReason(contract, method, args);
  check(`${method} reverts "${reason}"`, got !== null && got.includes(reason), got || 'did not revert');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (v) => BigInt(v);

async function main() {
  const env = loadEnv();
  const admin = await new Chain(env).init();
  console.log(`chain ${admin.chainId}  admin ${admin.address.slice(0, 12)}…`);

  const startBlock = Number(await admin.web3.qrl.getBlockNumber());
  const predictXP = await admin.deploy('PauliPredictXP', [500n * XP, 10n * XP]);
  const market = await admin.deploy('PredictMarket', [predictXP.options.address]);
  await admin.tx(predictXP, 'setMarket', [market.options.address, true]);
  await admin.tx(predictXP, 'setAttester', [admin.address]);
  const now = () => Math.floor(Date.now() / 1000);
  const seasonEnd = now() + 86400;
  await admin.tx(predictXP, 'startSeason', [seasonEnd]);

  const traders = [];
  for (let i = 0; i < 3; i++) {
    const s = await admin.newSigner();
    await admin.send({ to: s.address, value: 5n * XP, label: 'fund trader' });
    s.predictXP = s.at('PauliPredictXP', predictXP.options.address);
    s.market = s.at('PredictMarket', market.options.address);
    traders.push(s);
  }
  const [a, b, c] = traders;
  const nobody = (await admin.newSigner()).address;
  const xpOf = async (s) => big(await admin.call(predictXP, 'xpOf', s.address));

  console.log('quests');
  const today = Number(await admin.call(predictXP, 'today'));
  for (const s of traders) await admin.tx(predictXP, 'creditQuest', [s.address, 1, today, 100n * XP]);
  check('quest credits 100 XP', (await xpOf(a)) === 100n * XP);
  check('questDone view', (await admin.call(predictXP, 'questDone', a.address, 1, today)) === true);
  await expectRevert(admin, predictXP, 'creditQuest', [a.address, 1, today, 1n * XP], 'XP: done');
  await expectRevert(admin, predictXP, 'creditQuest', [a.address, 2, today, 401n * XP], 'XP: daily cap');
  await expectRevert(admin, predictXP, 'creditQuest', [a.address, 2, today - 2, 1n * XP], 'XP: day');
  await expectRevert(admin, predictXP, 'creditQuest', [a.address, 0, today, 1n * XP], 'XP: quest id');
  await expectRevert(a, a.predictXP, 'creditQuest', [a.address, 2, today, 1n * XP], 'XP: attester');
  await admin.tx(predictXP, 'creditQuest', [a.address, 2, today - 1, 20n * XP]);
  check('yesterday is accepted', (await xpOf(a)) === 120n * XP);

  await a.tx(a.predictXP, 'checkIn');
  check('check-in pays 10 XP', (await xpOf(a)) === 130n * XP);
  await expectRevert(a, a.predictXP, 'checkIn', [], 'XP: done');
  await expectRevert(a, a.predictXP, 'debit', [a.address, 1n, '0x' + '00'.repeat(32)], 'XP: market');
  check('isMarket view', (await admin.call(predictXP, 'isMarket', market.options.address)) === true && (await admin.call(predictXP, 'isMarket', a.address)) === false);

  console.log('market 0: trade, resolve, claim');
  const liquidity = 200n * XP;
  await expectRevert(admin, market, 'createMarket', ['late', seasonEnd + 1, liquidity], 'PM: past season');
  const closeIn = await closeWindow(admin.web3);
  console.log(`    market 0 closes in ${closeIn}s`);
  await admin.tx(market, 'createMarket', ['Will WQRL/USDQ cross 1.0 this week?', now() + closeIn, liquidity]);
  const pool = async (id) => {
    const m = await admin.call(market, 'markets', id);
    return { yes: big(m.poolYes), no: big(m.poolNo), status: Number(m.status) };
  };
  let k = liquidity * liquidity;
  const trade = async (s, method, id, outcome, amount, quoteMethod) => {
    const quoted = big(await admin.call(market, quoteMethod, id, outcome, amount));
    await s.tx(s.market, method, [id, outcome, amount, quoted]);
    const p = await pool(id);
    check(`${method} ${outcome === YES ? 'Yes' : 'No'} ${amount / XP} XP keeps k`, p.yes * p.no >= k, `${quoted * 1000n / XP / 1000n} shares`);
    k = p.yes * p.no;
    return quoted;
  };

  await expectRevert(a, a.market, 'buy', [0, YES, 50n * XP, 1000n * XP], 'PM: slippage');
  const aShares = await trade(a, 'buy', 0, YES, 50n * XP, 'quoteBuy');
  await trade(b, 'buy', 0, NO, 30n * XP, 'quoteBuy');
  const cShares = await trade(c, 'buy', 0, YES, 20n * XP, 'quoteBuy');
  const price = big(await admin.call(market, 'priceYes', 0));
  check('Yes price moved above 50%', price > XP / 2n, `${Number(price * 10000n / XP) / 100}%`);
  console.log(`    price Yes after 100 XP of trades on ${liquidity / XP} XP liquidity: ${Number(price * 10000n / XP) / 100}%`);

  const sold = await trade(a, 'sell', 0, YES, 10n * XP, 'quoteSell');
  const posA = await admin.call(market, 'positionOf', 0, a.address);
  check('sell burns quoted shares', big(posA.yesShares) === aShares - sold);
  await expectRevert(c, c.market, 'sell', [0, YES, 100n * XP, 10n ** 30n], 'PM: shares');
  await expectRevert(c, c.market, 'buy', [0, YES, 1000n * XP, 0], 'XP: balance');
  await expectRevert(admin, market, 'resolve', [0, YES], 'PM: not closed');
  await expectRevert(b, b.market, 'settle', [0, [a.address]], 'PM: not settled');
  await expectRevert(admin, market, 'quoteSell', [0, YES, 10000n * XP], 'PM: too much');
  await expectRevert(a, a.market, 'createMarket', ['x', now() + 60, liquidity], 'PM: owner');
  await expectRevert(admin, predictXP, 'startSeason', [seasonEnd + 86400], 'XP: season live');

  console.log('market 1: cancel redeems every share at 0.5 XP');
  await admin.tx(market, 'createMarket', ['Cancelled market', now() + 3600, liquidity]);
  const totalXp = async () => (await xpOf(a)) + (await xpOf(b)) + (await xpOf(c));
  const before = await totalXp();
  // A buys early, C pushes the price up, A sells everything into C for a
  // profit: the sequence that minted XP under the old spent - received refund.
  await a.tx(a.market, 'buy', [1, YES, 40n * XP, 0]);
  await c.tx(c.market, 'buy', [1, YES, 60n * XP, 0]);
  await b.tx(b.market, 'buy', [1, NO, 25n * XP, 0]);
  const aYes = big((await admin.call(market, 'positionOf', 1, a.address)).yesShares);
  let lo = 0n;
  let hi = big((await admin.call(market, 'markets', 1)).poolNo) - 1n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (big(await admin.call(market, 'quoteSell', 1, YES, mid)) <= aYes) lo = mid;
    else hi = mid - 1n;
  }
  await a.tx(a.market, 'sell', [1, YES, lo, aYes]);
  check('A sold for more than it paid', lo > 40n * XP, `${lo / XP} XP`);
  await admin.tx(market, 'cancel', [1]);
  await expectRevert(b, b.market, 'buy', [1, YES, 1n * XP, 0], 'PM: closed');
  const bNo = big((await admin.call(market, 'positionOf', 1, b.address)).noShares);
  const bBefore = await xpOf(b);
  await admin.tx(market, 'settle', [1, [a.address, b.address, c.address, nobody]]);
  check('settle after cancel pays 0.5 XP a share', (await xpOf(b)) - bBefore === bNo / 2n);
  // A's sell can leave a few wei of shares that redeem for 0 and stay put.
  check('settle after cancel leaves nothing to pay', (await Promise.all(traders.map((s) => admin.call(market, 'positionOf', 1, s.address)))).every((p) => (big(p.yesShares) + big(p.noShares)) / 2n === 0n));
  const minted = (await totalXp()) - before;
  check('cancelled market mints nothing', minted <= 0n, `net ${minted / XP} XP`);
  await expectRevert(b, b.market, 'claim', [1], 'PM: nothing');
  await expectRevert(admin, market, 'cancel', [1], 'PM: not open');

  const wait = Number((await admin.call(market, 'markets', 0)).closeTime) - now() + 3;
  if (wait > 0) {
    console.log(`  waiting ${wait}s for market 0 to close`);
    await sleep(wait * 1000);
  }
  // `gqrl --dev --dev.period 0` mines only on a transaction, and calls run
  // against the last block's timestamp, so mine one before checking the close.
  await admin.send({ to: admin.address, label: 'mine a block' });
  await expectRevert(a, a.market, 'buy', [0, YES, 1n * XP, 0], 'PM: closed');
  await expectRevert(admin, market, 'resolve', [0, 2], 'PM: outcome');
  await admin.tx(market, 'resolve', [0, YES]);
  const aBefore = await xpOf(a);
  await a.tx(a.market, 'claim', [0]);
  check('winner A paid 1 XP per share', (await xpOf(a)) - aBefore === aShares - sold);

  // B, not the owner, settles a batch of a claimed winner, an unclaimed
  // winner, a loser and an empty wallet: only C is paid.
  const cBefore = await xpOf(c);
  const bStake = await xpOf(b);
  const bPos = await admin.call(market, 'positionOf', 0, b.address);
  const settleBlock = Number(await admin.web3.qrl.getBlockNumber()) + 1;
  await b.tx(b.market, 'settle', [0, [a.address, b.address, c.address, nobody]]);
  check('settle pays the unclaimed winner', (await xpOf(c)) - cBefore === cShares);
  check('settle skips the loser and leaves its position', (await xpOf(b)) === bStake && big((await admin.call(market, 'positionOf', 0, b.address)).noShares) === big(bPos.noShares));
  const claimedIn = async (from) => (await admin.events(market, 'Claimed', from)).filter((e) => Number(e.id) === 0);
  check('settle emits one Claimed, for C', (await claimedIn(settleBlock)).map((e) => e.user.toLowerCase()).join() === c.address.toLowerCase());
  const again = Number(await admin.web3.qrl.getBlockNumber()) + 1;
  await admin.tx(market, 'settle', [0, [a.address, b.address, c.address]]);
  check('a second settle pays nothing', (await xpOf(c)) - cBefore === cShares && (await claimedIn(again)).length === 0);
  await expectRevert(c, c.market, 'claim', [0], 'PM: nothing');
  await expectRevert(b, b.market, 'claim', [0], 'PM: nothing');
  await expectRevert(a, a.market, 'claim', [0], 'PM: nothing');

  const paid = aShares - sold + cShares + 10n * XP;
  const staked = 100n * XP;
  check('market mints at most its liquidity', paid - staked <= liquidity, `net ${(paid - staked) / XP} XP`);

  console.log('season');
  await expectRevert(admin, predictXP, 'closeSeason', [startBlock, [a.address, b.address, c.address]], 'XP: season live');

  console.log('rebuild balances from logs');
  const balances = new Map();
  for (const [event, sign] of [['XPCredited', 1n], ['XPDebited', -1n]]) {
    for (const l of await admin.events(predictXP, event, startBlock)) {
      const user = l.user.toLowerCase();
      balances.set(user, (balances.get(user) || 0n) + sign * big(l.amount));
    }
  }
  for (const s of traders) {
    const fromLogs = balances.get(s.address.toLowerCase()) || 0n;
    check(`logs match xpOf for ${s.address.slice(0, 10)}…`, fromLogs === (await xpOf(s)), `${fromLogs / XP} XP`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
