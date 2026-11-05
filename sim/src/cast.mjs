// 世界的初始演员表。
//
// 单独放一个文件，是因为它现在是"可复现"的一部分：回放一份日志时，必须用
// 和当初完全相同的顺序、相同的名字、相同的性格重新 spawn，否则随机流从第一帧
// 就对不上。以前这份名单躺在 server.mjs 里，工具侧根本拿不到。

export const VILLAGERS = [
  { name: "老鲤", role: "fisher", ageDays: 52, personality: { optimism: 4, social: 3, manners: 6 } },
  { name: "阿鲟", role: "farmer", ageDays: 34, personality: { optimism: 8, social: 7, manners: 5 } },
  { name: "团子", role: "cook", ageDays: 28, personality: { optimism: 7, social: 6, manners: 8 } },
  { name: "泡泡", role: "wanderer", ageDays: 21, personality: { optimism: 9, social: 9, manners: 4 } },
  { name: "斑斑", role: "fisher", ageDays: 45, personality: { optimism: 3, social: 2, manners: 7 } },
  { name: "金鳞", role: "farmer", ageDays: 31, personality: { optimism: 6, social: 5, manners: 9 } },
  { name: "小鲫", role: "wanderer", ageDays: 19, personality: { optimism: 5, social: 8, manners: 3 } },
  { name: "大眼", role: "cook", ageDays: 26, personality: { optimism: 6, social: 4, manners: 6 } }
];

export function defaultVillagerCount(raw, cap = VILLAGERS.length) {
  const n = Number(raw ?? 2);
  return Math.max(1, Math.min(cap, Number.isFinite(n) ? n : 2));
}

/**
 * 按固定顺序把初始村民放进去。
 * 顺序即身份：换顺序 = 换随机数 = 换个世界，回放会当场对不上。
 */
export function spawnCast(world, map, count) {
  const n = Math.max(1, Math.min(VILLAGERS.length, count | 0 || 1));
  const homes = (map && map.homes && map.homes.length) ? map.homes : [null];
  const out = [];
  for (let i = 0; i < n; i++) {
    const cfg = VILLAGERS[i];
    out.push(world.spawn({ ...cfg, home: homes[i % homes.length] }));
  }
  return out;
}
