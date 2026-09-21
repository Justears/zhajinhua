'use strict';
/**
 * Bisca 棋牌室 — 炸金花 (Zha Jin Hua) 游戏引擎（纯逻辑，零 I/O）
 *
 * 见 docs/design-cards.md 第 1 章（引擎统一契约）+ 第 2 章（zjh 规则拍板）。
 * - meta                                    // 规则元信息，大厅建房面板吃它
 * - createGame({players, config, rules, seed}) -> state
 * - apply(state, playerId, action) -> {state, events}   // 不改入参，非法动作 throw 中文 Error
 * - legalMoves(state, playerId) -> [move]
 * - viewFor(state, playerId|null) -> 脱敏视图
 * - currentActors(state) -> [playerId]      // 自动 AI/唤醒驱动靠它
 * - briefing(state, playerId) -> 中文局面简报
 * - fmtMove(move) -> 一招的人话
 * 另外导出 evalHand / compareHands / handLabel 等，前端预判直接复用。
 *
 * 所有随机（洗牌/定庄）走 state.rngState 里的确定性 xorshift128，整局可回放。
 *
 * ⚠️ 牌 id 沿用大富豪方案（S3..S15，无王，52 张），但**强度引擎内部自管**：
 *    A（id 里的 14）最大，2（id 里的 15）最小 —— strengthOf(15) === 2。
 *
 * 记账不变式：任何时刻 Σplayers[].chips + pot === state.totalChips。
 */

// ---------------------------------------------------------------- RNG

/** 字符串/数字 seed -> uint32 */
function hashSeed(seed) {
  const s = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 由 seed 展开成 xorshift128 的四个 uint32 */
function createRngState(seed) {
  let h = hashSeed(seed === undefined || seed === null ? 'bisca' : seed);
  const out = [];
  for (let i = 0; i < 4; i++) {
    h ^= (h << 13); h >>>= 0;
    h ^= (h >>> 17);
    h ^= (h << 5); h >>>= 0;
    out.push(h >>> 0);
  }
  if (out.every((v) => v === 0)) out[0] = 0x9e3779b9;
  return out;
}

/** 纯函数推进一步：返回 [新的四元组, uint32 随机数] */
function rngNext(rs) {
  let x = rs[0] >>> 0, y = rs[1] >>> 0, z = rs[2] >>> 0, w = rs[3] >>> 0;
  const t = (x ^ (x << 11)) >>> 0;
  x = y; y = z; z = w;
  w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
  return [[x, y, z, w], w];
}

/** 在 state 上就地取一个 [0, n) 的整数（state 必须是已克隆的工作副本） */
function rndInt(s, n) {
  if (s.secureRandom) return require('node:crypto').randomInt(n);
  const [next, v] = rngNext(s.rngState);
  s.rngState = next;
  return v % n;
}

/** Fisher-Yates，用 state 的 rng */
function shuffle(s, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rndInt(s, i + 1);
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// ---------------------------------------------------------------- 牌

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };
const RANK_SYM = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };

/** 全副 52 张无王，顺序固定（洗牌走 RNG） */
const ALL_CARDS = (() => {
  const out = [];
  for (const s of SUITS) for (let r = 3; r <= 15; r++) out.push(s + r);
  return out;
})();

/** "S3" -> {id,suit,rank}；不合法返回 null */
function parseCard(id) {
  if (typeof id !== 'string' || !/^[SHDC](?:[3-9]|1[0-5])$/.test(id)) return null;
  const suit = id[0];
  if (SUITS.indexOf(suit) < 0) return null;
  const r = Number(id.slice(1));
  if (!Number.isInteger(r) || r < 3 || r > 15) return null;
  return { id, suit, rank: r };
}

/**
 * 炸金花强度：A(id 14) 最大 = 14，2(id 15) 最小 = 2，其余同 id。
 * 即取值域 2..14，id 不改，只在引擎内部映射。
 */
function strengthOf(rank) {
  return rank === 15 ? 2 : rank;
}

function cardStrength(id) {
  const c = parseCard(id);
  return c ? strengthOf(c.rank) : -1;
}

/** 强度值 -> 牌面字符（2..10 / J Q K A） */
function strengthSym(v) {
  return RANK_SYM[v] || String(v);
}

function cardLabel(id) {
  const c = parseCard(id);
  if (!c) return String(id);
  return SUIT_SYM[c.suit] + strengthSym(strengthOf(c.rank));
}

function cardsLabel(ids) {
  return ids.map(cardLabel).join(' ');
}

/** 手牌排序：强度从大到小，同强度按 ♠♥♦♣（只影响显示，比大小不看花色） */
function sortHand(ids) {
  return ids.slice().sort((a, b) => {
    const ca = parseCard(a), cb = parseCard(b);
    if (!ca || !cb) return String(a) < String(b) ? -1 : 1;
    return (strengthOf(cb.rank) - strengthOf(ca.rank))
      || (SUIT_ORDER[ca.suit] - SUIT_ORDER[cb.suit]);
  });
}

// ---------------------------------------------------------------- 牌力

const CAT = {
  BAOZI: 6,      // 豹子（三条）
  SHUNJIN: 5,    // 顺金（同花顺）
  JINHUA: 4,     // 金花（同花）
  SHUNZI: 3,     // 顺子
  DUIZI: 2,      // 对子
  SANPAI: 1      // 散牌
};

const CAT_LABEL = {
  6: '豹子', 5: '顺金', 4: '金花', 3: '顺子', 2: '对子', 1: '散牌'
};

/**
 * 3 张牌的牌力。返回 {cat, key, special, cards, strengths}。
 * key 是同类内部逐项比大小的向量（长度不定，同 cat 的 key 等长）。
 * special = 花色不全同的 2/3/5（special_235 开关打开时克豹子，见 compareHands）。
 * A23 算最小顺（A 当 1，顶张记 3）；AKQ 是最大顺。牌数不对/牌不合法 -> throw。
 */
function evalHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) throw new Error('炸金花每手必须是 3 张牌');
  const seen = Object.create(null);
  const ps = [];
  for (const id of cards) {
    const c = parseCard(id);
    if (!c) throw new Error(`不认识这张牌：${id}`);
    if (seen[id]) throw new Error(`同一张牌出现了两次：${cardLabel(id)}`);
    seen[id] = true;
    ps.push(c);
  }
  const st = ps.map((c) => strengthOf(c.rank)).sort((a, b) => b - a);
  const flush = ps[0].suit === ps[1].suit && ps[1].suit === ps[2].suit;
  const trips = st[0] === st[2];

  let straight = false;
  let top = st[0];
  if (!trips) {
    if (st[0] - 1 === st[1] && st[1] - 1 === st[2]) {
      straight = true;
      top = st[0];
    } else if (st[0] === 14 && st[1] === 3 && st[2] === 2) {
      straight = true;   // A23：A 当 1，顶张 3 —— 全场最小的顺
      top = 3;
    }
  }
  const pairIdx = (st[0] === st[1]) ? 0 : (st[1] === st[2] ? 1 : -1);
  const special = !flush && st[0] === 5 && st[1] === 3 && st[2] === 2;

  let cat, key;
  if (trips) { cat = CAT.BAOZI; key = [st[0]]; }
  else if (straight && flush) { cat = CAT.SHUNJIN; key = [top]; }
  else if (flush) { cat = CAT.JINHUA; key = st.slice(); }
  else if (straight) { cat = CAT.SHUNZI; key = [top]; }
  else if (pairIdx >= 0) {
    const pr = st[pairIdx];
    const kicker = st.find((v) => v !== pr);
    cat = CAT.DUIZI; key = [pr, kicker];
  } else { cat = CAT.SANPAI; key = st.slice(); }

  return { cat, key, special, top, cards: sortHand(cards), strengths: st };
}

function cmpKey(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] === undefined ? -1 : a[i];
    const y = b[i] === undefined ? -1 : b[i];
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 牌力比较：a 大返回 1，b 大返回 -1，一样大返回 0（花色不比，真会平手）。
 * rules.special_235 打开时：花色不同的 235 **只克豹子**，遇别的牌型按最小散牌算
 * （[5,3,2] 本来就是最小的散牌 key，所以不用另外压）。两手都是 235 则平手。
 */
function compareHands(a, b, rules) {
  if (rules && rules.special_235) {
    if (a.special && !b.special && b.cat === CAT.BAOZI) return 1;
    if (b.special && !a.special && a.cat === CAT.BAOZI) return -1;
  }
  if (a.cat !== b.cat) return a.cat > b.cat ? 1 : -1;
  return cmpKey(a.key, b.key);
}

/** 牌力人话："顺金 A 高" / "对子 K 带 5" / "235 克豹子" */
function handLabel(ev, rules) {
  if (!ev) return '（无牌）';
  if (rules && rules.special_235 && ev.special) return '235（克豹子）';
  if (ev.cat === CAT.BAOZI) return `豹子 ${strengthSym(ev.key[0])}`;
  if (ev.cat === CAT.DUIZI) return `对子 ${strengthSym(ev.key[0])} 带 ${strengthSym(ev.key[1])}`;
  if (ev.cat === CAT.SHUNJIN || ev.cat === CAT.SHUNZI) {
    return ev.top === 3 ? `${CAT_LABEL[ev.cat]} A23` : `${CAT_LABEL[ev.cat]} ${strengthSym(ev.top)} 高`;
  }
  return `${CAT_LABEL[ev.cat]} ${strengthSym(ev.key[0])} 高`;
}

// ---------------------------------------------------------------- 常量/默认

/** 四个开关（meta.ruleMeta 用），max_bet 是隐藏可调项不进面板 */
const DEFAULT_RULES = {
  blind_play: true,     // 闷牌：不看牌下注半价；关掉则开局即明牌
  special_235: false,   // 235 克豹子
  base_bet: 10,         // 底注
  start_chips: 1000,    // 每人初始筹码
  max_bet: 0            // 单次加注上限（0 = 自动取当前注 ×5）
};

const meta = {
  key: 'zjh',
  name: '炸金花',
  minPlayers: 2,
  maxPlayers: 8,
  defaultRules: {
    blind_play: true,
    special_235: false,
    base_bet: 10,
    start_chips: 1000
  },
  ruleMeta: [
    { key: 'blind_play', label: '闷牌', note: '不看牌就下注，跟注只要一半（关掉则开局所有人明牌）', def: true },
    { key: 'special_235', label: '235 克豹子', note: '花色不同的 2/3/5 能吃豹子，遇别的牌型算最小散牌', def: false },
    { key: 'base_bet', label: '底注', note: '每局开始每人先扔进池子的筹码，也是第一轮的当前注', def: 10 },
    { key: 'start_chips', label: '初始筹码', note: '每人入局带的筹码，筹码不够底注的人本局轮空', def: 1000 }
  ]
};

// ---------------------------------------------------------------- 工具

function findPlayer(s, id) {
  return s.players.find((p) => p.id === id) || null;
}

/** 还没弃牌的人（含 allin） */
function alivePlayers(s) {
  return s.players.filter((p) => !p.folded);
}

/** turnOrder 上 fromId 之后第一个满足 pred 的人（不含 fromId 自己） */
function nextMatching(s, fromId, pred) {
  const order = s.turnOrder;
  let i = order.indexOf(fromId);
  if (i < 0) i = 0;
  for (let k = 1; k <= order.length; k++) {
    const p = findPlayer(s, order[(i + k) % order.length]);
    if (p && p.id !== fromId && pred(p)) return p;
  }
  return null;
}

/** 该玩家跟注要掏多少（闷牌半价，向上取整） */
function callCost(s, p) {
  return p.looked ? s.currentBet : Math.ceil(s.currentBet / 2);
}

/** 本轮加注能抬到的最高「明牌注额」 */
function maxStake(s) {
  const cap = s.rules.max_bet > 0 ? s.rules.max_bet : s.currentBet * 5;
  return Math.max(cap, s.currentBet);
}

/** 比牌要掏多少（闷牌也按明牌价付） */
function compareCost(s) {
  return s.currentBet;
}

/** 从 firstActor 起算的行动顺位（平分池子的余数给顺位靠前的） */
function actIndex(s, p) {
  const order = s.turnOrder;
  const start = Math.max(0, order.indexOf(s.firstActor));
  const i = order.indexOf(p.id);
  return (i - start + order.length) % order.length;
}

/** 掏筹码进池子，掏空了自动 allin；返回真正掏出去的数目 */
function payChips(s, p, amount) {
  const real = Math.max(0, Math.min(amount, p.chips));
  p.chips -= real;
  p.bet += real;
  s.pot += real;
  if (p.chips === 0) p.allin = true;
  return real;
}

/** SPEC 骨架要求 score，炸金花的分就是筹码 */
function syncScores(s) {
  for (const p of s.players) p.score = p.chips;
}

/** 第一圈没打完不许比牌（allin 的人不算欠行动，否则底注全押会把闸门焊死） */
function compareUnlocked(s) {
  const alive = alivePlayers(s);
  if (alive.length < 2) return false;
  return alive.every((p) => p.acts >= 1 || p.allin);
}

// ---------------------------------------------------------------- state 拷贝 / 日志

function cloneState(s) {
  return {
    seq: s.seq,
    createdAt: s.createdAt,
    phase: s.phase,
    round: s.round,
    turnOrder: s.turnOrder.slice(),
    current: s.current,
    dealer: s.dealer,
    firstActor: s.firstActor,
    players: s.players.map((p) => Object.assign({}, p, { cards: p.cards.slice() })),
    pot: s.pot,
    currentBet: s.currentBet,
    pile: s.pile.slice(),
    showdown: s.showdown ? {
      reason: s.showdown.reason,
      reveal: s.showdown.reveal.map((r) => Object.assign({}, r, { cards: r.cards.slice() }))
    } : null,
    lastResults: s.lastResults ? cloneResults(s.lastResults) : null,
    rounds: s.rounds.map(cloneResults),
    totalChips: s.totalChips,
    winner: s.winner,
    log: s.log.slice(),
    rngState: s.rngState.slice(),
    secureRandom: !!s.secureRandom,
    // 规则表只读，直接共用引用
    rules: s.rules
  };
}

function cloneResults(r) {
  return {
    round: r.round,
    reason: r.reason,
    pot: r.pot,
    winners: r.winners.map((w) => Object.assign({}, w)),
    reveal: r.reveal.map((x) => Object.assign({}, x, { cards: x.cards.slice() }))
  };
}

function logAdd(ctx, type, text) {
  const entry = { seq: ctx.s.log.length + 1, t: ctx.s.seq, text, type };
  ctx.s.log.push(entry);
  ctx.events.push(entry);
  return entry;
}

// ---------------------------------------------------------------- 开局 / 结算

function dealRound(ctx, eligible) {
  const s = ctx.s;
  const deck = shuffle(s, ALL_CARDS);
  let k = 0;
  for (let i = 0; i < 3; i++) {
    for (const p of eligible) p.cards.push(deck[k++]);
  }
  for (const p of eligible) p.cards = sortHand(p.cards);
  s.pile = deck.slice(k);
}

function startRound(ctx) {
  const s = ctx.s;
  const ante = s.rules.base_bet;

  // 庄家：第一局随机，之后逆时针轮换（turnOrder 就是逆时针的座次）
  if (s.dealer === null) s.dealer = s.turnOrder[rndInt(s, s.turnOrder.length)];
  else s.dealer = s.turnOrder[(s.turnOrder.indexOf(s.dealer) + 1) % s.turnOrder.length];

  for (const p of s.players) {
    p.cards = [];
    p.looked = !s.rules.blind_play;   // 关掉闷牌 = 开局就明牌
    p.folded = false;
    p.allin = false;
    p.out = false;
    p.bet = 0;
    p.acts = 0;
    p.owesResponse = false;
  }
  s.pot = 0;
  s.currentBet = ante;
  s.pile = [];
  s.showdown = null;
  s.lastResults = null;

  const eligible = s.players.filter((p) => p.chips >= ante);
  for (const p of s.players) {
    if (p.chips >= ante) continue;
    p.out = true;
    p.folded = true;
  }
  if (eligible.length < 2) {
    logAdd(ctx, 'round', `第 ${s.round} 局开不了：够底注 ${ante} 的只剩 ${eligible.length} 人`);
    endMatch(ctx);
    return;
  }

  logAdd(ctx, 'round', `第 ${s.round} 局开始，庄家 ${findPlayer(s, s.dealer).name}，底注 ${ante}`);
  for (const p of s.players) {
    if (p.out) logAdd(ctx, 'broke', `${p.name} 只剩 ${p.chips} 筹码，不够底注 ${ante}，本局轮空`);
  }
  for (const p of eligible) payChips(s, p, ante);
  logAdd(ctx, 'ante', `${eligible.map((p) => p.name).join('、')} 各交底注 ${ante}，池底 ${s.pot}`);
  dealRound(ctx, eligible);
  logAdd(ctx, 'deal', `发牌完毕，每人 3 张暗牌${s.rules.blind_play ? '（闷着的人跟注半价）' : ''}`);

  s.phase = 'betting';
  const first = nextMatching(s, s.dealer, (p) => !p.folded && !p.allin)
    || (eligible.find((p) => !p.allin) || null);
  s.firstActor = first ? first.id : s.dealer;
  s.current = null;
  syncScores(s);
  advanceTurn(ctx, s.dealer);
  if (s.phase === 'betting' && s.current) {
    logAdd(ctx, 'turn', `${findPlayer(s, s.current).name} 先说话`);
  }
}

/** 挑赢家：能压平全场的人（可能并列）。235/豹子 三角循环时退回普通牌力裁决 */
function pickWinners(s, alive) {
  const evs = alive.map((p) => ({ p, ev: evalHand(p.cards) }));
  const maximal = evs.filter((a) => evs.every((b) => b === a || compareHands(a.ev, b.ev, s.rules) >= 0));
  if (maximal.length) return maximal.map((x) => x.p);
  // 循环克制（235 吃豹子、豹子吃散牌、散牌吃 235）：无视 235 特权重裁
  const plain = { special_235: false };
  let best = evs[0];
  for (const x of evs) if (compareHands(x.ev, best.ev, plain) > 0) best = x;
  return evs.filter((x) => compareHands(x.ev, best.ev, plain) === 0).map((x) => x.p);
}

function settleRound(ctx, reason) {
  const s = ctx.s;
  const alive = alivePlayers(s);
  const reveal = alive.map((p) => {
    const ev = evalHand(p.cards);
    return { playerId: p.id, name: p.name, cards: p.cards.slice(), label: handLabel(ev, s.rules) };
  });
  const winners = alive.length <= 1 ? alive.slice() : pickWinners(s, alive);
  const pot = s.pot;
  const share = winners.length ? Math.floor(pot / winners.length) : 0;
  const rest = pot - share * winners.length;
  const ordered = winners.slice().sort((a, b) => actIndex(s, a) - actIndex(s, b));
  for (const w of winners) w.chips += share;
  if (rest > 0 && ordered.length) ordered[0].chips += rest;
  s.pot = 0;

  const results = {
    round: s.round,
    reason,
    pot,
    winners: ordered.map((w, i) => ({
      playerId: w.id,
      name: w.name,
      gain: share + (i === 0 ? rest : 0),
      net: share + (i === 0 ? rest : 0) - w.bet,
      chips: w.chips
    })),
    reveal
  };
  s.showdown = { reason, reveal: reveal.map((r) => Object.assign({}, r, { cards: r.cards.slice() })) };
  s.lastResults = results;
  s.rounds.push(cloneResults(results));
  s.phase = 'round_over';
  s.current = ordered.length ? ordered[0].id : null;
  syncScores(s);

  if (reason === 'showdown') logAdd(ctx, 'showdown', '摊牌！');
  for (const r of reveal) logAdd(ctx, 'reveal', `${r.name}：${cardsLabel(r.cards)}（${r.label}）`);
  if (winners.length > 1) {
    logAdd(ctx, 'round_over', `第 ${s.round} 局平手，${ordered.map((w) => w.name).join('、')} 平分池底 ${pot}`);
  } else if (winners.length === 1) {
    logAdd(ctx, 'round_over', `第 ${s.round} 局结束：${winners[0].name} 收下池底 ${pot}（现有 ${winners[0].chips}）`);
  } else {
    logAdd(ctx, 'round_over', `第 ${s.round} 局结束：没人收池`);
  }
}

/**
 * 一次行动之后推进：
 *   只剩 1 人没弃 -> 收池；能行动的人 0 个 -> 摊牌；
 *   只剩 1 个能行动、已说过话且无需回应后续加注 -> 摊牌；
 *   否则轮到 fromId 之后第一个没弃没全押的人。
 */
function advanceTurn(ctx, fromId) {
  const s = ctx.s;
  const alive = alivePlayers(s);
  if (alive.length <= 1) { settleRound(ctx, 'last_standing'); return; }
  const actable = alive.filter((p) => !p.allin);
  if (!actable.length) { settleRound(ctx, 'showdown'); return; }
  if (actable.length === 1 && actable[0].acts >= 1 && !actable[0].owesResponse) { settleRound(ctx, 'showdown'); return; }
  const nxt = nextMatching(s, fromId, (p) => !p.folded && !p.allin);
  if (nxt) { s.current = nxt.id; return; }
  // 场上唯一能行动的就是 fromId 自己（仍需行动）
  if (actable.length === 1 && actable[0].id === fromId) { s.current = fromId; return; }
  settleRound(ctx, 'showdown');
}

function endMatch(ctx) {
  const s = ctx.s;
  syncScores(s);
  const board = s.players.slice().sort((a, b) => (b.chips - a.chips)
    || (s.turnOrder.indexOf(a.id) - s.turnOrder.indexOf(b.id)));
  s.winner = board.length ? board[0].id : null;
  s.phase = 'game_over';
  s.current = null;
  logAdd(ctx, 'game_over', `收盘：${board.map((p) => `${p.name} ${p.chips} 筹码`).join('，')}`);
}

// ---------------------------------------------------------------- 动作

function requireTurn(s, p) {
  if (s.phase !== 'betting') throw new Error('现在不是下注的时候');
  if (p.out) throw new Error('你这局筹码不够底注，轮空了');
  if (p.folded) throw new Error('你已经弃牌了，本局歇着吧');
  if (p.allin) throw new Error('你已经全押，等摊牌就行');
  if (s.current !== p.id) throw new Error('还没轮到你说话');
}

function actLook(ctx, p) {
  const s = ctx.s;
  requireTurn(s, p);
  if (!s.rules.blind_play) throw new Error('这桌没开闷牌，牌一直是明的');
  if (p.looked) throw new Error('你已经看过牌了');
  p.looked = true;
  // 看牌不推进行动权：看完接着由他 bet / fold / compare
  logAdd(ctx, 'look', `${p.name} 看了牌`);
}

function actBet(ctx, p, action) {
  const s = ctx.s;
  requireTurn(s, p);
  const amount = action.amount;
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('下注额必须是正整数');
  if (amount > p.chips) throw new Error(`你只有 ${p.chips} 筹码，掏不出 ${amount}`);

  const call = callCost(s, p);
  const blind = !p.looked;
  let kind;
  let stake = s.currentBet;
  if (amount === call) {
    kind = 'call';
  } else if (amount > call) {
    // 闷牌加注按半价掏钱，抬起来的门槛是明牌价（掏 amount = 抬到 amount×2）
    const st = blind ? amount * 2 : amount;
    const cap = maxStake(s);
    if (st <= s.currentBet) throw new Error(`加注要高过当前注 ${s.currentBet}`);
    if (st > cap) throw new Error(`加注上限是 ${cap}，你抬到了 ${st}`);
    kind = 'raise';
    stake = st;
  } else if (amount === p.chips) {
    kind = 'allin';   // 跟不起，全押
  } else {
    throw new Error(`跟注要 ${call}${blind ? '（闷牌半价）' : ''}，你只给了 ${amount}`);
  }

  const paid = payChips(s, p, amount);
  p.acts += 1;
  if (kind === 'raise') {
    s.currentBet = stake;
    for (const other of alivePlayers(s)) if (other.id !== p.id && !other.allin) other.owesResponse = true;
  }
  p.owesResponse = false;
  syncScores(s);

  if (kind === 'raise') {
    logAdd(ctx, 'bet', `${p.name} 加注 ${paid}${blind ? '（闷）' : ''}，当前注抬到 ${s.currentBet}${p.allin ? '，并且全押了' : ''}`);
  } else if (p.allin) {
    logAdd(ctx, 'allin', `${p.name} 全押 ${paid}${blind ? '（闷）' : ''}，池底 ${s.pot}`);
  } else {
    logAdd(ctx, 'bet', `${p.name} 跟注 ${paid}${blind ? '（闷）' : ''}，池底 ${s.pot}`);
  }
  advanceTurn(ctx, p.id);
}

function actFold(ctx, p) {
  const s = ctx.s;
  requireTurn(s, p);
  p.folded = true;
  p.acts += 1;
  logAdd(ctx, 'fold', `${p.name} 弃牌`);
  advanceTurn(ctx, p.id);
}

function actCompare(ctx, p, action) {
  const s = ctx.s;
  requireTurn(s, p);
  if (!compareUnlocked(s)) throw new Error('第一圈还没说完话，不许比牌');
  const t = action.target ? findPlayer(s, action.target) : null;
  if (!t) throw new Error('要跟谁比？没找着这个人');
  if (t.id === p.id) throw new Error('不能跟自己比牌');
  if (t.folded) throw new Error(`${t.name} 已经弃牌了，比不了`);

  const cost = compareCost(s);
  const paid = payChips(s, p, cost);   // 闷牌者比牌也按明牌价付；不够就全押
  p.acts += 1;
  p.owesResponse = false;
  const evA = evalHand(p.cards);
  const evB = evalHand(t.cards);
  const r = compareHands(evA, evB, s.rules);
  // 平局算发起方输
  const loser = r > 0 ? t : p;
  const winner = r > 0 ? p : t;
  loser.folded = true;
  syncScores(s);
  logAdd(ctx, 'compare', `${p.name} 掏 ${paid} 跟 ${t.name} 比牌${p.allin && paid < cost ? '（全押）' : ''}`);
  logAdd(ctx, 'compare_result', r === 0
    ? `平手，按规矩发起方 ${p.name} 认输弃牌，${winner.name} 留下`
    : `${winner.name} 赢，${loser.name} 弃牌`);
  advanceTurn(ctx, p.id);
}

function actNextRound(ctx) {
  const s = ctx.s;
  if (s.phase !== 'round_over') throw new Error('这一局还没打完');
  s.round += 1;
  startRound(ctx);
}

function actEndMatch(ctx) {
  const s = ctx.s;
  if (s.phase === 'betting' && s.pot > 0) {
    // 半局收盘：池子原路退回，记账不变式不能破
    for (const p of s.players) {
      if (p.bet > 0) { p.chips += p.bet; s.pot -= p.bet; p.bet = 0; }
    }
    logAdd(ctx, 'refund', '半局收盘，池底原路退回各家');
  }
  endMatch(ctx);
}

// ---------------------------------------------------------------- 对外 API

function createGame(opts) {
  const o = opts || {};
  const players = o.players;
  if (!Array.isArray(players) || players.length < meta.minPlayers || players.length > meta.maxPlayers) {
    throw new Error(`玩家人数必须是 ${meta.minPlayers}~${meta.maxPlayers} 人`);
  }
  // config 两种写法都吃：{blind_play:...}（cards/server.cjs 的 resolveRules 直接给平的）
  // 和 {defaults:{...}}（daifugo 那套写法）。o.rules 优先级最高。
  const cfg = o.config || {};
  const merged = Object.assign({}, DEFAULT_RULES, cfg.defaults || {}, cfg, o.rules || {});
  // 只留认识的开关，别让脏字段混进 state.rules
  const rules = {
    blind_play: !!merged.blind_play,
    special_235: !!merged.special_235,
    base_bet: Math.max(1, Math.floor(Number(merged.base_bet) || DEFAULT_RULES.base_bet)),
    start_chips: Math.max(1, Math.floor(Number(merged.start_chips) || DEFAULT_RULES.start_chips)),
    max_bet: Math.max(0, Math.floor(Number(merged.max_bet) || 0))
  };
  if (rules.start_chips < rules.base_bet) throw new Error('初始筹码不能少于底注');

  const ids = Object.create(null);
  const ps = players.map((p, i) => {
    const id = p.id || `p${i + 1}`;
    if (ids[id]) throw new Error(`玩家 id 重复：${id}`);
    ids[id] = true;
    return {
      id,
      name: p.name || `玩家${i + 1}`,
      isAI: !!p.isAI,
      chips: rules.start_chips,
      score: rules.start_chips,
      cards: [],
      looked: false,
      folded: false,
      allin: false,
      out: false,
      bet: 0,
      acts: 0
    };
  });

  const s = {
    seq: 0,
    createdAt: Date.now(),
    phase: 'betting',
    round: 1,
    turnOrder: ps.map((p) => p.id),
    current: null,
    dealer: null,
    firstActor: null,
    players: ps,
    pot: 0,
    currentBet: rules.base_bet,
    pile: [],
    showdown: null,
    lastResults: null,
    rounds: [],
    totalChips: rules.start_chips * ps.length,
    winner: null,
    rules,
    log: [],
    rngState: createRngState(o.seed),
    secureRandom: !!o.secureRandom
  };

  const ctx = { s, events: [] };
  logAdd(ctx, 'start', `开局：${ps.map((p) => p.name).join('、')}（${ps.length} 人），每人 ${rules.start_chips} 筹码`);
  startRound(ctx);
  return s;
}

const HANDLERS = {
  look: (ctx, p) => actLook(ctx, p),
  bet: (ctx, p, a) => actBet(ctx, p, a),
  fold: (ctx, p) => actFold(ctx, p),
  compare: (ctx, p, a) => actCompare(ctx, p, a),
  next_round: (ctx) => actNextRound(ctx),
  end_match: (ctx) => actEndMatch(ctx)
};

function apply(state, playerId, action) {
  if (!state) throw new Error('缺少牌局状态');
  const act = (typeof action === 'string') ? { type: action } : (action || {});
  const type = act.type;
  if (!type || !Object.hasOwn(HANDLERS, type)) throw new Error(`未知动作：${type || '(空)'}`);
  if (state.phase === 'game_over') throw new Error('整场已经结束了');
  if (!findPlayer(state, playerId)) throw new Error('查无此人');

  const s = cloneState(state);
  s.seq += 1;
  const ctx = { s, events: [] };
  HANDLERS[type](ctx, findPlayer(s, playerId), act);
  syncScores(s);
  return { state: s, events: ctx.events };
}

/**
 * 该玩家此刻的合法动作，顺序：看牌 -> 跟注/全押 -> 加注档位 -> 弃牌 -> 比牌。
 * round_over 一律 [{type:'next_round'}]（end_match 是房主特权，服务端把关，不进这张表）。
 */
function legalMoves(state, playerId) {
  const s = state;
  const out = [];
  if (!s || s.phase === 'game_over') return out;
  const p = findPlayer(s, playerId);
  if (!p) return out;
  if (s.phase === 'round_over') return [{ type: 'next_round' }];
  if (s.phase !== 'betting' || s.current !== p.id || p.folded || p.allin) return out;

  if (s.rules.blind_play && !p.looked) out.push({ type: 'look' });

  const call = callCost(s, p);
  const blind = !p.looked;
  if (p.chips <= call) {
    out.push({ type: 'bet', amount: p.chips, kind: 'allin', blind, stake: s.currentBet });
  } else {
    out.push({ type: 'bet', amount: call, kind: 'call', blind, stake: s.currentBet });
    const cap = maxStake(s);
    const stakes = [];
    for (const st of [s.currentBet * 2, s.currentBet * 3, cap]) {
      const v = Math.min(st, cap);
      if (v > s.currentBet && stakes.indexOf(v) < 0) stakes.push(v);
    }
    for (const st of stakes) {
      const pay = blind ? Math.ceil(st / 2) : st;
      // 闷牌半价取整后可能抬不到 st，按真正抬得起的算
      const real = blind ? pay * 2 : pay;
      if (real <= s.currentBet || real > cap) continue;
      if (pay > p.chips) continue;
      out.push({
        type: 'bet', amount: pay, kind: pay === p.chips ? 'raise_allin' : 'raise',
        blind, stake: real
      });
    }
    // A valid all-in need not coincide with one of the preset raise amounts.
    const allinStake = blind ? p.chips * 2 : p.chips;
    if (allinStake > s.currentBet && allinStake <= cap && !out.some(m => m.type === 'bet' && m.amount === p.chips)) {
      out.push({type:'bet', amount:p.chips, kind:'raise_allin', blind, stake:allinStake});
    }
  }

  out.push({ type: 'fold' });

  if (compareUnlocked(s)) {
    for (const t of alivePlayers(s)) {
      if (t.id === p.id) continue;
      out.push({
        type: 'compare', target: t.id, targetName: t.name,
        cost: Math.min(compareCost(s), p.chips)
      });
    }
  }
  return out;
}

/**
 * 脱敏视图。playerId=null / 不认识的 id = 观战。
 * 自己的牌**看过才可见**（没看 = cards:null）；他人的牌只在 round_over/game_over 摊给没弃牌的人。
 * rngState / pile 不外泄。
 */
function viewFor(state, playerId) {
  const s = state;
  const me = playerId ? findPlayer(s, playerId) : null;
  const meId = me ? me.id : null;
  const shown = (s.phase === 'round_over' || s.phase === 'game_over');
  return {
    seq: s.seq,
    createdAt: s.createdAt,
    phase: s.phase,
    round: s.round,
    turnOrder: s.turnOrder.slice(),
    current: s.current,
    dealer: s.dealer,
    you: meId,
    pot: s.pot,
    currentBet: s.currentBet,
    callCost: (me && s.phase === 'betting') ? callCost(s, me) : null,
    players: s.players.map((p) => {
      const mine = !!meId && p.id === meId;
      const open = p.cards.length === 3 && ((mine && p.looked) || (shown && !p.folded));
      return {
        id: p.id,
        name: p.name,
        isAI: p.isAI,
        chips: p.chips,
        score: p.score,
        bet: p.bet,
        looked: p.looked,
        folded: p.folded,
        allin: p.allin,
        out: p.out,
        acts: p.acts,
        handCount: p.cards.length,
        cards: open ? p.cards.slice() : null,
        hand: open ? handLabel(evalHand(p.cards), s.rules) : null
      };
    }),
    showdown: s.showdown ? {
      reason: s.showdown.reason,
      reveal: s.showdown.reveal.map((r) => Object.assign({}, r, { cards: r.cards.slice() }))
    } : null,
    lastResults: s.lastResults ? cloneResults(s.lastResults) : null,
    rounds: s.rounds.map(cloneResults),
    winner: s.winner,
    rules: Object.assign({}, s.rules),
    log: s.log.slice()
  };
}

/** 现在欠动作的人：下注中 = 当前行动者；round_over/收盘 = 空
 * （开下一局由人点——返回人的话自动 AI会烧 CLI 抢 next_round,大富豪同口径） */
function currentActors(state) {
  const s = state;
  if (!s || s.phase === 'game_over') return [];
  if (s.phase === 'round_over') return [];
  if (s.phase === 'betting' && s.current) {
    const p = findPlayer(s, s.current);
    if (p && !p.folded && !p.allin) return [p.id];
  }
  return [];
}

/** 中文局面简报（不含合法招列表） */
function briefing(state, playerId) {
  const s = state;
  const p = findPlayer(s, playerId);
  const lines = [];
  const dealer = s.dealer ? findPlayer(s, s.dealer) : null;
  lines.push(`【炸金花】第 ${s.round} 局 · 庄家 ${dealer ? dealer.name : '—'} · 底注 ${s.rules.base_bet}`);

  if (s.phase === 'game_over') {
    const board = s.players.slice().sort((a, b) => b.chips - a.chips);
    lines.push('整场已收盘：' + board.map((x) => `${x.name} ${x.chips}`).join('，'));
    return lines.join('\n');
  }

  if (p) {
    if (p.out) lines.push('你这局筹码不够底注，轮空。');
    else if (p.cards.length !== 3) lines.push('你还没拿到牌。');
    else if (p.looked || s.phase === 'round_over') {
      lines.push(`你的牌：${cardsLabel(p.cards)}（${handLabel(evalHand(p.cards), s.rules)}）`);
    } else {
      lines.push('你的牌：3 张暗牌（还闷着，没看）');
    }
    lines.push(`你的筹码 ${p.chips} · 本局已投 ${p.bet}${p.folded && !p.out ? ' · 已弃牌' : ''}${p.allin ? ' · 已全押' : ''}`);
  }
  lines.push(`池底 ${s.pot} · 当前注 ${s.currentBet}${p && !p.folded && s.phase === 'betting' ? ` · 你跟注要 ${callCost(s, p)}` : ''}`);

  const tags = s.players.map((q) => {
    const st = q.out ? '轮空' : q.folded ? '已弃' : q.allin ? '全押' : (q.looked ? '明牌' : '闷着');
    return `${q.name}(${st} 筹码${q.chips} 已投${q.bet})`;
  });
  lines.push('场上：' + tags.join(' / '));

  if (s.phase === 'round_over') {
    const rs = s.lastResults;
    if (rs) {
      lines.push('本局已结束：' + rs.reveal.map((r) => `${r.name} ${cardsLabel(r.cards)}（${r.label}）`).join('；'));
      lines.push('赢家：' + rs.winners.map((w) => `${w.name} +${w.gain}`).join('、') + '。等人开下一局。');
    }
  } else {
    const cur = s.current ? findPlayer(s, s.current) : null;
    lines.push(cur ? `轮到 ${cur.id === playerId ? '你' : cur.name} 说话` : '等结算');
  }
  return lines.join('\n');
}

/** 一招的人话 */
function fmtMove(move) {
  const m = (typeof move === 'string') ? { type: move } : (move || {});
  const blind = m.blind ? '(闷)' : '';
  switch (m.type) {
    case 'look': return '看牌';
    case 'bet':
      if (m.kind === 'allin' || m.kind === 'raise_allin') return `全押 ${m.amount}${blind}`;
      if (m.kind === 'raise') return `加注 ${m.amount}${blind} → 当前注 ${m.stake}`;
      return `跟注 ${m.amount}${blind}`;
    case 'fold': return '弃牌';
    case 'compare': return `比牌 → ${m.targetName || m.target}`;
    case 'next_round': return '开下一局';
    case 'end_match': return '收盘';
    default: return String(m.type || '(空)');
  }
}

// ---------------------------------------------------------------- 双环境导出

const API = {
  // 主接口（SPEC 第 1 章八件套）
  meta,
  createGame,
  apply,
  legalMoves,
  viewFor,
  currentActors,
  briefing,
  fmtMove,
  // 牌力判定（前端预判复用）
  evalHand,
  compareHands,
  handLabel,
  parseCard,
  cardLabel,
  cardsLabel,
  cardStrength,
  strengthOf,
  sortHand,
  // 杂项（服务端/测试用）
  createRngState,
  rngNext,
  shuffle,
  cloneState,
  callCost,
  maxStake,
  ALL_CARDS,
  DEFAULT_RULES,
  CAT,
  CAT_LABEL
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.ZjhEngine = API;
