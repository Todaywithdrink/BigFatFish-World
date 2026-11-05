// 代际与生命：年龄、阶段、家庭、天赋/性格遗传。
//
// 蓝图第 3 章的落地规则：
// - 原住民只能作为孩子出生（3.1）：birth 出来的角色 ageDays=0，从童年开始；
// - 未成年数字隔离（3.2）是代码级的：isMinor() 为真的角色不能被外部 AI 接管、
//   不能婚配、不能交易、不能盖房——不靠模型自律；
// - 成年后不再变老（3.3）：年龄照记，但没有"老年"阶段，阶段到 adult 为止；
// - 繁衍与继承（3.4）：天赋/性格由父母混合加变异，资产沿家庭图转移。
//
// 所有"混合"都必须用传入的 rng（world.rng），不能碰 Math.random——
// 同一本流水重跑两遍，生出来的必须是同一个孩子。

export const AGE = {
  TEEN_DAYS: 6,    // 0–5 天是童年（1 游戏天 = 12000 tick = 20 分钟真实时间）
  ADULT_DAYS: 12,  // 第 12 天成年，解锁婚配 / 独立财产 / 自由迁徙
  YEAR_DAYS: 12    // 一岁 = 12 游戏日（与成年阈值对齐：满一岁即成年）
};

export const STAGES = ["child", "teen", "adult"];

export function stageOf(ageDays) {
  const d = Number.isFinite(Number(ageDays)) ? Number(ageDays) : AGE.ADULT_DAYS; // 旧存档没有年龄：按成年算
  if (d < AGE.TEEN_DAYS) return "child";
  if (d < AGE.ADULT_DAYS) return "teen";
  return "adult";
}

export function stageOfV(v) {
  return v.stageCached && v._stageAge === v.ageDays
    ? v.stageCached
    : stageOf(v && v.ageDays);
}

export function isMinor(v) {
  return stageOfV(v) !== "adult";
}

/** 天赋遗传：父母均值 ±0.15 变异，夹回 0.6~1.4（和 rollTalent 同一区间） */
export function mixTalent(rng, a, b) {
  const base = ((a && a.talent) || 1) / 2 + ((b && b.talent) || 1) / 2;
  const t = base + (rng.next() - 0.5) * 0.3;
  return Math.round(Math.min(1.4, Math.max(0.6, t)) * 100) / 100;
}

const PERSONALITY_KEYS = ["optimism", "social", "manners"];

/** 性格遗传：每项取父母均值 ±2 变异，夹回 1~10。消耗随机数的顺序固定。 */
export function mixPersonality(rng, a, b) {
  const out = {};
  for (const k of PERSONALITY_KEYS) {
    const pa = (a && a.personality && a.personality[k]) ?? 5;
    const pb = (b && b.personality && b.personality[k]) ?? 5;
    const v = Math.round((pa + pb) / 2 + (rng.next() * 4 - 2));
    out[k] = Math.min(10, Math.max(1, v));
  }
  return out;
}

/** 外貌（底色）遗传：二选一，不掺新颜色——村子里的长相要有家族感 */
export function mixColor(rng, a, b) {
  return rng.chance(0.5) ? (a && a.color) || null : (b && b.color) || null;
}

export function emptyFamily() {
  return { parents: [], spouseId: null, children: [] };
}

/**
 * 年龄模式：
 * - auto（默认，原住民）：每个游戏日自动 +1 天，世界替他长大；
 * - manual（可选，注册空降的旅行者）：平时一岁不长，由用户决定何时长大——
 *   但不能变小、两次决定至少隔一个游戏日；生日（创建日）那天保底 +1 岁，
 *   保证"最晚一年也能长大一次"。
 */
export function normalizeAging(mode) {
  return mode === "manual" ? "manual" : "auto";
}

/** 兼容旧存档：没有 family 字段就补一个空的 */
export function ensureFamily(v) {
  if (!v.family || typeof v.family !== "object") v.family = emptyFamily();
  if (!Array.isArray(v.family.parents)) v.family.parents = [];
  if (!Array.isArray(v.family.children)) v.family.children = [];
  if (!("spouseId" in v.family)) v.family.spouseId = null;
  return v.family;
}
