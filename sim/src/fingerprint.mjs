// 世界指纹：把"这一刻的世界"压成一个短字符串。
//
// 回放要回答的问题只有一个——重跑出来的世界，和当初那个是不是同一个。
// 逐字段 diff 在几千 tick 之后噪声太大，所以先比指纹：对上了再看细节。
//
// 排序必须显式做：Map / Set 的迭代顺序依赖插入历史，而"插入历史"正是
// 回放最容易分叉的地方。不排序就会把顺序差异误报成状态差异。

import { createHash } from "node:crypto";
import { stageOf } from "./lifecycle.mjs";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 只取"世界状态"，不取时间戳、日志、连接状态这些外围东西 */
export function worldState(world) {
  const ents = [...world.entities.values()]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((v) => ({
      id: v.id, name: v.name, uid: v.uid, role: v.role,
      x: r2(v.x), y: r2(v.y), dir: r2(v.dir),
      hp: r2(v.hp), state: v.state,
      stage: stageOf(v.ageDays),
      ageDays: Number.isFinite(v.ageDays) ? v.ageDays : null,
      aging: v.aging || "auto",
      bornDay: Number.isFinite(v.bornDay) ? v.bornDay : null,
      lastGrowDay: Number.isFinite(v.lastGrowDay) ? v.lastGrowDay : null,
      family: v.family ? [v.family.parents || [], v.family.spouseId || null, v.family.children || []] : null,
      needs: { energy: r2(v.needs && v.needs.energy), hunger: r2(v.needs && v.needs.hunger) },
      coins: v.coins, talent: v.talent,
      inventory: Object.fromEntries(Object.entries(v.inventory || {}).filter(([, n]) => n)),
      skills: Object.fromEntries(Object.entries(v.skills || {}).map(([k, s]) => [k, [r2(s.xp), s.level, s.lastUse, r2(s.best)]])),
      appearance: v.appearance || null,
      explored: (v.explored ? [...v.explored].sort() : []).length,
      external: !!v.external,
      nextBirthTick: Number.isFinite(v.nextBirthTick) ? v.nextBirthTick : null
    }));

  return {
    tick: world.tickCount,
    clock: { day: world.clock.day, minutes: r2(world.clock.minutes), season: world.clock.season },
    rng: world.rng ? world.rng.state : null,
    ents,
    patches: [...world.patches.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    quotes: [...world.quotes.values()].map((q) => [q.id, q.state, q.item, q.count, q.price]).sort(),
    protocols: [...world.protocols.values()].map((p) => [p.id, p.state, p.item, p.count]).sort(),
    board: (world.board || []).length,
    forum: [(world.forum || []).length, world.forumSeq || 0],
    commitments: [
      [...(world.commitments || new Map()).values()].filter((c) => !c.settledAt).length,
      world.commitmentSeq || 0
    ],
    settlements: [...(world.settlements || new Map()).values()].map((s) => [s.key, s.houses, s.foundedTick]).sort(),
    // 门 / 箱子：开合、锁、箱内物品都会让世界线分叉，必须进指纹；
    // 密码摘要本身只记"有没有"，避免把凭证内容带进任何诊断输出。
    props: [...(world.props || new Map()).values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => [p.id, p.kind, p.x, p.y, p.open ? 1 : 0,
        p.lock?.locked ? 1 : 0, p.lock?.mode || "none", p.lock?.secret ? 1 : 0,
        p.kind === "chest" ? Object.entries(p.items || {}).filter(([, n]) => n) : null]),
    pairs: [...world.pairs.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => [k, r2(n)])
  };
}

export function worldHash(world) {
  return createHash("sha256").update(JSON.stringify(worldState(world))).digest("hex").slice(0, 16);
}

/** 找出两份状态第一处不同的地方，回放对不上时给人看的 */
export function firstDifference(a, b) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja === jb) return null;
  for (const key of Object.keys(a)) {
    const sa = JSON.stringify(a[key]), sb = JSON.stringify(b[key]);
    if (sa === sb) continue;
    if (Array.isArray(a[key]) && Array.isArray(b[key])) {
      for (let i = 0; i < Math.max(a[key].length, b[key].length); i++) {
        if (JSON.stringify(a[key][i]) !== JSON.stringify(b[key][i])) {
          return { field: key, index: i, mine: a[key][i], theirs: b[key][i] };
        }
      }
    }
    return { field: key, mine: a[key], theirs: b[key] };
  }
  return { field: "(unknown)" };
}
