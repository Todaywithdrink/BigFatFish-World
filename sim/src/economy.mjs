// L2：物品、货币、生产、交易
//
// 背包额度（2026-11-05）：常规做法是「格子 + 堆叠 + 承重」三重约束，不是一句
// "背包最多 N 个物品"。这里把额度做成**从 inventory 这张扁平表算出来的视图**，
// 好处是全世界已有的 20 多处 inventory 读写不用换成新的数据结构，
// 而所有"往包里加东西"的入口都走 addItem，额度自然对所有产出生效。
export const ITEMS = {
  fish:      { name: "鱼",   value: 8,  emoji: "🐟", cat: "food",     stack: 20, weight: 0.5 },
  berry:     { name: "浆果", value: 3,  emoji: "🫐", cat: "food",     stack: 20, weight: 0.2 },
  flower:    { name: "花",   value: 2,  emoji: "🌼", cat: "material", stack: 30, weight: 0.1 },
  wood:      { name: "木头", value: 2,  emoji: "🪵", cat: "material", stack: 50, weight: 1.2 },
  bread:     { name: "面包", value: 12, emoji: "🍞", cat: "food",     stack: 20, weight: 0.4 },
  stew:      { name: "炖菜", value: 28, emoji: "🍲", cat: "food",     stack: 10, weight: 0.8 },
  plank:     { name: "木板", value: 6,  emoji: "🪓", cat: "material", stack: 50, weight: 0.8 },
  flowerpot: { name: "花盆", value: 15, emoji: "🪴", cat: "decor",    stack: 10, weight: 2.0 },
  cloth:     { name: "花布", value: 10, emoji: "🧵", cat: "material", stack: 20, weight: 0.4 }
};

export const ITEM_IDS = Object.keys(ITEMS);
export const CATEGORY_CN = { food: "食物", material: "材料", decor: "摆件" };

/** 背包：24 格 / 80 负重 / 单种物品最多 6 格。储物箱更宽，但走同一套算法。 */
export const BAG_RULES = { slots: 24, maxWeight: 80, perKindSlots: 6 };
export const CHEST_RULES = { slots: 30, maxWeight: 200, perKindSlots: 10 };

// 做菜：需要食材，产出成品，顺带学这道菜
export const COOK_RECIPES = [
  { id: "bread", name: "面包", needs: { berry: 2, wood: 1 }, out: { bread: 1 }, learningCost: 4 },
  { id: "stew",  name: "炖菜", needs: { fish: 2, berry: 1 },  out: { stew: 1 },  learningCost: 8 }
];

export function emptyInventory() {
  const inv = {};
  for (const id of ITEM_IDS) inv[id] = 0;
  return inv;
}

/**
 * 额度视图。stack 决定"这一堆占几格"，weight 决定总负重。
 * 只认 ITEMS 里登记过的物品，未知 id 不占格也不占重（存档里的脏数据不会撑爆背包）。
 */
export function bagUsage(inv, rules = BAG_RULES) {
  const items = [];
  let slots = 0, weight = 0, total = 0;
  for (const id of ITEM_IDS) {
    const n = Math.max(0, Math.floor(Number(inv?.[id]) || 0));
    if (!n) continue;
    const def = ITEMS[id];
    const s = Math.ceil(n / def.stack);
    const w = Math.round(n * def.weight * 100) / 100;
    slots += s; weight += w; total += n;
    items.push({
      id, name: def.name, emoji: def.emoji, cat: def.cat, catName: CATEGORY_CN[def.cat],
      count: n, stack: def.stack, unitWeight: def.weight, value: def.value,
      slots: s, weight: Math.round(w * 100) / 100
    });
  }
  return {
    items, slots, slotCap: rules.slots,
    weight: Math.round(weight * 100) / 100, weightCap: rules.maxWeight,
    kinds: items.length, kindCap: rules.perKindSlots,
    total, full: slots >= rules.slots || weight >= rules.maxWeight,
    rules: { ...rules }
  };
}

/**
 * 能不能把 delta 这批增减放进包里？delta 允许负数（先扣材料再产出，净变化可能为负）。
 * 返回 reason 让调用方知道是卡在哪一条额度上，界面才能给出"还差几格 / 超重多少"。
 */
export function bagFits(inv, delta, rules = BAG_RULES) {
  const next = { ...(inv || {}) };
  for (const [id, raw] of Object.entries(delta || {})) {
    if (!ITEMS[id]) return { ok: false, rule: "unknown_item", item: id };
    const n = Number(raw) || 0;
    next[id] = Math.max(0, Math.floor(Number(next[id]) || 0) + Math.floor(n));
  }
  const u = bagUsage(next, rules);
  const overKind = u.items.find((it) => it.slots > rules.perKindSlots);
  if (overKind) {
    return { ok: false, rule: "kind_limit", item: overKind.id,
      limit: rules.perKindSlots * ITEMS[overKind.id].stack,
      hint: `${overKind.name}最多放 ${rules.perKindSlots * ITEMS[overKind.id].stack} 个` };
  }
  if (u.slots > rules.slots) {
    return { ok: false, rule: "slots", used: u.slots, limit: rules.slots,
      hint: `背包格子不够（需要 ${u.slots}/${rules.slots}）` };
  }
  if (u.weight > rules.maxWeight) {
    return { ok: false, rule: "weight", used: u.weight, limit: rules.maxWeight,
      hint: `太重了（${u.weight}/${rules.maxWeight}）` };
  }
  return { ok: true, usage: u };
}

/** 唯一合法的"往背包加东西"入口：额度不够就拒绝，返回 false。 */
export function addItem(v, id, n) {
  if (!ITEMS[id] || !(n > 0)) return false;
  const count = Math.floor(n);
  if (!bagFits(v.inventory, { [id]: count }).ok) return false;
  v.inventory[id] = (v.inventory[id] || 0) + count;
  return true;
}

/**
 * 绕过额度的强制写入，只给"世界义务"用：管理员发放、遗产继承、拍卖托管物归还。
 * 这些场景里东西不能凭空消失——吞掉一件托管物比让背包短暂超限严重得多。
 */
export function addItemForced(v, id, n) {
  if (!ITEMS[id] || !(n > 0)) return false;
  v.inventory[id] = (v.inventory[id] || 0) + Math.floor(n);
  return true;
}

export function hasItems(v, needs) {
  for (const [id, n] of Object.entries(needs)) {
    if ((v.inventory[id] || 0) < n) return false;
  }
  return true;
}

export function takeItems(v, needs) {
  if (!hasItems(v, needs)) return false;
  for (const [id, n] of Object.entries(needs)) v.inventory[id] -= n;
  return true;
}

export function inventoryValue(v) {
  let sum = 0;
  for (const [id, n] of Object.entries(v.inventory || {})) {
    if (ITEMS[id]) sum += ITEMS[id].value * n;
  }
  return sum;
}

/**
 * 个人估值：没有"官方价"，只有这个角色此刻愿意为它出多少钱。
 * 越缺越贵，手里越多越不值钱。
 */
export function personalValue(v, id) {
  const base = ITEMS[id] ? ITEMS[id].value : 1;
  const stock = (v.inventory && v.inventory[id]) || 0;
  const scarcity = Math.max(0.6, Math.min(1.8, 1.35 - stock * 0.12));
  return base * scarcity;
}

export function inventoryList(v) {
  return bagUsage(v.inventory).items.map((it) => ({
    id: it.id, name: it.name, emoji: it.emoji, cat: it.cat, catName: it.catName,
    count: it.count, stack: it.stack, slots: it.slots,
    weight: it.weight, unitWeight: it.unitWeight, value: it.value
  }));
}

// ---------- 制作：按大类累计熟练度，天赋决定学得快不快 ----------
export const CRAFT_CATEGORIES = { food: "食物", material: "材料", decor: "摆件" };

export const CRAFT_RECIPES = [
  { id: "plank",      category: "material", needs: { wood: 2 },              out: { plank: 1 } },
  { id: "bread",      category: "food",     needs: { berry: 2, wood: 1 },    out: { bread: 1 } },
  { id: "stew",       category: "food",     needs: { fish: 2, berry: 1 },    out: { stew: 1 } },
  { id: "flowerpot",  category: "decor",    needs: { plank: 1, flower: 1 },  out: { flowerpot: 1 } },
  { id: "cloth",      category: "material", needs: { flower: 3 },            out: { cloth: 1 } }
];

/** 成功率和熟练度：大类里做得越多越稳，天赋放大这个增益 */
export function craftChance(v, category) {
  const prof = (v.craftProf && v.craftProf[category]) || 0;
  const talent = v.talent || 1;
  return Math.max(0.15, Math.min(0.96, 0.42 + prof * 0.015 * talent));
}
