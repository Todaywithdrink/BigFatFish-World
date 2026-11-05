// 技能、天赋、食谱：天赋是隐藏值，只影响成长速度，不进任何对外数据
export const SKILL_IDS = ["farming", "mining", "foraging", "fishing", "combat", "cooking", "social"];

// 与原版对齐的经验门槛
export const XP_TABLE = [0, 100, 380, 770, 1300, 2150, 3300, 4800, 6900, 10000, 15000];

export const RECIPES = [
  { id: "stew", name: "炖菜", skill: "cooking", learningCost: 6 },
  { id: "pie", name: "派", skill: "cooking", learningCost: 10 },
  { id: "salad", name: "沙拉", skill: "cooking", learningCost: 4 }
];

export function levelFor(xp) {
  let lv = 0;
  for (let i = 1; i < XP_TABLE.length; i++) if (xp >= XP_TABLE[i]) lv = i;
  return lv;
}

/**
 * 每个技能节点：
 *   xp / level  当前熟练度
 *   lastUse     最后一次练它是什么时候（遗忘曲线靠这个）
 *   best        练到过的最高经验（隐藏）。遗忘只忘到它的一半就停手——
 *               会生疏，但不会把"这个人练过"这件事一起抹掉。
 */
export function newSkills() {
  const s = {};
  for (const id of SKILL_IDS) s[id] = { xp: 0, level: 0, lastUse: 0, best: 0 };
  return s;
}

/** 天赋 0.6 ~ 1.4，越接近 1.4 学得越快。对外不可见。
 *  rnd 必须由调用方给（内核传 world.rng），默认值只留给离线工具。 */
export function rollTalent(rnd = Math.random) {
  return Math.round((0.6 + rnd() * 0.8) * 100) / 100;
}

/** 加经验：天赋只在这里起作用。tick 用来记"最后一次用到它是什么时候"。 */
export function addXp(v, skill, base, tick = null) {
  const node = v.skills[skill];
  if (!node) return;
  node.xp += base * v.talent;
  node.level = levelFor(node.xp);
  if (node.xp > (node.best || 0)) node.best = node.xp;
  if (tick != null) node.lastUse = tick;
}

/**
 * 遗忘：太久没用的技能会一点点变钝。
 *
 * 关键在于"忘到哪为止"。如果一路忘到 0，所有人最后都变成同一张白纸，
 * 而这张纸上的差异恰恰是这个世界唯一有意思的东西。所以下限取巅峰的一半：
 * 一直在钓的老鲤，就算十年不碰鱼竿，也仍然比从没下过水的团子强。
 * 这是"生疏"，不是"失忆"。
 *
 * 纯函数式：只依赖 tick 和节点自身字段，不掷骰子，所以回放稳定。
 * 返回 [{ skill, from, to }]，只列掉级的，用来广播给观众。
 */
export function decaySkills(v, tick, { graceTicks, ratePerHour }) {
  const dropped = [];
  for (const id of SKILL_IDS) {
    const node = v.skills[id];
    if (!node || node.xp <= 0) continue;
    if (tick - (node.lastUse || 0) < graceTicks) continue;

    const peak = Math.max(node.best || 0, node.xp);
    const floor = peak * 0.5;
    if (node.xp <= floor) continue;

    const before = node.level;
    const loss = Math.min(node.xp - floor, Math.max(1, node.xp * ratePerHour));
    node.xp = Math.max(floor, node.xp - loss);
    node.level = levelFor(node.xp);
    if (node.level < before) dropped.push({ skill: id, from: before, to: node.level });
  }
  return dropped;
}

/**
 * 尝试学一道菜。每次尝试按天赋累积进度，进度够 learningCost 就学会。
 * 返回 { learned, progress, cost }。
 */
export function tryLearnRecipe(v, recipe) {
  v.recipeProgress = v.recipeProgress || {};
  if (v.knownRecipes.includes(recipe.id)) return { learned: true, progress: 1, cost: 0 };
  const p = (v.recipeProgress[recipe.id] || 0) + v.talent;
  v.recipeProgress[recipe.id] = p;
  if (p >= recipe.learningCost) {
    v.knownRecipes.push(recipe.id);
    return { learned: true, progress: p, cost: recipe.learningCost };
  }
  return { learned: false, progress: p, cost: recipe.learningCost };
}
