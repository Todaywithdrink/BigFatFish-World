// 居民自主：内驱力 → 动态目标 → 情境候选 → 效用选择
//
// 这一层只回答"这个人此刻想做什么"，不直接改世界。所有动作仍然走
// world.applyAction，和外部 AI 完全同一套原子能力：没有全图、没有所有权判定、
// 没有"脚本特权"。区别只在于——外部 AI 的"想"在模型里，这里的"想"在这份代码里。
//
// 设计上刻意避免的东西：
//   1. 不写"如果 A 则 B"的长链。每个目标自己算一个 0~1 的紧迫度，
//      行动是所有目标提出的候选里效用最高的那个，所以目标之间会互相竞争。
//   2. 不使用 world.rng。自主层有自己的随机流（由 uid 派生），
//      免得"每秒想一次"把内核的随机序列搅乱，回放对不上。
//   3. 不读没见过的格子。地方要么亲眼见过（v.explored），要么不知道。
//
// 性格不是常量：traits 会随着经历漂移（饿过肚子更谨慎、盖过房更乐观），
// 漂移结果同步回 v.personality，桥接层和交易估值看到的都是"现在的他"。

import { hashSeed } from "../src/rng.mjs";
import { isMinor } from "../src/lifecycle.mjs";
import { ITEMS } from "../src/economy.mjs";

const TRAIT_KEYS = [
  "optimism", "sociability", "order", "curiosity",
  "industry", "caution", "generosity", "ambition"
];

const PLACE_KINDS = ["water", "tree", "flower", "stove", "bed", "board", "bench"];
const PLACE_LIMIT = 14;
const MAX_GOALS = 4;
const GOAL_REPLACE_MARGIN = 0.12;   // 新目标要比最弱的旧目标高出这么多才挤进来（防抖）

const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const r1 = (x) => Math.round((Number(x) || 0) * 10) / 10;
const distTo = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

function hashUnit(seedText) {
  return (hashSeed(seedText) % 10000) / 10000;
}

// ---------- 黑匣子：一个居民自己的那本账 ----------

export function newBlackboard(v) {
  const uid = String(v.uid || v.id || "v");
  const p = v.personality || {};
  // 初始性格 = 演员表给的三项 + 从 uid 派生的其余五项。
  // 不预设"好人/坏人"，只给一个起点；后面怎么长，看经历。
  const seeded = (salt, lo = 2.6, span = 4.8) => r1(lo + hashUnit(uid + "#" + salt) * span);
  return {
    v: 1,
    traits: {
      optimism: r1(clamp(Number.isFinite(Number(p.optimism)) ? Number(p.optimism) : seeded("op"), 0, 10)),
      sociability: r1(clamp(Number.isFinite(Number(p.social)) ? Number(p.social) : seeded("so"), 0, 10)),
      order: r1(clamp(Number.isFinite(Number(p.manners)) ? Number(p.manners) : seeded("or"), 0, 10)),
      curiosity: seeded("cu"),
      industry: seeded("in"),
      caution: seeded("ca"),
      generosity: seeded("ge"),
      ambition: seeded("am")
    },
    mood: "平静",
    goals: [],                 // 活跃目标（最多 MAX_GOALS 个）
    mem: {
      places: {},              // kind -> [{x,y,at}]，只记亲眼见过的
      cool: {},                // 目标 -> 冷静到期 tick（连续受挫后别死磕）
      outcomes: {},            // 活动 -> {tries, hits}，用来估成功率
      people: {},              // id -> {talks,lastTalk,attacks,gave,got}
      seenSettlements: [],     // 听说/见过的聚落 [{name,x,y}]
      stats: {
        meals: 0, catches: 0, chops: 0, houses: 0, talks: 0,
        coinsBest: 0, lastExplore: 0, exploredSeen: 0, myHouse: null, lastForum: -99999
      },
      notes: []                // 最近几条"吃过亏"的经验，短句，给调试看
    },
    thought: "",
    seq: 0
  };
}

/** 存档里读回来：缺字段就补默认值，坏数据不能把居民变成 NaN */
export function restoreBlackboard(raw) {
  if (!raw || typeof raw !== "object") return null;
  const bb = {
    v: 1,
    traits: {}, mood: String(raw.mood || "平静").slice(0, 8),
    goals: Array.isArray(raw.goals) ? raw.goals.slice(0, MAX_GOALS) : [],
    mem: {
      places: {}, cool: {}, outcomes: {}, people: {}, seenSettlements: [],
      stats: { meals: 0, catches: 0, chops: 0, houses: 0, talks: 0, coinsBest: 0, lastExplore: 0, exploredSeen: 0, myHouse: null, lastForum: -99999 },
      notes: []
    },
    thought: String(raw.thought || "").slice(0, 60),
    seq: Number(raw.seq) || 0
  };
  for (const k of TRAIT_KEYS) bb.traits[k] = r1(clamp(raw.traits && raw.traits[k], 0, 10));
  const mem = raw.mem || {};
  for (const kind of PLACE_KINDS) {
    const list = mem.places && Array.isArray(mem.places[kind]) ? mem.places[kind] : [];
    bb.mem.places[kind] = list
      .filter((p) => Number.isFinite(Number(p && p.x)) && Number.isFinite(Number(p && p.y)))
      .slice(0, PLACE_LIMIT)
      .map((p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), at: Number(p.at) || 0 }));
  }
  if (mem.cool && typeof mem.cool === "object") {
    for (const [k, until] of Object.entries(mem.cool)) {
      if (Number.isFinite(Number(until))) bb.mem.cool[k] = Math.floor(Number(until));
    }
  }
  if (mem.outcomes && typeof mem.outcomes === "object") {
    for (const [k, o] of Object.entries(mem.outcomes)) {
      bb.mem.outcomes[k] = { tries: Math.max(0, Math.floor(Number(o && o.tries) || 0)), hits: Math.max(0, Math.floor(Number(o && o.hits) || 0)) };
    }
  }
  if (mem.people && typeof mem.people === "object") {
    for (const [id, p] of Object.entries(mem.people)) {
      bb.mem.people[id] = {
        talks: Math.max(0, Math.floor(Number(p && p.talks) || 0)),
        lastTalk: Number(p && p.lastTalk) || 0,
        attacks: Math.max(0, Math.floor(Number(p && p.attacks) || 0)),
        gave: Math.max(0, Math.floor(Number(p && p.gave) || 0)),
        got: Math.max(0, Math.floor(Number(p && p.got) || 0))
      };
    }
  }
  if (Array.isArray(mem.seenSettlements)) {
    bb.mem.seenSettlements = mem.seenSettlements
      .filter((s) => s && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.y)))
      .slice(0, 8)
      .map((s) => ({ name: String(s.name || "无名聚落").slice(0, 12), x: Math.floor(s.x), y: Math.floor(s.y) }));
  }
  Object.assign(bb.mem.stats, (mem.stats && typeof mem.stats === "object") ? mem.stats : {});
  if (Array.isArray(mem.notes)) bb.mem.notes = mem.notes.filter((n) => typeof n === "string").slice(-6);
  return bb;
}

// ---------- 感知：只把"看见过"的东西记成地点 ----------

/**
 * 每想一次，扫一遍身边 8 格。只有落在 v.explored 里的格子才算"见过"——
 * explored 是内核按视锥维护的，所以这一层没有任何透视能力。
 */
export function perceive(world, v, bb) {
  const cx = Math.floor(v.x), cy = Math.floor(v.y), R = 8;
  const places = bb.mem.places;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx, y = cy + dy;
      if (!v.explored || !v.explored.has(x + "," + y)) continue;
      const t = world.map.tile(x, y);
      if (!t || !PLACE_KINDS.includes(t.kind)) continue;
      const list = places[t.kind] || (places[t.kind] = []);
      if (list.some((p) => p.x === x && p.y === y)) continue;
      list.push({ x, y, at: world.tickCount });
      if (list.length > PLACE_LIMIT) {
        list.sort((a, b) => distTo(a.x, a.y, cx, cy) - distTo(b.x, b.y, cx, cy));
        list.length = PLACE_LIMIT;
      }
    }
  }
  // 走近了才发现"记错"：树被砍了、灶台被拆了，就把这条记忆删掉
  for (const kind of PLACE_KINDS) {
    const list = places[kind];
    if (!list || !list.length) continue;
    places[kind] = list.filter((p) => {
      if (distTo(p.x, p.y, v.x, v.y) > 12) return true;   // 太远，验证不了，先信记忆
      const t = world.map.tile(p.x, p.y);
      return !!t && t.kind === kind;
    });
  }
}

/** 离我最近的一个"我确实知道"的地点 */
export function nearestKnown(world, bb, kind, v, { maxAge = Infinity, maxDist = Infinity } = {}) {
  const list = bb.mem.places[kind];
  if (!list || !list.length) return null;
  let best = null, bd = Infinity;
  for (const p of list) {
    if (world.tickCount - (p.at || 0) > maxAge) continue;
    const d = distTo(p.x + 0.5, p.y + 0.5, v.x, v.y);
    if (d > maxDist || d >= bd) continue;
    const t = world.map.tile(p.x, p.y);
    if (!t || t.kind !== kind) continue;
    bd = d; best = p;
  }
  return best;
}

export function foodStock(v) {
  return (v.inventory.fish || 0) + (v.inventory.bread || 0) + (v.inventory.stew || 0);
}

// ---------- 情境：把世界翻译成"我现在的处境" ----------

export function buildContext(world, v, bb, rng) {
  const places = bb.mem.places;
  const minor = isMinor(v);
  const night = world.hour >= 21 || world.hour < 6;
  const visible = [];
  for (const o of world.entities.values()) {
    if (o === v || o.state === "dead" || o.state === "downed") continue;
    if (!world.canSee(v, o)) continue;
    const d = distTo(o.x, o.y, v.x, v.y);
    if (d > 9) continue;
    visible.push({ id: o.id, name: o.name, x: o.x, y: o.y, d, role: o.role, minor: isMinor(o) });
  }
  visible.sort((a, b) => a.d - b.d);

  const comms = world.commitmentsFor ? world.commitmentsFor(v) : [];
  const mineDebts = comms.filter((c) => c.role === "i_owe" && c.kind === "debt");
  const owed = comms.filter((c) => c.role === "owed_to_me");

  // "上次和人说话"从两处取：自己的记忆 + 内核的对话状态
  const memTalks = Object.values(bb.mem.people).map((p) => p.lastTalk || 0);
  const bornTick = Number(bb.mem.stats.bornTick) || 0;
  const lastTalk = Math.max(v.lastSpokeTick || -9999, ...(memTalks.length ? memTalks : [-9999]), bornTick);
  const ticksSinceTalk = Math.max(0, world.tickCount - lastTalk);

  const myHouse = bb.mem.stats.myHouse;

  return {
    tick: world.tickCount,
    minor,
    night,
    hour: world.hour,
    hp: v.hp, energy: v.needs.energy, hunger: v.needs.hunger,
    coins: v.coins || 0,
    food: foodStock(v),
    wood: v.inventory.wood || 0,
    plank: v.inventory.plank || 0,
    stone: 0,
    hasHouse: !!myHouse,
    hasBed: !!(places.bed && places.bed.length),
    stove: !!(places.stove && places.stove.length) ? nearestKnown(world, bb, "stove", v) : null,
    water: !!(places.water && places.water.length) ? nearestKnown(world, bb, "water", v) : null,
    tree: !!(places.tree && places.tree.length) ? nearestKnown(world, bb, "tree", v) : null,
    flower: !!(places.flower && places.flower.length) ? nearestKnown(world, bb, "flower", v) : null,
    board: !!(places.board && places.board.length) ? nearestKnown(world, bb, "board", v) : null,
    visible,
    alone: visible.length === 0,
    ticksSinceTalk,
    socialRecent: ticksSinceTalk < 1800,
    debts: mineDebts,
    credits: owed,
    ageDays: Number.isFinite(v.ageDays) ? v.ageDays : 20,
    rngValue: rng.next()
  };
}

// ---------- 内驱力：不是需求条，是"由处境和性格共同挤出来的压力" ----------

export function drivesOf(world, v, bb, ctx) {
  const t = bb.traits;
  const survival = clamp01(
    Math.max((60 - ctx.hunger) / 60, ctx.food === 0 ? 0.45 : 0) * 0.75 +
    Math.max(0, (35 - ctx.energy) / 35) * 0.25
  );
  const safety = clamp01((70 - ctx.hp) / 70 * 0.8 + (ctx.night && !ctx.hasBed ? 0.2 : 0));
  const belonging = clamp01((ctx.ticksSinceTalk - 900) / 4200) * (0.55 + t.sociability / 22);
  const targetCoins = 25 + t.ambition * 6;
  const wealth = clamp01((targetCoins - ctx.coins) / targetCoins) * (0.55 + t.ambition / 24) * (ctx.food === 0 ? 1.15 : 1);
  const levels = Object.values(v.skills || {}).map((s) => s.level || 0);
  const avgLevel = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0;
  const mastery = clamp01(1 - avgLevel / 5) * (0.35 + t.industry / 18);
  const sinceExplore = world.tickCount - (bb.mem.stats.lastExplore || 0);
  const curiosity = clamp01((sinceExplore - 900) / 5400) * (0.45 + t.curiosity / 18);
  const duty = clamp01(ctx.debts.length / 2) * (0.6 + t.order / 25);
  const order = ctx.hasHouse ? clamp01(0.35 - (bb.mem.stats.houses || 0) * 0.05) : (ctx.minor ? 0 : 0.65);
  const ambition = ctx.hasHouse ? 0 : clamp01(0.35 + t.ambition / 20);
  return { survival, safety, belonging, wealth, mastery, curiosity, duty, order, ambition };
}

// ---------- 性格漂移：经历会改人 ----------

const FEELINGS = {
  ate: [["optimism", 0.04]],
  caught: [["industry", 0.04], ["optimism", 0.05]],
  fish_miss: [["optimism", -0.02]],
  chopped: [["industry", 0.03]],
  built: [["order", 0.06], ["optimism", 0.08]],
  house: [["optimism", 0.18], ["order", 0.15], ["ambition", 0.1]],
  attacked: [["caution", 0.35], ["optimism", -0.25], ["sociability", -0.1]],
  gave: [["generosity", 0.08], ["optimism", 0.04]],
  traded: [["optimism", 0.06]],
  debt_paid: [["order", 0.08], ["optimism", 0.08]],
  starved: [["caution", 0.22], ["industry", 0.1], ["optimism", -0.12]],
  talked: [["sociability", 0.04]],
  friend: [["sociability", 0.08], ["optimism", 0.08]],
  ignored: [["sociability", -0.03]],
  stuck: [["caution", 0.02]]
};

/** 让一段经历改一点性格。amount 是强度倍数（默认为 1）。 */
export function feel(v, bb, event, amount = 1) {
  const table = FEELINGS[event];
  if (!table) return;
  for (const [key, delta] of table) {
    if (!(key in bb.traits)) continue;
    bb.traits[key] = r1(clamp(bb.traits[key] + delta * amount, 0, 10));
  }
  // 同步回内核字段：交易估值、桥接提示词读的都是 v.personality
  if (v && v.personality) {
    v.personality.optimism = Math.round(bb.traits.optimism);
    v.personality.social = Math.round(bb.traits.sociability);
    v.personality.manners = Math.round(bb.traits.order);
  }
}

export function rememberOutcome(bb, activity, hit) {
  const o = bb.mem.outcomes[activity] || (bb.mem.outcomes[activity] = { tries: 0, hits: 0 });
  o.tries++;
  if (hit) o.hits++;
}

/** 用 Laplace 平滑估成功率：没试过的时候不装懂（默认 0.45） */
export function successRate(bb, activity) {
  const o = bb.mem.outcomes[activity];
  if (!o || !o.tries) return 0.45;
  return (o.hits + 1) / (o.tries + 2);
}

function note(bb, text) {
  bb.mem.notes.push(String(text).slice(0, 40));
  if (bb.mem.notes.length > 6) bb.mem.notes.shift();
}

// ---------- 目标：从处境里长出来，而不是排好的剧本 ----------

function evaluateRest(c) {
  const { ctx, v } = c;
  if (v.state === "resting") return 0;
  let p = clamp01((45 - ctx.energy) / 45) * 0.95;
  if (ctx.night) p = Math.max(p, ctx.energy < 90 ? 0.4 + (90 - ctx.energy) / 220 : 0.16);
  if (ctx.energy < 16) p = 1.3;
  return p;
}

function evaluateEat(c) {
  const { ctx } = c;
  if (ctx.food === 0) return 0;                 // 没吃的：交给"弄吃的"
  if (ctx.hunger > 58) return 0;
  return 0.5 + ((58 - ctx.hunger) / 58) * 0.5;
}

function evaluateGetFood(c) {
  const { ctx } = c;
  if (ctx.food > 0) return 0;
  if (ctx.hunger > 82) return 0;
  return 0.55 + ((82 - ctx.hunger) / 82) * 0.3;
}

function evaluateHearth(c) {
  const { ctx } = c;
  if (ctx.minor || ctx.stove) return 0;
  // 没有灶台就吃不上热饭：哪怕兜里揣着鱼也得先垒一个
  if (ctx.food > 0 && ctx.hunger > 78) return 0.32;
  return 0.55 + (ctx.hunger < 60 ? 0.08 : 0);
}

function evaluateDebt(c) {
  const { ctx } = c;
  if (ctx.minor) return 0;
  let p = 0;
  for (const d of ctx.debts) {
    const need = Math.min(d.coins, 8);
    if (ctx.coins >= need) p = Math.max(p, 0.55 + Math.min(0.2, d.coins / 100));
  }
  if (ctx.credits.length) p = Math.max(p, 0.3);
  return p;
}

function evaluateShelter(c) {
  const { ctx, bb } = c;
  if (ctx.minor || ctx.hasHouse) return 0;
  const t = bb.traits;
  let p = 0.16 + t.ambition / 35 + t.order / 45;
  if (ctx.ageDays < 26) p *= 0.6;
  if (ctx.wood < 4 && ctx.plank < 3) p *= 0.85;
  return clamp01(p);
}

function evaluateWork(c) {
  const { ctx, bb } = c;
  if (ctx.minor) return 0;
  const target = 22 + bb.traits.ambition * 6;
  if (ctx.coins >= target) return 0;
  const gap = clamp01((target - ctx.coins) / target);
  return 0.22 + gap * 0.28 * (0.6 + bb.traits.industry / 20);
}

function evaluateSocial(c) {
  const { ctx, bb } = c;
  if (ctx.minor) return 0;
  if (ctx.ticksSinceTalk < 1200) return 0.04;
  // 上限 0.6：想找人说话，但不该盖过吃饭和活下去
  return Math.min(0.6, clamp01((ctx.ticksSinceTalk - 1200) / 4800) * (0.4 + bb.traits.sociability / 16));
}

function evaluateExplore(c) {
  const { ctx, bb, world } = c;
  const since = world.tickCount - (bb.mem.stats.lastExplore || 0);
  // 上限压低：好奇是背景音乐，不该盖过"饿了要吃饭"
  return clamp01((since - 900) / 5400) * (ctx.minor ? 0.3 : 0.28 + bb.traits.curiosity / 26);
}

function evaluatePractice(c) {
  const { ctx, bb, v } = c;
  if (ctx.minor) return 0;
  const levels = Object.values(v.skills || {}).map((s) => s.level || 0);
  const avg = levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : 0;
  return clamp01(1 - avg / 5) * (0.16 + bb.traits.industry / 70);
}

function evaluateBeautify(c) {
  const { ctx, bb } = c;
  if (ctx.minor || !ctx.hasHouse) return 0;
  if (ctx.plank < 1 && ctx.wood < 2) return 0;
  return clamp01(bb.traits.order / 55 + 0.06);
}

function evaluateCivic(c) {
  const { ctx, bb, world } = c;
  if (ctx.minor) return 0;
  if (world.tickCount - (bb.mem.stats.lastForum || 0) < 12000) return 0;
  return 0.09 + bb.traits.order / 160;
}

function evaluateVisitSettlement(c) {
  const { ctx, bb } = c;
  if (ctx.minor) return 0;
  if (!bb.mem.seenSettlements.length) return 0;
  return 0.12 + bb.traits.curiosity / 40;
}

/**
 * 照看孩子：自己的孩子饿了、自己手里有吃的，就先送过去。
 * 引擎不管"抚养义务"，这只是一个人看见自家娃饿肚子时的自然反应。
 */
function kidsNeedingCare(world, v, bb, radius = 8) {
  const own = ((v.family && v.family.children) || [])
    .map((id) => world.entities.get(id))
    .filter((k) => k && k.state !== "dead" && isMinor(k) && k.needs.hunger < 55);
  if (own.length) return own;
  // 没爹没妈的孩子，心软的人看见了也会管
  if (bb.traits.generosity <= 6) return [];
  const out = [];
  for (const k of world.entities.values()) {
    if (k === v || k.state === "dead" || k.state === "downed" || !isMinor(k)) continue;
    if (k.needs.hunger >= 40) continue;
    if (distTo(k.x, k.y, v.x, v.y) > radius) continue;
    out.push(k);
  }
  return out;
}

function evaluateCare(c) {
  const { ctx, v, world, bb } = c;
  if (ctx.minor) return 0;
  const kids = kidsNeedingCare(world, v, bb);
  if (!kids.length) return 0;
  if (ctx.food === 0) return 0;      // 自己都没吃的，先顾自己
  const worst = Math.min(...kids.map((k) => k.needs.hunger));
  return 0.6 + ((50 - worst) / 50) * 0.35;
}

const RULES = [
  { kind: "rest", label: "歇一歇", ttl: 900, eval: evaluateRest },
  { kind: "eat", label: "吃口东西", ttl: 600, eval: evaluateEat },
  { kind: "get_food", label: "弄点吃的", ttl: 1800, eval: evaluateGetFood },
  { kind: "hearth", label: "垒个灶", ttl: 2400, eval: evaluateHearth },
  { kind: "debt", label: "了结旧账", ttl: 1200, eval: evaluateDebt },
  { kind: "shelter", label: "盖自己的房子", ttl: 4800, eval: evaluateShelter },
  { kind: "work", label: "挣点钱", ttl: 2400, eval: evaluateWork },
  { kind: "social", label: "找人说话", ttl: 900, eval: evaluateSocial },
  { kind: "explore", label: "去没去过的地方", ttl: 1800, eval: evaluateExplore },
  { kind: "practice", label: "练手艺", ttl: 1500, eval: evaluatePractice },
  { kind: "beautify", label: "把家门口收拾一下", ttl: 1800, eval: evaluateBeautify },
  { kind: "civic", label: "看看告示", ttl: 900, eval: evaluateCivic },
  { kind: "visit", label: "去看看别的聚落", ttl: 3600, eval: evaluateVisitSettlement },
  { kind: "care", label: "照看孩子", ttl: 600, eval: evaluateCare }
];

// 未成年人的目标表：不是"简化版大人"，是另一套日子
const CHILD_RULES = [
  { kind: "rest", label: "困了", ttl: 900, eval: evaluateRest },
  { kind: "eat", label: "吃饭", ttl: 600, eval: evaluateEat },
  { kind: "follow", label: "跟着家里人", ttl: 600, eval: (c) => (c.ctx.visible.some((o) => !o.minor && o.d < 7) ? 0.55 : 0.1) },
  { kind: "play", label: "在附近玩", ttl: 1200, eval: (c) => 0.3 + c.bb.traits.curiosity / 40 },
  { kind: "listen", label: "听大人说话", ttl: 600, eval: (c) => (c.ctx.visible.some((o) => !o.minor) ? 0.32 : 0) }
];

/**
 * 刷新目标集：每个目标算紧迫度，跟现有目标做带滞回的合并。
 * 结果是"最多 4 个同时存在的念头"，而不是一条固定优先级链。
 */
export function refreshGoals(world, v, bb, ctx, drives) {
  const rules = ctx.minor ? CHILD_RULES : RULES;
  const now = world.tickCount;
  const existing = new Map(bb.goals.map((g) => [g.kind, g]));

  const cool = bb.mem.cool || {};
  for (const rule of rules) {
    if (cool[rule.kind] > now) continue;
    let p = 0;
    try { p = rule.eval({ world, v, bb, ctx, drives }); } catch { p = 0; }
    p = clamp(Number(p) || 0, 0, 1.4);
    const g = existing.get(rule.kind);
    if (g) {
      // 平滑：不让紧迫度一秒一跳，否则居民会左右横跳
      g.priority = r2(g.priority * 0.55 + p * 0.45);
      if (p > 0.02) g.expires = Math.max(g.expires, now + rule.ttl);
      continue;
    }
    if (p <= 0.08) continue;
    if (bb.goals.length >= MAX_GOALS) {
      let weakest = null;
      for (const x of bb.goals) if (!weakest || x.priority < weakest.priority) weakest = x;
      if (!weakest || p < weakest.priority + GOAL_REPLACE_MARGIN) continue;
      bb.goals = bb.goals.filter((x) => x !== weakest);
      existing.delete(weakest.kind);
    }
    const goal = {
      id: "g" + (bb.seq = (bb.seq || 0) + 1),
      kind: rule.kind, label: rule.label,
      priority: r2(p), born: now, expires: now + rule.ttl,
      fails: 0, data: {}
    };
    bb.goals.push(goal);
    existing.set(goal.kind, goal);
    bb.lastAdopted = { kind: goal.kind, label: goal.label, tick: now };
  }

  // 过期 / 不再紧迫的念头自然消退
  bb.goals = bb.goals.filter((g) => {
    if (g.priority < 0.03) return false;
    if (g.expires && now > g.expires) return false;
    return true;
  });
  // 保证顺序稳定（同一 tick 两次跑出来的目标顺序一致）
  bb.goals.sort((a, b) => (b.priority - a.priority) || (a.kind < b.kind ? -1 : 1));
}

// ---------- 候选行动：每个目标提出"此刻能做什么" ----------

const go = (x, y, fit, label, near = 1.3) => ({ kind: "goto", x, y, near, fit, label });
const act = (action, fit, label, meta = {}) => ({ kind: "act", action, fit, label, ...meta });

function canCraft(v, recipe) {
  if (recipe === "plank") return (v.inventory.wood || 0) >= 2;
  return false;
}

function findGrassNear(world, v, radius = 2) {
  const cx = Math.floor(v.x), cy = Math.floor(v.y);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = cx + dx, y = cy + dy;
      const t = world.map.tile(x, y);
      if (!t || t.kind !== "grass") continue;
      // 必须真的在手边（actBuild 限 2.2 格），否则会一直"想放却放不下"
      if (distTo(x + 0.5, y + 0.5, v.x, v.y) <= 2.0) return { x, y };
    }
  }
  return null;
}

/** 找一块 5×4 的空地：不用全图，只看自己脚下这一圈 */
function findBuildSpot(world, v, radius = 10) {
  const cx = Math.floor(v.x), cy = Math.floor(v.y);
  let best = null, bd = Infinity;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      let ok = true;
      for (let yy = y; yy < y + 4 && ok; yy++) {
        for (let xx = x; xx < x + 5 && ok; xx++) {
          const t = world.map.tile(xx, yy);
          if (!t || !(t.kind === "grass" || t.kind === "path" || t.kind === "flower")) ok = false;
        }
      }
      if (!ok) continue;
      // 自己站的那格不能在房子里，不然盖完就把自己封进去了
      const vx = Math.floor(v.x), vy = Math.floor(v.y);
      if (vx >= x && vx <= x + 4 && vy >= y && vy <= y + 3) continue;
      const d = distTo(x + 2.5, y + 2, v.x, v.y);
      if (d <= 5.6 && d < bd) { bd = d; best = { x, y }; }   // 必须站得够近（actBuildHouse 限 6 格）
    }
  }
  return best;
}

function exploreIntent(world, v, bb, ctx, fit, label) {
  // 八个方向里挑"附近走过的地方最少"的一边；不检查那边能不能走——
  // 撞墙本来就是他要自己学的事。
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const cx = Math.floor(v.x), cy = Math.floor(v.y);
  let best = null, bestScore = Infinity;
  for (const [dx, dy] of dirs) {
    let known = 0, total = 0;
    for (let r = 2; r <= 9; r += 2) {
      for (let s = -1; s <= 1; s++) {
        const x = Math.round(cx + dx * r + (dy ? s * r * 0.5 : 0));
        const y = Math.round(cy + dy * r + (dx ? s * r * 0.5 : 0));
        if (!world.map.inBounds(x, y)) continue;
        total++;
        if (v.explored && v.explored.has(x + "," + y)) known++;
      }
    }
    const score = total ? known / total : 1;
    if (score < bestScore) { bestScore = score; best = [dx, dy]; }
  }
  const [dx, dy] = best || [1, 0];
  const tx = clamp(cx + dx * 8, 0, world.map.width - 1);
  const ty = clamp(cy + dy * 8, 0, world.map.height - 1);
  return { kind: "goto", x: tx, y: ty, near: 0.8, fit, label, blind: true };
}

function planRest(world, v, bb, ctx) {
  const bed = nearestKnown(world, bb, "bed", v) || (v.lastBed ? { x: v.lastBed.x, y: v.lastBed.y } : null);
  if (bed) {
    const d = distTo(bed.x + 0.5, bed.y + 0.5, v.x, v.y);
    if (d > 1.1) return [go(bed.x, bed.y, 0.9, "回床上睡")];
    return [act({ type: "rest" }, 1, "睡一会")];
  }
  const home = v.home || world.map.spawn;
  const dh = distTo(home.x + 0.5, home.y + 0.5, v.x, v.y);
  if (dh > 1.4) return [go(home.x, home.y, 0.8, "回家歇着")];
  return [act({ type: "rest" }, 1, "就地睡下")];
}

function planEat(world, v, bb, ctx) {
  const stove = ctx.stove;
  if (!stove) return [];                        // 没灶台 → hearth 目标
  const d = distTo(stove.x + 0.5, stove.y + 0.5, v.x, v.y);
  if (d > 1.6) return [go(stove.x, stove.y, 0.9, "去灶台", 1.6)];
  return [act({ type: "eat" }, 1, "吃饭")];
}

function planGetFood(world, v, bb, ctx) {
  // 有鱼有灶：做一顿更好的
  if (ctx.stove && (v.inventory.fish || 0) >= 2) {
    const d = distTo(ctx.stove.x + 0.5, ctx.stove.y + 0.5, v.x, v.y);
    if (d > 1.6) return [go(ctx.stove.x, ctx.stove.y, 0.7, "去灶台做饭", 1.6)];
    return [act({ type: "cook", recipe: "stew" }, 0.8, "炖一锅鱼")];
  }
  const water = ctx.water;
  if (water) {
    const d = distTo(water.x + 0.5, water.y + 0.5, v.x, v.y);
    if (d > 2.0) return [go(water.x, water.y, 0.9, "去水边", 2.0)];
    return [act({ type: "fish" }, successRate(bb, "fish") + 0.25, "钓鱼")];
  }
  // 不知道水在哪：往没去过的地方找
  return [exploreIntent(world, v, bb, ctx, 0.5, "找水")];
}

function planHearth(world, v, bb, ctx) {
  const need = { wood: 4, plank: 1 };
  const hasAll = (v.inventory.wood || 0) >= need.wood && (v.inventory.plank || 0) >= need.plank;
  if (!hasAll) {
    if ((v.inventory.plank || 0) < 1 && canCraft(v, "plank")) return [act({ type: "craft", recipe: "plank" }, 0.7, "劈木板")];
    if (ctx.tree) {
      const d = distTo(ctx.tree.x + 0.5, ctx.tree.y + 0.5, v.x, v.y);
      if (d > 1.8) return [go(ctx.tree.x, ctx.tree.y, 0.8, "去砍树", 1.8)];
      return [act({ type: "chop", x: ctx.tree.x, y: ctx.tree.y }, 0.9, "砍树")];
    }
    return [exploreIntent(world, v, bb, ctx, 0.55, "找木头")];
  }
  const spot = findGrassNear(world, v, 2);
  if (spot) return [{ kind: "build", buildKind: "stove", x: spot.x, y: spot.y, fit: 1, label: "垒灶台" }];
  // 脚下没有草地：往旁边挪一格
  return [exploreIntent(world, v, bb, ctx, 0.4, "找块空地")];
}

function planDebt(world, v, bb, ctx) {
  const mine = ctx.debts.find((d) => ctx.coins >= Math.min(d.coins, 8));
  if (mine) return [act({ type: "settle", commitmentId: mine.id }, 1, "还账")];
  const owed = ctx.credits[0];
  if (owed) {
    const debtor = world.entities.get(owed.otherId);
    if (debtor && debtor.state !== "dead") {
      const d = distTo(debtor.x, debtor.y, v.x, v.y);
      if (d > 3) return [go(debtor.x, debtor.y, 0.6, "去找欠账的人", 3)];
      return [act({ type: "say", text: owed.otherName + "，还欠我 " + owed.coins + " 币呢。", to: debtor.id }, 0.8, "提醒一句")];
    }
  }
  return [];
}

function planShelter(world, v, bb, ctx) {
  const cost = { plank: 8, wood: 4 };
  const have = (v.inventory.plank || 0) >= cost.plank && (v.inventory.wood || 0) >= cost.wood;
  if (!have) {
    if ((v.inventory.plank || 0) < cost.plank && canCraft(v, "plank") && (v.inventory.wood || 0) >= 2) {
      return [act({ type: "craft", recipe: "plank" }, 0.75, "做木板")];
    }
    if (ctx.tree) {
      const d = distTo(ctx.tree.x + 0.5, ctx.tree.y + 0.5, v.x, v.y);
      if (d > 1.8) return [go(ctx.tree.x, ctx.tree.y, 0.8, "去砍树", 1.8)];
      return [act({ type: "chop", x: ctx.tree.x, y: ctx.tree.y }, 0.9, "砍树备料")];
    }
    return [exploreIntent(world, v, bb, ctx, 0.5, "找树")];
  }
  const spot = findBuildSpot(world, v, 10);
  if (!spot) return [exploreIntent(world, v, bb, ctx, 0.35, "找块能盖房的地")];
  return [{ kind: "buildHouse", x: spot.x, y: spot.y, fit: 1, label: "盖房子" }];
}

function surplusOf(v) {
  return Object.entries(v.inventory || {})
    .filter(([id, n]) => ITEMS[id] && n >= 2 && !["bread", "stew", "fish"].includes(id))
    .sort((a, b) => b[1] - a[1]);
}

function planWork(world, v, bb, ctx) {
  const surplus = surplusOf(v);
  const near = ctx.visible.find((o) => !o.minor && o.d < 3.2);
  // 手里有富余、边上有人：卖
  if (surplus.length && near) {
    const [item, n] = surplus[0];
    const price = Math.max(1, Math.round((ITEMS[item].value || 2) * 1.15 * Math.min(n, 2)));
    return [act({ type: "quote", targetId: near.id, side: "sell", item, count: Math.min(n, 2), price }, 0.55, "问问要不要买")];
  }
  // 板子在旁边：开一场小拍卖
  if (surplus.length && ctx.board) {
    const d = distTo(ctx.board.x + 0.5, ctx.board.y + 0.5, v.x, v.y);
    if (d > 2.8) return [go(ctx.board.x, ctx.board.y, 0.45, "去公告板", 2.8)];
    return [act({ type: "publish", kind: "auction", item: surplus[0][0], count: Math.min(surplus[0][1], 2), price: Math.max(4, Math.round(ITEMS[surplus[0][0]].value)), seconds: 90 }, 0.5, "张罗一场拍卖")];
  }
  // 没有货：去水里或树边挣
  if (ctx.water) {
    const d = distTo(ctx.water.x + 0.5, ctx.water.y + 0.5, v.x, v.y);
    if (d > 2.0) return [go(ctx.water.x, ctx.water.y, 0.7, "去水边", 2.0)];
    return [act({ type: "fish" }, successRate(bb, "fish"), "钓鱼换钱")];
  }
  if (ctx.tree) {
    const d = distTo(ctx.tree.x + 0.5, ctx.tree.y + 0.5, v.x, v.y);
    if (d > 1.8) return [go(ctx.tree.x, ctx.tree.y, 0.6, "去砍树", 1.8)];
    return [act({ type: "chop", x: ctx.tree.x, y: ctx.tree.y }, 0.7, "砍树")];
  }
  return [exploreIntent(world, v, bb, ctx, 0.45, "找活干")];
}

function planSocial(world, v, bb, ctx) {
  if (!ctx.visible.length) return [exploreIntent(world, v, bb, ctx, 0.35, "去人多的地方")];
  const t = ctx.visible[0];
  const mem = bb.mem.people[t.id];
  // 被打过的人：谨慎高的会绕开
  if (mem && mem.attacks > 0 && bb.traits.caution > 6.5) return [];
  if (t.d > 2.4) return [go(Math.floor(t.x), Math.floor(t.y), 0.8, "走近 " + t.name, 2.2)];
  return [{ kind: "talk", targetId: t.id, fit: 1, label: "和 " + t.name + " 说话" }];
}

function planExplore(world, v, bb, ctx) {
  return [exploreIntent(world, v, bb, ctx, 0.9, "往没去过的地方走")];
}

function planPractice(world, v, bb, ctx) {
  const skills = v.skills || {};
  const lowest = ["fishing", "foraging", "cooking"]
    .map((k) => [k, skills[k] ? skills[k].level : 0])
    .sort((a, b) => a[1] - b[1])[0];
  if (lowest[0] === "fishing" && ctx.water) {
    const d = distTo(ctx.water.x + 0.5, ctx.water.y + 0.5, v.x, v.y);
    if (d > 2.0) return [go(ctx.water.x, ctx.water.y, 0.7, "去练钓鱼", 2.0)];
    return [act({ type: "fish" }, 0.85, "练钓鱼")];
  }
  if (lowest[0] === "cooking" && ctx.stove && (v.inventory.fish || 0) >= 2) {
    const d = distTo(ctx.stove.x + 0.5, ctx.stove.y + 0.5, v.x, v.y);
    if (d > 1.6) return [go(ctx.stove.x, ctx.stove.y, 0.6, "去灶台", 1.6)];
    return [act({ type: "cook", recipe: "stew" }, 0.8, "练做饭")];
  }
  if (ctx.tree) {
    const d = distTo(ctx.tree.x + 0.5, ctx.tree.y + 0.5, v.x, v.y);
    if (d > 1.8) return [go(ctx.tree.x, ctx.tree.y, 0.55, "去砍树", 1.8)];
    return [act({ type: "chop", x: ctx.tree.x, y: ctx.tree.y }, 0.7, "练手艺")];
  }
  return [exploreIntent(world, v, bb, ctx, 0.35, "找点事做")];
}

function planBeautify(world, v, bb, ctx) {
  const home = (bb.mem.stats.myHouse) || v.home || world.map.spawn;
  const d = distTo(home.x + 0.5, home.y + 0.5, v.x, v.y);
  if (d > 3) return [go(home.x, home.y, 0.5, "回家门口", 3)];
  const spot = findGrassNear(world, v, 2);
  if (!spot) return [];
  const kind = bb.traits.order > 6.5 ? "flower" : (v.inventory.plank >= 1 ? "bench" : null);
  if (!kind) return [];
  if (kind === "bench" && (v.inventory.plank || 0) < 2) return [];
  return [{ kind: "build", buildKind: kind, x: spot.x, y: spot.y, fit: 0.8, label: kind === "bench" ? "摆张长椅" : "种朵花" }];
}

function planCivic(world, v, bb, ctx) {
  if (ctx.board) {
    const d = distTo(ctx.board.x + 0.5, ctx.board.y + 0.5, v.x, v.y);
    if (d > 2.2) return [go(ctx.board.x, ctx.board.y, 0.5, "去公告板", 2.2)];
  }
  return [act({ type: "readForum" }, 0.6, "看看最近的事"), act({ type: "readBoard" }, 0.4, "读公告")];
}

function planCare(world, v, bb, ctx) {
  const kids = kidsNeedingCare(world, v, bb).sort((a, b) => a.needs.hunger - b.needs.hunger);
  const kid = kids[0];
  if (!kid) return [];
  const food = ["fish", "bread", "stew"].find((f) => (v.inventory[f] || 0) > 0);
  if (!food) return [];
  const d = distTo(kid.x, kid.y, v.x, v.y);
  if (d > 2.2) return [go(Math.floor(kid.x), Math.floor(kid.y), 0.85, "去看看 " + kid.name, 2.0)];
  return [{ kind: "give", targetId: kid.id, item: food, count: 1, fit: 1, label: "给 " + kid.name + " 送口吃的" }];
}

function planVisit(world, v, bb, ctx) {
  const s = bb.mem.seenSettlements[0];
  if (!s) return [];
  const d = distTo(s.x + 0.5, s.y + 0.5, v.x, v.y);
  if (d < 3) return [act({ type: "wait" }, 0.2, "在 " + s.name + " 转一圈")];
  return [go(s.x, s.y, 0.8, "去 " + s.name, 2.5)];
}

// 未成年人的行动：跟着人、玩耍、听、吃睡
function planFollow(world, v, bb, ctx) {
  const adults = ctx.visible.filter((o) => !o.minor);
  const fam = (v.family && v.family.parents) || [];
  const target = adults.find((o) => fam.includes(o.id)) || adults[0];
  if (!target) return [];
  if (target.d > 2.6) return [go(Math.floor(target.x), Math.floor(target.y), 0.8, "跟上去", 2.4)];
  return [act({ type: "wait" }, 0.4, "待在旁边")];
}

function planPlay(world, v, bb, ctx) {
  const home = v.home || world.map.spawn;
  const ax = Math.floor(v.x) - home.x, ay = Math.floor(v.y) - home.y;
  // 离家太远就往回跑，否则在附近换个方向撒欢
  if (Math.hypot(ax, ay) > 6) return [go(home.x, home.y, 0.7, "跑回家附近", 2)];
  const dx = ctx.rngValue > 0.5 ? 1 : -1;
  const dy = (ctx.rngValue * 3) % 1 > 0.5 ? 1 : -1;
  return [go(Math.floor(v.x) + dx * 4, Math.floor(v.y) + dy * 4, 0.6, "跑一跑", 1)];
}

function planListen(world, v, bb, ctx) {
  const adult = ctx.visible.find((o) => !o.minor);
  if (!adult) return [];
  if (adult.d > 3) return [go(Math.floor(adult.x), Math.floor(adult.y), 0.5, "凑过去听", 2.6)];
  return [act({ type: "wait" }, 0.5, "听大人说话")];
}

const PLANS = {
  rest: planRest, eat: planEat, get_food: planGetFood, hearth: planHearth,
  debt: planDebt, shelter: planShelter, work: planWork, social: planSocial,
  explore: planExplore, practice: planPractice, beautify: planBeautify,
  civic: planCivic, visit: planVisit, care: planCare,
  follow: planFollow, play: planPlay, listen: planListen
};

/**
 * 所有活跃目标各提几个候选，按"急迫度 × 情境契合 × 性格偏好 − 距离代价"打分。
 * 返回排序后的候选列表；执行层只取第一个，但保留全表用于调试。
 */
export function propose(world, v, bb, ctx, rng) {
  const out = [];
  for (const goal of bb.goals) {
    const planner = PLANS[goal.kind];
    if (!planner) continue;
    let intents = [];
    try { intents = planner(world, v, bb, ctx) || []; } catch { intents = []; }
    for (const it of intents) {
      if (!it || !it.kind) continue;
      const fit = clamp01(it.fit == null ? 0.5 : it.fit);
      let score = goal.priority * (0.35 + fit * 0.65);
      // 性格偏好：好奇的人更愿意走动，谨慎的人更不愿冒险
      if (it.kind === "goto" || it.kind === "talk") score *= 0.92 + bb.traits.sociability / 90;
      if (it.kind === "build" || it.kind === "buildHouse") score *= 0.9 + bb.traits.industry / 80;
      // 距离代价：舍近求远要有理由
      if (Number.isFinite(it.x) && Number.isFinite(it.y)) {
        const d = distTo(it.x + 0.5, it.y + 0.5, v.x, v.y);
        score -= Math.min(0.18, d / 220);
      }
      score -= (bb.traits.caution / 10) * (it.kind === "goto" && it.blind ? 0.04 : 0);
      score += rng.next() * 0.03;    // 一点自己的主意，不至于千人一面
      out.push({ intent: it, score: r2(score), goalKind: goal.kind, goalLabel: goal.label });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------- 对外：给观察者看的"他在想什么" ----------

export function moodOf(v, bb, ctx) {
  if (ctx.hunger < 20) return "饿";
  if (ctx.energy < 20) return "困";
  if (ctx.hp < 45) return "虚弱";
  if (bb.traits.caution > 7 && ctx.alone && ctx.night) return "警惕";
  if (ctx.socialRecent && bb.traits.optimism > 6) return "愉快";
  if (bb.traits.sociability > 6.5 && ctx.ticksSinceTalk > 3600) return "孤单";
  if (bb.traits.optimism > 7) return "自在";
  if (bb.traits.optimism < 3.5) return "沉默";
  return "平静";
}

export function traitLabel(value) {
  if (value >= 8) return "很";
  if (value >= 6.5) return "偏";
  if (value >= 4) return "中等";
  return "淡";
}

/** 一句话解释当下的选择（给 /api/minds 和日志用） */
export function explain(bb) {
  if (!bb.goals.length) return "没什么特别的打算";
  const g = bb.goals[0];
  return g.label + (bb.thought ? "（" + bb.thought + "）" : "");
}

export function dumpMind(v, bb, ctx, drives) {
  return {
    id: v.id, name: v.name,
    mood: bb.mood,
    thought: bb.thought,
    goals: bb.goals.map((g) => ({ kind: g.kind, label: g.label, priority: g.priority, fails: g.fails })),
    drives: drives ? Object.fromEntries(Object.entries(drives).map(([k, x]) => [k, r2(x)])) : null,
    traits: { ...bb.traits },
    memory: {
      places: Object.fromEntries(Object.entries(bb.mem.places).map(([k, l]) => [k, l.length])),
      outcomes: bb.mem.outcomes,
      people: Object.keys(bb.mem.people).length,
      settlements: bb.mem.seenSettlements,
      notes: bb.mem.notes.slice(-3)
    },
    stats: bb.mem.stats
  };
}
