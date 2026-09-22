'use strict';
/**
 * cards/engines/zjh.cjs 单测（docs/design-cards.md 第 1/2/3 章）
 * 跑：node --test test/zjh.test.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const engine = require('../engines/zjh.cjs');

const {
  meta, createGame, apply, legalMoves, viewFor, currentActors, briefing, fmtMove,
  evalHand, compareHands, handLabel, sortHand, cardsLabel,
  ALL_CARDS, createRngState, rngNext, CAT
} = engine;

// ------------------------------------------------------------------ fixtures

const NAMES = { a: 'A', b: 'B', c: 'C', d: 'D' };

/**
 * 造一个牌/筹码都摆好的对局。
 * hands = {a:[3 张], b:[3 张]}；opts:
 *   chips     —— {id: 入局筹码}（默认 start_chips），底注在这里面扣
 *   looked    —— 已经看过牌的 id 数组
 *   acts      —— 每人本局已行动次数（默认 0；测比牌要给 1，第一圈闸门才开）
 *   currentBet/current/dealer/firstActor/rules/seed
 * 没进手牌的牌全塞 pile，保证「手牌 + pile === 52」随时可查。
 */
function mk(hands, opts) {
  const o = opts || {};
  const ids = Object.keys(hands);
  const g = createGame({
    players: ids.map((id) => ({ id, name: NAMES[id] || id })),
    seed: o.seed || 'fixture',
    rules: o.rules || {}
  });
  const ante = g.rules.base_bet;
  const used = Object.create(null);
  for (const p of g.players) {
    const h = hands[p.id];
    assert.ok(Array.isArray(h) && h.length === 3, `fixture 少牌：${p.id}`);
    for (const c of h) {
      assert.ok(!used[c], `fixture 重复发牌：${c}`);
      used[c] = true;
    }
    p.cards = sortHand(h);
    p.looked = (o.looked || []).indexOf(p.id) >= 0;
    p.folded = false;
    p.out = false;
    p.acts = o.acts === undefined ? 0 : o.acts;
    const start = (o.chips && o.chips[p.id] !== undefined) ? o.chips[p.id] : g.rules.start_chips;
    assert.ok(start >= ante, 'fixture 筹码不够底注');
    p.chips = start - ante;
    p.bet = ante;
    p.allin = p.chips === 0;
    p.score = p.chips;
  }
  g.pot = ids.length * ante;
  g.totalChips = g.players.reduce((n, p) => n + p.chips, 0) + g.pot;
  g.currentBet = o.currentBet || ante;
  g.pile = ALL_CARDS.filter((c) => !used[c]);
  g.phase = 'betting';
  g.round = o.round || 1;
  g.showdown = null;
  g.lastResults = null;
  g.rounds = [];
  g.dealer = o.dealer || ids[ids.length - 1];
  g.firstActor = o.firstActor || ids[0];
  g.current = o.current || ids[0];
  return g;
}

function P(g, id) {
  return g.players.find((p) => p.id === id);
}

function chipsTotal(g) {
  return g.players.reduce((n, p) => n + p.chips, 0) + g.pot;
}

function cardsTotal(g) {
  return g.players.reduce((n, p) => n + p.cards.length, 0) + g.pile.length;
}

/** 记账不变式 + 牌张守恒，一处调用处处安心 */
function checkInvariants(g, where) {
  assert.equal(chipsTotal(g), g.totalChips, `${where}：筹码不守恒`);
  // 收盘可能发生在「下一局开不起来」的当口，那时牌已经收走了
  if (g.phase !== 'game_over' || g.players.some((p) => p.cards.length)) {
    assert.equal(cardsTotal(g), 52, `${where}：牌张不守恒`);
  }
}

function bet(g, who, amount) {
  return apply(g, who, { type: 'bet', amount }).state;
}

function moveTypes(g, who) {
  return legalMoves(g, who).map((m) => m.type);
}

// ------------------------------------------------------------------ 契约

test('meta：SPEC 拍板的元信息一字不差', () => {
  assert.equal(meta.key, 'zjh');
  assert.equal(meta.name, '炸金花');
  assert.equal(meta.minPlayers, 2);
  assert.equal(meta.maxPlayers, 8);
  assert.deepEqual(meta.defaultRules, {
    blind_play: true, special_235: false, base_bet: 10, start_chips: 1000
  });
  assert.equal(meta.ruleMeta.length, 4);
  assert.deepEqual(meta.ruleMeta.map((r) => r.key), ['blind_play', 'special_235', 'base_bet', 'start_chips']);
  for (const r of meta.ruleMeta) {
    assert.ok(r.label && r.note, `${r.key} 缺中文说明`);
    assert.equal(r.def, meta.defaultRules[r.key], `${r.key} 的 def 跟 defaultRules 对不上`);
  }
  for (const k of ['createGame', 'apply', 'legalMoves', 'viewFor', 'currentActors', 'briefing', 'fmtMove']) {
    assert.equal(typeof engine[k], 'function', `缺导出 ${k}`);
  }
});

test('createGame：规则三种给法都认，脏字段进不来，人数越界中文报错', () => {
  const ps = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  // 平的 config（cards/server.cjs 的 resolveRules 就是这么给的）
  const g1 = createGame({ players: ps, seed: 'r1', config: { base_bet: 25, special_235: true, junk: 1 } });
  assert.equal(g1.rules.base_bet, 25);
  assert.equal(g1.rules.special_235, true);
  assert.equal(g1.rules.junk, undefined, '脏字段不许混进 state.rules');
  assert.equal(g1.pot, 50);
  // {defaults:{}} 写法
  const g2 = createGame({ players: ps, seed: 'r2', config: { defaults: { start_chips: 500 } } });
  assert.equal(g2.rules.start_chips, 500);
  assert.equal(g2.totalChips, 1000);
  // o.rules 优先级最高
  const g3 = createGame({ players: ps, seed: 'r3', config: { base_bet: 25 }, rules: { base_bet: 40 } });
  assert.equal(g3.rules.base_bet, 40);

  assert.throws(() => createGame({ players: [{ id: 'a' }], seed: 'x' }), /2~8 人/);
  assert.throws(() => createGame({
    players: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id) => ({ id })), seed: 'x'
  }), /2~8 人/);
  assert.throws(() => createGame({ players: [{ id: 'a' }, { id: 'a' }], seed: 'x' }), /id 重复/);
  assert.throws(() => createGame({ players: ps, seed: 'x', rules: { start_chips: 5, base_bet: 10 } }), /不能少于底注/);
});

// ------------------------------------------------------------------ 牌力：分类

test('牌力分类：豹子/顺金/金花/顺子/对子/散牌', () => {
  const table = [
    [['S7', 'H7', 'D7'], CAT.BAOZI, '豹子'],
    [['S15', 'H15', 'D15'], CAT.BAOZI, '豹子 2'],       // 2 也能成豹子（强度最小）
    [['S5', 'S6', 'S7'], CAT.SHUNJIN, '顺金'],
    [['S14', 'S13', 'S12'], CAT.SHUNJIN, 'AKQ 顺金'],
    [['S3', 'S9', 'S14'], CAT.JINHUA, '金花'],
    [['S5', 'H6', 'D7'], CAT.SHUNZI, '顺子'],
    [['S8', 'H8', 'D3'], CAT.DUIZI, '对子'],
    [['S9', 'H5', 'D3'], CAT.SANPAI, '散牌']
  ];
  for (const [cards, cat, why] of table) {
    assert.equal(evalHand(cards).cat, cat, why);
  }
});

test('牌力：A 最大 2 最小（id 不改，强度内部映射）', () => {
  assert.equal(engine.cardStrength('S14'), 14);   // A
  assert.equal(engine.cardStrength('S15'), 2);    // 2
  assert.equal(engine.cardStrength('S13'), 13);
  assert.equal(engine.cardLabel('S15'), '♠2');
  assert.equal(engine.cardLabel('S14'), '♠A');
  // 散牌 A 高 > 散牌 K 高；带 2 的散牌是最小的
  assert.equal(compareHands(evalHand(['S14', 'H9', 'D5']), evalHand(['S13', 'H9', 'D5'])), 1);
  assert.equal(compareHands(evalHand(['S15', 'H9', 'D5']), evalHand(['S3', 'H9', 'D5'])), -1);
});

test('牌力：A23 是最小顺，AKQ 是最大顺', () => {
  const a23 = evalHand(['S14', 'H15', 'D3']);     // A,2,3
  const _234 = evalHand(['S15', 'H3', 'D4']);     // 2,3,4
  const akq = evalHand(['S14', 'H13', 'D12']);
  const kqj = evalHand(['S13', 'H12', 'D11']);
  assert.equal(a23.cat, CAT.SHUNZI, 'A23 得是顺子');
  assert.equal(a23.top, 3, 'A23 顶张按 3 算（A 当 1）');
  assert.equal(_234.cat, CAT.SHUNZI);
  assert.equal(akq.cat, CAT.SHUNZI);
  assert.equal(compareHands(a23, _234), -1, 'A23 该输给 234');
  assert.equal(compareHands(akq, kqj), 1);
  assert.equal(compareHands(akq, a23), 1, 'AKQ 该赢 A23');
  // QKA 同花 = 最大顺金
  assert.equal(evalHand(['S14', 'S13', 'S12']).cat, CAT.SHUNJIN);
  // A,2,4 不是顺
  assert.equal(evalHand(['S14', 'H15', 'D4']).cat, CAT.SANPAI);
  // A,K,2 也不是顺
  assert.equal(evalHand(['S14', 'H13', 'D15']).cat, CAT.SANPAI);
});

test('牌力：类型间大小 豹子>顺金>金花>顺子>对子>散牌', () => {
  const order = [
    ['S7', 'H7', 'D7'],        // 豹子 7
    ['S5', 'S6', 'S7'],        // 顺金
    ['S3', 'S9', 'S14'],       // 金花
    ['H5', 'D6', 'C7'],        // 顺子
    ['S8', 'H8', 'D4'],        // 对子
    ['S9', 'H5', 'D3']         // 散牌
  ].map(evalHand);
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      const want = i === j ? 0 : (i < j ? 1 : -1);
      assert.equal(compareHands(order[i], order[j]), want, `第 ${i} 手 vs 第 ${j} 手`);
    }
  }
  // 最小的豹子（三个 2）也大过最大的顺金
  assert.equal(compareHands(evalHand(['S15', 'H15', 'D15']), evalHand(['S14', 'S13', 'S12'])), 1);
});

test('牌力：对子比对再比单张，散牌逐张比，花色不比（真会平手）', () => {
  const kk5 = evalHand(['S13', 'H13', 'D5']);
  const qqA = evalHand(['S12', 'H12', 'D14']);
  const kk9 = evalHand(['S13', 'H13', 'D9']);
  assert.equal(compareHands(kk5, qqA), 1, '对 K 带 5 > 对 Q 带 A');
  assert.equal(compareHands(kk9, kk5), 1, '同对子比单张');
  const a95 = evalHand(['S14', 'H9', 'D5']);
  const a93 = evalHand(['C14', 'D9', 'H3']);
  assert.equal(compareHands(a95, a93), 1, '散牌第三张定胜负');
  // 花色不比：牌面一样就是平手
  assert.equal(compareHands(evalHand(['S9', 'H5', 'D3']), evalHand(['C9', 'D5', 'H3'])), 0);
  assert.equal(compareHands(evalHand(['S9', 'S5', 'S3']), evalHand(['C9', 'C5', 'C3'])), 0, '两手金花牌面相同也平');
});

test('牌力：special_235 开关两态', () => {
  const on = { special_235: true };
  const off = { special_235: false };
  const s235 = evalHand(['S15', 'H3', 'D5']);       // 花色不同的 2/3/5
  const flush235 = evalHand(['S15', 'S3', 'S5']);   // 同花 235 = 金花，不是特殊牌
  const baozi = evalHand(['S14', 'H14', 'D14']);
  const sanpai = evalHand(['S9', 'H5', 'D3']);
  const duizi = evalHand(['S4', 'H4', 'D9']);

  assert.equal(s235.special, true);
  assert.equal(flush235.special, false);
  assert.equal(flush235.cat, CAT.JINHUA);

  // 关：235 就是最小的散牌，被豹子按着打
  assert.equal(compareHands(s235, baozi, off), -1);
  assert.equal(compareHands(baozi, s235, off), 1);
  // 开：只克豹子
  assert.equal(compareHands(s235, baozi, on), 1);
  assert.equal(compareHands(baozi, s235, on), -1);
  // 开：遇别的牌型仍按最小散牌算
  assert.equal(compareHands(s235, sanpai, on), -1);
  assert.equal(compareHands(s235, duizi, on), -1);
  assert.equal(compareHands(flush235, baozi, on), -1, '同花 235 不享受特权');
  // 两手 235 平手
  assert.equal(compareHands(s235, evalHand(['C15', 'D3', 'H5']), on), 0);
  assert.ok(handLabel(s235, on).indexOf('235') >= 0);
  assert.equal(handLabel(s235, off), '散牌 5 高');
});

test('牌力：235 克豹子的三角循环，摊牌不会挂（退回普通牌力裁决）', () => {
  const g = mk({
    a: ['S15', 'H3', 'D5'],       // 235（克豹子）
    b: ['S14', 'H14', 'D14'],     // 豹子 A
    c: ['S9', 'H7', 'D4']         // 散牌 9 高（吃 235）
  }, { rules: { special_235: true }, chips: { a: 20, b: 20, c: 20 }, currentBet: 100 });
  let s = bet(g, 'a', 10);
  s = bet(s, 'b', 10);
  s = bet(s, 'c', 10);
  assert.equal(s.phase, 'round_over');
  checkInvariants(s, '三角循环');
  // 循环时无视 235 特权重裁 -> 豹子 A 赢
  assert.equal(s.lastResults.winners.length, 1);
  assert.equal(s.lastResults.winners[0].playerId, 'b');
});

test('牌力：非法手牌中文报错', () => {
  assert.throws(() => evalHand(['S3', 'H4']), /3 张牌/);
  assert.throws(() => evalHand(['S3', 'S3', 'H4']), /两次/);
  assert.throws(() => evalHand(['S3', 'H4', 'Z9']), /不认识/);
});

// ------------------------------------------------------------------ 开局

test('开局：每人 3 张暗牌、全员扣底注入池、庄家下家先说话', () => {
  const g = createGame({ players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], seed: 'open' });
  assert.equal(g.phase, 'betting');
  assert.equal(g.round, 1);
  assert.equal(g.pot, 30);
  assert.equal(g.currentBet, 10);
  assert.equal(g.totalChips, 3000);
  checkInvariants(g, '开局');
  for (const p of g.players) {
    assert.equal(p.cards.length, 3);
    assert.equal(p.chips, 990);
    assert.equal(p.bet, 10);
    assert.equal(p.looked, false, '默认闷着');
    assert.equal(p.folded, false);
    assert.equal(p.score, p.chips, 'score 就是筹码');
  }
  assert.ok(g.dealer, '得有庄家');
  const nextOf = g.turnOrder[(g.turnOrder.indexOf(g.dealer) + 1) % g.turnOrder.length];
  assert.equal(g.current, nextOf, '庄家下家先行动');
  assert.equal(g.firstActor, nextOf);
  assert.deepEqual(currentActors(g), [g.current]);
});

test('开局：庄家逆时针轮换，筹码带着走', () => {
  let g = createGame({ players: ['a', 'b', 'c'].map((id) => ({ id, name: NAMES[id] })), seed: 'dealer' });
  const d0 = g.dealer;
  // 快进：所有人弃到只剩一个
  const seen = [d0];
  for (let r = 0; r < 3; r++) {
    let guard = 0;
    while (g.phase === 'betting') {
      assert.ok(guard++ < 50, '打不完');
      g = apply(g, g.current, { type: 'fold' }).state;
    }
    assert.equal(g.phase, 'round_over');
    checkInvariants(g, '轮庄');
    g = apply(g, g.players[0].id, { type: 'next_round' }).state;
    seen.push(g.dealer);
  }
  for (let i = 1; i < seen.length; i++) {
    const want = g.turnOrder[(g.turnOrder.indexOf(seen[i - 1]) + 1) % g.turnOrder.length];
    assert.equal(seen[i], want, '庄家该顺着座次挪一位');
  }
  assert.equal(g.players.reduce((n, p) => n + p.chips, 0) + g.pot, 3000);
});

// ------------------------------------------------------------------ 看牌

test('look：看牌不推进行动权，看完接着自己说话', () => {
  const g = mk({ a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'] }, { current: 'a' });
  assert.ok(moveTypes(g, 'a').indexOf('look') >= 0);
  const r = apply(g, 'a', { type: 'look' });
  const s = r.state;
  assert.equal(P(s, 'a').looked, true);
  assert.equal(s.current, 'a', '看牌不该轮到下家');
  assert.equal(s.pot, g.pot, '看牌不花钱');
  assert.ok(r.events.some((e) => e.text.indexOf('看了牌') >= 0), 'events 要报「X 看了牌」');
  assert.equal(moveTypes(s, 'a').indexOf('look'), -1, '看过就没这一招了');
  assert.throws(() => apply(s, 'a', { type: 'look' }), /已经看过/);
  assert.equal(P(s, 'a').acts, 0, '看牌不算一次行动（比牌闸门不认它）');
});

test('look：关掉 blind_play 就是开局全明牌', () => {
  const g = createGame({
    players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    seed: 'nolook', rules: { blind_play: false }
  });
  for (const p of g.players) assert.equal(p.looked, true);
  assert.equal(moveTypes(g, g.current).indexOf('look'), -1);
  assert.throws(() => apply(g, g.current, { type: 'look' }), /没开闷牌/);
  // 明牌跟注全价
  const call = legalMoves(g, g.current).find((m) => m.kind === 'call');
  assert.equal(call.amount, 10);
});

// ------------------------------------------------------------------ 下注

test('bet：闷牌跟注半价（向上取整），明牌跟注全价', () => {
  const g = mk({ a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'] }, { current: 'a', currentBet: 10 });
  const call = legalMoves(g, 'a').find((m) => m.kind === 'call');
  assert.equal(call.amount, 5, '闷牌跟 10 只掏 5');
  assert.equal(call.blind, true);
  let s = bet(g, 'a', 5);
  assert.equal(P(s, 'a').bet, 15);
  assert.equal(s.pot, 25);
  assert.equal(s.currentBet, 10, '跟注不抬注');
  assert.equal(s.current, 'b');
  checkInvariants(s, '闷跟');

  // 明牌跟注全价
  s = apply(s, 'b', { type: 'look' }).state;
  const callB = legalMoves(s, 'b').find((m) => m.kind === 'call');
  assert.equal(callB.amount, 10);
  assert.equal(callB.blind, false);
  s = bet(s, 'b', 10);
  assert.equal(s.pot, 35);
  checkInvariants(s, '明跟');

  // 半价向上取整
  const g2 = mk({ a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'] }, { current: 'a', currentBet: 15 });
  assert.equal(legalMoves(g2, 'a').find((m) => m.kind === 'call').amount, 8);
});

test('bet：跟注给少了 / 掏不出 都中文报错', () => {
  const g = mk({ a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'] }, { current: 'a', currentBet: 20, looked: ['a'] });
  assert.throws(() => bet(g, 'a', 5), /跟注要 20/);
  assert.throws(() => bet(g, 'a', 0), /正整数/);
  assert.throws(() => bet(g, 'a', 5000), /掏不出/);
  assert.throws(() => apply(g, 'b', { type: 'bet', amount: 20 }), /还没轮到你/);
  assert.throws(() => apply(g, 'zzz', { type: 'fold' }), /查无此人/);
  assert.throws(() => apply(g, 'a', { type: 'jump' }), /未知动作/);
});

test('bet：加注抬高当前注，上限默认当前注 ×5', () => {
  const g = mk({ a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'] }, { current: 'a', currentBet: 10, looked: ['a'] });
  const raises = legalMoves(g, 'a').filter((m) => m.kind === 'raise');
  assert.ok(raises.length >= 2 && raises.length <= 3, '建议 2~3 个加注档位');
  assert.deepEqual(raises.map((m) => m.stake), [20, 30, 50]);
  const s = bet(g, 'a', 30);
  assert.equal(s.currentBet, 30, '加注抬高当前注');
  assert.equal(s.pot, 50);
  assert.equal(P(s, 'a').chips, 960);
  checkInvariants(s, '加注');
  assert.throws(() => bet(g, 'a', 60), /加注上限是 50/);
  // 自定义上限
  const g2 = mk({ a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'] },
    { current: 'a', currentBet: 10, looked: ['a'], rules: { max_bet: 25 } });
  assert.throws(() => bet(g2, 'a', 30), /加注上限是 25/);
  assert.equal(bet(g2, 'a', 25).currentBet, 25);
});

test('bet：闷牌加注按半价掏钱、按明牌价抬门槛', () => {
  const g = mk({ a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'] }, { current: 'a', currentBet: 10 });
  const raises = legalMoves(g, 'a').filter((m) => m.kind === 'raise');
  assert.deepEqual(raises.map((m) => [m.amount, m.stake]), [[10, 20], [15, 30], [25, 50]]);
  const s = bet(g, 'a', 15);
  assert.equal(P(s, 'a').chips, 975, '闷牌只掏 15');
  assert.equal(s.currentBet, 30, '门槛按明牌价抬到 30');
  // 下家明牌跟注就得掏 30
  const s2 = apply(s, 'b', { type: 'look' }).state;
  assert.equal(legalMoves(s2, 'b').find((m) => m.kind === 'call').amount, 30);
  checkInvariants(s2, '闷加注');
});

test('bet：筹码不够 = 全押，之后不再行动，摊牌照样参与', () => {
  const g = mk({
    a: ['S7', 'H7', 'D7'],       // 豹子，短码
    b: ['S9', 'H5', 'D3']
  }, { chips: { a: 20, b: 1000 }, currentBet: 100, looked: ['a', 'b'], current: 'a' });
  const mv = legalMoves(g, 'a');
  assert.deepEqual(mv.filter((m) => m.type === 'bet').map((m) => [m.kind, m.amount]), [['allin', 10]]);
  let s = bet(g, 'a', 10);
  assert.equal(P(s, 'a').allin, true);
  assert.equal(P(s, 'a').chips, 0);
  assert.equal(s.current, 'b', '全押后轮到下家');
  assert.deepEqual(currentActors(s), ['b']);
  assert.deepEqual(legalMoves(s, 'a'), [], '全押的人没招可出');
  assert.throws(() => bet(s, 'a', 10), /已经全押/);
  checkInvariants(s, '全押');

  // b 跟注 -> 场上只剩 b 能行动且已说过话 -> 摊牌
  s = bet(s, 'b', 100);
  assert.equal(s.phase, 'round_over');
  assert.equal(s.lastResults.reason, 'showdown');
  assert.equal(s.lastResults.winners[0].playerId, 'a', '全押的人摊牌照样能赢');
  assert.equal(P(s, 'a').chips, 130, '收下全部池底');
  checkInvariants(s, '全押摊牌');
});

// ------------------------------------------------------------------ 比牌

test('compare：开局第一圈禁止比牌', () => {
  const g = createGame({ players: ['a', 'b', 'c'].map((id) => ({ id, name: NAMES[id] })), seed: 'cmp0' });
  const first = g.current;
  const other = g.turnOrder.find((x) => x !== first);
  assert.equal(moveTypes(g, first).indexOf('compare'), -1, '第一圈不该有比牌这一招');
  assert.throws(() => apply(g, first, { type: 'compare', target: other }), /第一圈/);
  // 光看牌不算说过话
  const looked = apply(g, first, { type: 'look' }).state;
  assert.throws(() => apply(looked, first, { type: 'compare', target: other }), /第一圈/);
  // 三个人都说过一次之后才解锁
  let s = g;
  for (let i = 0; i < 3; i++) s = bet(s, s.current, legalMoves(s, s.current).find((m) => m.type === 'bet').amount);
  assert.ok(moveTypes(s, s.current).indexOf('compare') >= 0, '第一圈打完就能比牌了');
  checkInvariants(s, '第一圈');
});

test('compare：付一次当前注（闷牌也按明牌价），输家立刻弃', () => {
  const g = mk({
    a: ['S7', 'H7', 'D7'],       // 豹子
    b: ['S9', 'H5', 'D3'],       // 散牌
    c: ['S12', 'H12', 'D4']      // 对子
  }, { acts: 1, currentBet: 20, current: 'a' });   // a 闷着
  const mv = legalMoves(g, 'a').filter((m) => m.type === 'compare');
  assert.deepEqual(mv.map((m) => m.target).sort(), ['b', 'c']);
  assert.equal(mv[0].cost, 20, '闷牌比牌也按明牌价付');
  const r = apply(g, 'a', { type: 'compare', target: 'b' });
  const s = r.state;
  assert.equal(P(s, 'a').chips, 970, '掏了 20');
  assert.equal(s.pot, 50);
  assert.equal(P(s, 'b').folded, true, '输家立刻弃');
  assert.equal(P(s, 'a').folded, false);
  assert.equal(s.current, 'c');
  assert.ok(r.events.some((e) => e.text.indexOf('比牌') >= 0));
  assert.ok(!r.events.some((e) => e.text.indexOf('♠7') >= 0), '比牌不该把牌摊给全场');
  checkInvariants(s, '比牌');
});

test('compare：平局算发起方输', () => {
  const g = mk({
    a: ['S9', 'H5', 'D3'],
    b: ['C9', 'D5', 'H3'],       // 跟 a 牌面一模一样（花色不比）
    c: ['S12', 'H12', 'D4']
  }, { acts: 1, currentBet: 10, looked: ['a', 'b', 'c'], current: 'a' });
  const s = apply(g, 'a', { type: 'compare', target: 'b' }).state;
  assert.equal(P(s, 'a').folded, true, '平手发起方认输');
  assert.equal(P(s, 'b').folded, false);
  assert.ok(s.log.some((e) => e.text.indexOf('平手') >= 0));
  checkInvariants(s, '平局比牌');
});

test('compare：两人局比一次就等于摊牌，赢家收池', () => {
  const g = mk({
    a: ['S7', 'H7', 'D7'],
    b: ['S9', 'H5', 'D3']
  }, { acts: 1, currentBet: 10, looked: ['a', 'b'], current: 'a' });
  const s = apply(g, 'a', { type: 'compare', target: 'b' }).state;
  assert.equal(s.phase, 'round_over');
  assert.equal(s.lastResults.reason, 'last_standing');
  assert.equal(s.lastResults.winners[0].playerId, 'a');
  assert.equal(P(s, 'a').chips, 1010, '990 - 10(比牌) + 30(池)');
  assert.equal(P(s, 'b').chips, 990);
  assert.equal(s.pot, 0);
  checkInvariants(s, '比到只剩一人');
});

test('compare：目标不对就中文报错', () => {
  const g = mk({
    a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'], c: ['S12', 'H12', 'D4']
  }, { acts: 1, current: 'a' });
  assert.throws(() => apply(g, 'a', { type: 'compare' }), /跟谁比/);
  assert.throws(() => apply(g, 'a', { type: 'compare', target: 'zzz' }), /没找着/);
  assert.throws(() => apply(g, 'a', { type: 'compare', target: 'a' }), /跟自己比/);
  // a 弃牌之后，轮到 b 就比不了 a 了
  const s = apply(g, 'a', { type: 'fold' }).state;
  assert.equal(s.current, 'b');
  assert.throws(() => apply(s, 'b', { type: 'compare', target: 'a' }), /已经弃牌/);
});

// ------------------------------------------------------------------ 结束 / 结算

test('结算：只剩一人未弃就收池，round_over 摊开未弃者的牌', () => {
  const g = mk({
    a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'], c: ['S12', 'H12', 'D4']
  }, { current: 'a', looked: ['a', 'b', 'c'] });
  let s = bet(g, 'a', 10);
  s = apply(s, 'b', { type: 'fold' }).state;
  assert.equal(s.phase, 'betting');
  s = apply(s, 'c', { type: 'fold' }).state;
  assert.equal(s.phase, 'round_over');
  assert.equal(P(s, 'a').chips, 1020, '990 - 10(跟注) + 40(池)');
  assert.equal(s.pot, 0);
  assert.equal(s.showdown.reveal.length, 1);
  assert.ok(s.log.some((e) => e.type === 'reveal' && e.text.indexOf('豹子') >= 0), 'log 要摊未弃者的牌');
  assert.deepEqual(legalMoves(s, 'b'), [{ type: 'next_round' }]);
  assert.deepEqual(currentActors(s), [], 'round_over 不列人（下一局由人点，防自动 AI抢跑）');
  checkInvariants(s, '收池');
});

test('结算：摊牌平手平分池底，余数给行动顺位靠前的', () => {
  const g = mk({
    a: ['S9', 'H5', 'D3'],
    b: ['C9', 'D5', 'H3']
  }, { chips: { a: 20, b: 20 }, currentBet: 100, looked: ['a', 'b'], current: 'a', firstActor: 'a' });
  g.pot += 1; g.totalChips += 1;      // 造个奇数池，查余数归属
  let s = bet(g, 'a', 10);
  s = bet(s, 'b', 10);
  assert.equal(s.phase, 'round_over');
  assert.equal(s.lastResults.winners.length, 2, '平手两家平分');
  assert.equal(s.lastResults.pot, 41);
  assert.equal(P(s, 'a').chips, 21, '20 + 余数 1');
  assert.equal(P(s, 'b').chips, 20);
  checkInvariants(s, '平分');
});

test('next_round / end_match：筹码带着走，终榜按筹码排', () => {
  const g = mk({
    a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3']
  }, { current: 'b', looked: ['a', 'b'] });
  let s = apply(g, 'b', { type: 'fold' }).state;
  assert.equal(s.phase, 'round_over');
  assert.equal(P(s, 'a').chips, 1010);
  assert.throws(() => apply(s, 'a', { type: 'look' }), /不是下注的时候/);
  s = apply(s, 'a', { type: 'next_round' }).state;
  assert.equal(s.round, 2);
  assert.equal(s.phase, 'betting');
  assert.equal(P(s, 'a').chips, 1000, '1010 - 10 底注');
  assert.equal(P(s, 'b').chips, 980);
  assert.equal(s.rounds.length, 1);
  checkInvariants(s, '下一局');

  s = apply(s, 'a', { type: 'end_match' }).state;
  assert.equal(s.phase, 'game_over');
  assert.equal(s.winner, 'a');
  assert.deepEqual(currentActors(s), []);
  assert.deepEqual(legalMoves(s, 'a'), []);
  assert.equal(P(s, 'a').score, P(s, 'a').chips, 'score = chips');
  assert.equal(chipsTotal(s), 2000, '半局收盘池底原路退回');
  assert.throws(() => apply(s, 'a', { type: 'next_round' }), /已经结束/);
});

test('破产：筹码不够底注的人本局自动弃 + log 提示；只剩一个人有钱就收盘', () => {
  const g = mk({
    a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'], c: ['S12', 'H12', 'D4']
  }, { chips: { a: 1000, b: 1000, c: 15 }, current: 'b', looked: ['a', 'b', 'c'] });
  // c 底注后只剩 5，本局先让 a 赢下
  let s = apply(g, 'b', { type: 'fold' }).state;
  s = apply(s, 'c', { type: 'fold' }).state;
  assert.equal(s.phase, 'round_over');
  s = apply(s, s.current, { type: 'next_round' }).state;
  assert.equal(P(s, 'c').out, true, 'c 只剩 5，不够底注 10');
  assert.equal(P(s, 'c').folded, true);
  assert.equal(P(s, 'c').cards.length, 0, '轮空不发牌');
  assert.ok(s.log.some((e) => e.type === 'broke' && e.text.indexOf('轮空') >= 0));
  assert.notEqual(s.current, 'c');
  assert.deepEqual(legalMoves(s, 'c'), [], '轮空的人没招');
  checkInvariants(s, '破产跳过');

  // 把 b 也榨干 -> 下一局开不起来 -> 收盘
  const g2 = mk({
    a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3']
  }, { chips: { a: 1000, b: 12 }, current: 'b', looked: ['a', 'b'], currentBet: 10 });
  let s2 = bet(g2, 'b', 2);            // b 掏不起 10，全押 2
  assert.equal(P(s2, 'b').allin, true);
  s2 = bet(s2, 'a', 10);
  assert.equal(s2.phase, 'round_over');
  assert.equal(P(s2, 'b').chips, 0);
  s2 = apply(s2, s2.current, { type: 'next_round' }).state;
  assert.equal(s2.phase, 'game_over', '只剩一个人掏得起底注 -> 整场结束');
  assert.equal(s2.winner, 'a');
  assert.deepEqual(currentActors(s2), []);
  checkInvariants(s2, '收盘');
});

// ------------------------------------------------------------------ 视图 / 简报

test('viewFor：自己的牌看过才可见，别人的牌摊牌前一律看不见', () => {
  const g = mk({
    a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'], c: ['S12', 'H12', 'D4']
  }, { current: 'a', looked: ['b'] });
  const va = viewFor(g, 'a');
  assert.equal(va.you, 'a');
  assert.equal(va.players.find((p) => p.id === 'a').cards, null, '自己没看牌 -> cards:null');
  assert.equal(va.players.find((p) => p.id === 'a').handCount, 3);
  assert.equal(va.players.find((p) => p.id === 'b').cards, null, '别人的牌永远看不见');
  assert.equal(va.players.find((p) => p.id === 'b').looked, true, 'looked 是公开信息');
  assert.equal(va.pot, 30);
  assert.equal(va.currentBet, 10);
  assert.equal(va.current, 'a');
  assert.equal(va.callCost, 5);
  assert.equal(va.rngState, undefined, 'rngState 不外泄');
  assert.equal(va.pile, undefined, '牌堆不外泄');
  for (const p of va.players) {
    for (const k of ['chips', 'bet', 'looked', 'folded', 'allin']) {
      assert.notEqual(p[k], undefined, `他人视图缺 ${k}`);
    }
  }
  // 看过牌之后自己可见
  const s = apply(g, 'a', { type: 'look' }).state;
  assert.deepEqual(viewFor(s, 'a').players.find((p) => p.id === 'a').cards, P(s, 'a').cards);
  assert.equal(viewFor(s, 'b').players.find((p) => p.id === 'a').cards, null);
  // 观战：谁的牌都看不到
  const vo = viewFor(s, null);
  assert.equal(vo.you, null);
  assert.ok(vo.players.every((p) => p.cards === null));
});

test('viewFor：round_over 未弃牌者的牌全员可见', () => {
  const g = mk({
    a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'], c: ['S12', 'H12', 'D4']
  }, { chips: { a: 20, b: 20, c: 20 }, currentBet: 100, looked: ['a', 'b', 'c'], current: 'a' });
  let s = bet(g, 'a', 10);
  s = apply(s, 'b', { type: 'fold' }).state;
  s = bet(s, 'c', 10);
  assert.equal(s.phase, 'round_over');
  const v = viewFor(s, 'c');
  assert.deepEqual(v.players.find((p) => p.id === 'a').cards, P(s, 'a').cards, '摊牌了');
  assert.equal(v.players.find((p) => p.id === 'a').hand, '豹子 7');
  assert.equal(v.players.find((p) => p.id === 'b').cards, null, '弃了的人不摊');
  assert.equal(viewFor(s, null).players.find((p) => p.id === 'c').cards !== null, true, '观战也看得到摊牌');
  assert.equal(v.showdown.reveal.length, 2);
});

test('briefing / fmtMove：说人话', () => {
  const g = mk({ a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'] }, { current: 'a', currentBet: 20 });
  const b0 = briefing(g, 'a');
  assert.ok(b0.indexOf('炸金花') >= 0);
  assert.ok(b0.indexOf('暗牌') >= 0, '没看牌就别显示牌面');
  assert.ok(b0.indexOf('♠7') < 0);
  assert.ok(b0.indexOf('池底 20') >= 0);
  assert.ok(b0.indexOf('当前注 20') >= 0);
  assert.ok(b0.indexOf('你跟注要 10') >= 0);
  assert.ok(b0.indexOf('闷着') >= 0);
  assert.ok(b0.indexOf('轮到 你') >= 0);

  const s = apply(g, 'a', { type: 'look' }).state;
  const b1 = briefing(s, 'a');
  assert.ok(b1.indexOf('♠7') >= 0 && b1.indexOf('豹子 7') >= 0, '看过牌就摊给自己');
  assert.ok(briefing(s, 'b').indexOf('♠7') < 0, '别人的简报里没有你的牌');

  assert.equal(fmtMove({ type: 'look' }), '看牌');
  assert.equal(fmtMove({ type: 'bet', kind: 'call', amount: 20, blind: true }), '跟注 20(闷)');
  assert.equal(fmtMove({ type: 'bet', kind: 'call', amount: 20 }), '跟注 20');
  assert.equal(fmtMove({ type: 'bet', kind: 'raise', amount: 40, stake: 40 }), '加注 40 → 当前注 40');
  assert.equal(fmtMove({ type: 'bet', kind: 'allin', amount: 7 }), '全押 7');
  assert.equal(fmtMove({ type: 'fold' }), '弃牌');
  assert.equal(fmtMove({ type: 'compare', target: 'b', targetName: '小红' }), '比牌 → 小红');
  assert.equal(fmtMove({ type: 'next_round' }), '开下一局');
  assert.equal(fmtMove('end_match'), '收盘');
  // legalMoves 出来的每一招都得能翻成人话
  for (const m of legalMoves(g, 'a')) assert.ok(fmtMove(m).length > 0, JSON.stringify(m));
});

test('legalMoves：顺序 = 看牌 -> 跟注 -> 加注 -> 弃牌 -> 比牌', () => {
  const g = mk({
    a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'], c: ['S12', 'H12', 'D4']
  }, { acts: 1, current: 'a', currentBet: 10 });
  const mv = legalMoves(g, 'a');
  assert.equal(mv[0].type, 'look');
  assert.equal(mv[1].type, 'bet');
  assert.equal(mv[1].kind, 'call');
  const foldAt = mv.findIndex((m) => m.type === 'fold');
  const cmpAt = mv.findIndex((m) => m.type === 'compare');
  assert.ok(mv.slice(2, foldAt).every((m) => m.kind === 'raise'), '弃牌前面全是加注档位');
  assert.ok(foldAt < cmpAt, '弃牌排在比牌前');
  assert.equal(mv.filter((m) => m.type === 'compare').length, 2);
  assert.deepEqual(legalMoves(g, 'b'), [], '不轮到他就是空数组');
  assert.deepEqual(legalMoves(g, 'zzz'), []);
});

// ------------------------------------------------------------------ 不变式 / 纯函数

test('apply 不改入参，events 就是本次新增的 log', () => {
  const g = mk({ a: ['S7', 'H7', 'D7'], b: ['S9', 'H5', 'D3'] }, { current: 'a', looked: ['a'] });
  const before = JSON.stringify(g);
  const r = apply(g, 'a', { type: 'bet', amount: 10 });
  assert.equal(JSON.stringify(g), before, 'apply 不许改入参');
  assert.equal(r.state.seq, g.seq + 1);
  assert.deepEqual(r.events, r.state.log.slice(g.log.length));
});

test('记账不变式：整局跑下来 Σchips + pot 恒等于初始总和', () => {
  let g = createGame({ players: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: NAMES[id] })), seed: 'money' });
  assert.equal(g.totalChips, 4000);
  const script = [
    { type: 'look' }, { type: 'bet', amount: 10 },
    { type: 'bet', amount: 5 },
    { type: 'look' }, { type: 'bet', amount: 30 },
    { type: 'fold' }
  ];
  for (const act of script) {
    const who = g.current;
    g = apply(g, who, act).state;
    checkInvariants(g, `脚本 ${act.type}`);
    assert.equal(chipsTotal(g), 4000);
  }
  // 再随便打完这一局
  let guard = 0;
  while (g.phase === 'betting') {
    assert.ok(guard++ < 300, '打不完');
    const mv = legalMoves(g, g.current);
    g = apply(g, g.current, mv[0]).state;
    checkInvariants(g, '收尾');
  }
  assert.equal(chipsTotal(g), 4000);
});

// ------------------------------------------------------------------ 随机压测

test('压测：2/3/4 人各随机打满 100 局，不炸、不死锁、账不乱', () => {
  for (const n of [2, 3, 4]) {
    const ids = ['a', 'b', 'c', 'd'].slice(0, n);
    const mkGame = (tag) => createGame({
      players: ids.map((id) => ({ id, name: NAMES[id] })),
      seed: `stress-${n}-${tag}`,
      rules: { special_235: n % 2 === 0, blind_play: true, base_bet: 10, start_chips: 2000 }
    });
    let g = mkGame(0);
    let rs = createRngState('bot-' + n);
    const rnd = (k) => { const [next, v] = rngNext(rs); rs = next; return v % k; };
    let rounds = 0;
    let steps = 0;
    let restarts = 0;
    const seenCat = Object.create(null);
    while (rounds < 100) {
      steps += 1;
      assert.ok(steps < 100000, `n=${n} 步数失控`);
      checkInvariants(g, `n=${n} 第 ${steps} 步`);

      if (g.phase === 'game_over') {
        // 有人被打光了，换一桌接着数够 100 局
        restarts += 1;
        g = mkGame(restarts);
        continue;
      }
      if (g.phase === 'round_over') {
        rounds += 1;
        for (const r of g.lastResults.reveal) seenCat[r.label.slice(0, 2)] = true;
        assert.ok(g.lastResults.winners.length >= 1, '得有赢家');
        if (rounds >= 100) break;
        g = apply(g, g.current, { type: 'next_round' }).state;
        continue;
      }

      const actors = currentActors(g);
      assert.equal(actors.length, 1, `n=${n} 非终局态该恰好一个行动者：phase=${g.phase}`);
      const actor = actors[0];
      const me = P(g, actor);
      assert.ok(me && !me.folded && !me.allin, '轮到的人不该是弃了/全押的');
      const mv = legalMoves(g, actor);
      assert.ok(mv.length > 0, `n=${n} 第 ${steps} 步死锁：${actor}`);
      assert.ok(mv.some((m) => m.type === 'fold'), '任何时候都得能弃牌');
      g = apply(g, actor, mv[rnd(mv.length)]).state;
    }
    assert.equal(rounds, 100, `n=${n} 没打满 100 局`);
    assert.ok(Object.keys(seenCat).length >= 3, `n=${n} 摊牌牌型太单调：${Object.keys(seenCat)}`);
  }
});

test('压测：同 seed 同动作序列 -> 完全一样的牌局（可回放）', () => {
  const run = () => {
    let g = createGame({ players: ['a', 'b', 'c'].map((id) => ({ id, name: NAMES[id] })), seed: 'replay' });
    for (let i = 0; i < 6 && g.phase === 'betting'; i++) {
      const mv = legalMoves(g, g.current);
      g = apply(g, g.current, mv[mv.length - 1]).state;
    }
    return g;
  };
  const a = run(), b = run();
  assert.deepEqual(a.players.map((p) => p.cards), b.players.map((p) => p.cards));
  assert.deepEqual(a.log.map((e) => e.text), b.log.map((e) => e.text));
  assert.equal(a.dealer, b.dealer);
});

// ------------------------------------------------------------------ 双环境导出

test('导出：CommonJS + 浏览器全局都挂得上', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../engines/zjh.cjs'), 'utf8');
  assert.ok(src.indexOf("typeof window !== 'undefined'") >= 0, '缺浏览器全局导出');
  assert.ok(src.indexOf('window.ZjhEngine') >= 0, '缺 window.ZjhEngine');
  const vm = require('node:vm');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.equal(typeof sandbox.window.ZjhEngine.evalHand, 'function');
  assert.equal(sandbox.window.ZjhEngine.evalHand(['S7', 'H7', 'D7']).cat, 6);
  assert.equal(sandbox.window.ZjhEngine.cardsLabel(['S14', 'S15']), '♠A ♠2');
  assert.equal(cardsLabel(['S14', 'S15']), '♠A ♠2');
});



test('拒绝非标准牌号，防止同一张牌用不同拼写绕过重复检测',()=>{
  for(const id of ['S03','S3.0','S+3','S 3','S3 ','S3e0'])assert.equal(engine.parseCard(id),null);
  assert.throws(()=>evalHand(['S3','S03','S3.0']),/不认识/);
  assert.equal(new Set(ALL_CARDS.map(c=>engine.parseCard(c).id)).size,52);
});

test('原型属性不能冒充合法动作',()=>{
  const s=createGame({players:[{id:'a'},{id:'b'}],seed:'prototype'}),before=JSON.stringify(s);
  for(const type of ['constructor','toString','valueOf','__proto__'])assert.throws(()=>apply(s,s.current,{type}),/未知动作/);
  assert.equal(JSON.stringify(s),before);
});


for(const looked of [true,false])test('全押加注不必碰巧等于预设档位：'+(looked?'看牌':'闷牌'),()=>{
  const s=mk({a:['S3','H4','D7'],b:['S4','H5','D8']},{chips:{a:47},looked:looked?['a']:[],rules:{max_bet:100}});
  const move=legalMoves(s,'a').find(m=>m.kind==='raise_allin');assert.ok(move);assert.equal(move.amount,37);
  const next=apply(s,'a',move).state;assert.equal(P(next,'a').chips,0);assert.equal(next.currentBet,looked?37:74);assert.equal(chipsTotal(next),s.totalChips);
  const capped={...s,rules:{...s.rules,max_bet:20}};assert.ok(!legalMoves(capped,'a').some(m=>m.kind==='raise_allin'));
});


test('双人局全押加注后，对手必须有回应机会；看牌不算回应',()=>{
  let s=mk({a:['S3','H4','D7'],b:['S4','H5','D8']},{chips:{a:50,b:100},looked:['a'],acts:1,rules:{max_bet:100}});
  s=apply(s,'a',{type:'bet',amount:40}).state;assert.equal(s.phase,'betting');assert.equal(s.current,'b');
  s=apply(s,'b',{type:'look'}).state;assert.equal(s.phase,'betting');assert.equal(s.current,'b');
  const before=chipsTotal(s);s=apply(s,'b',{type:'bet',amount:40}).state;
  assert.equal(s.phase,'round_over');assert.equal(s.lastResults.pot,100);assert.equal(chipsTotal(s),before);
});

test('多人局全押加注后，即使中间玩家弃牌，最后一人仍能回应',()=>{
  let s=mk({a:['S3','H4','D7'],b:['S4','H5','D8'],c:['S5','H6','D9']},{chips:{a:50,b:100,c:100},looked:['a','b','c'],acts:1,rules:{max_bet:100}});
  const before=chipsTotal(s);s=apply(s,'a',{type:'bet',amount:40}).state;s=apply(s,'b',{type:'fold'}).state;
  assert.equal(s.phase,'betting');assert.equal(s.current,'c');
  s=apply(s,'c',{type:'fold'}).state;assert.equal(s.phase,'round_over');assert.equal(s.lastResults.winners[0].playerId,'a');assert.equal(chipsTotal(s),before);
});
