// 大陆大纲：世界形貌在开服那一刻就定死了。
//
// 设计立场（大纲修订 2026-11）：这个世界只有一个新手村，其余聚落由居民自己盖。
// "渐进开放"不是临时随机，而是把预先定好的大陆一块块显现出来——
// 居民走到边界，或管理员解锁，才长出下一块。大陆有尽头：东边是海，南边是山。
//
// 主题由 (区域坐标, 世界种子) 确定性决定：同一颗种子无论何时查询、按什么顺序
// 查询，答案都一样。这保证：① 回放一致；② "补全世界形貌"只是继续按图施工。

export const CONTINENT = {
  chunk: 32,   // 一个区域 32×32 格
  cols: 12,    // 12 列 = 最大 384 宽（新手村占 0–3 列）
  rows: 4      // 4 行 = 最大 128 高（新手村占 0–1 行）
};

// 区域主题 → expand 的生成参数
export const THEMES = {
  plain:    { label: "平原", treeChance: 0.03, edgeKind: null },
  forest:   { label: "密林", treeChance: 0.14, edgeKind: null },
  lake:     { label: "湖区", treeChance: 0.05, edgeKind: null },
  hill:     { label: "丘陵", treeChance: 0.06, edgeKind: null },
  sea:      { label: "海",   treeChance: 0,    edgeKind: "water" },
  mountain: { label: "山脊", treeChance: 0.02, edgeKind: "rock" }
};

function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * 区域主题：确定性、纯函数。
 * 大陆形状：最东一列是海，最南一行是山脊，中间是噪声起伏的陆地。
 * 新手村所在的前四列保证不出大湖（出生地周围要能走）。
 */
export function regionTheme(cx, cy, seed = 1) {
  if (cx < 0 || cy < 0 || cx >= CONTINENT.cols || cy >= CONTINENT.rows) return "sea";
  if (cx === CONTINENT.cols - 1) return "sea";       // 东海
  if (cy === CONTINENT.rows - 1) return "mountain";  // 南山脊
  if (cx <= 5) {
    // 新手村周边（含最初几块扩展区）：平缓好走。低频噪声给一点起伏，但不出湖
    const n = hash2(cx * 3 + 1, cy * 7 + 2, seed ^ 0x51a3);
    return n > 0.62 ? "forest" : "plain";
  }
  const n = hash2(cx * 13 + 5, cy * 17 + 3, seed);
  if (n > 0.80) return "lake";
  if (n > 0.58) return "forest";
  if (n > 0.30) return "plain";
  return "hill";
}

/** 某方向是否还能再长（用于提前拒绝，别白耗 rng） */
export function canExpand(side, width, height) {
  if (side === "e") return Math.floor(width / CONTINENT.chunk) < CONTINENT.cols;
  if (side === "s") return Math.floor(height / CONTINENT.chunk) < CONTINENT.rows;
  return false; // n/w 不长：新手村背后就是世界的边缘
}

/** 大陆全图（给调试/文档/以后的世界地图用） */
export function continentMap(seed = 1) {
  const rows = [];
  for (let cy = 0; cy < CONTINENT.rows; cy++) {
    rows.push(Array.from({ length: CONTINENT.cols }, (_, cx) => regionTheme(cx, cy, seed)));
  }
  return rows;
}
