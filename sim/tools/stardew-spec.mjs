// ============================================================
// stardew-spec.mjs —— 星露谷式高度分层规格（单一真源）
//
// 谁在用：
//   · sim/tools/hubei-stardew.mjs   离屏烘焙（本文件的全部数字）
//   · sim/viewer/world-view.js      运行时同一套层带（避免"预览图对、游戏里不对"）
//
// 设计要点：
//   1) 层带（tier）是**视觉分层**，不等于等高线。低地带薄、高地带厚，
//      让 90% 面积所在的平原/丘陵有足够层数可读，高山不至于撑爆画面。
//   2) 抬升是"制图抬升"，不是真实高程的等比投影——否则 3105 m 会抬到 1000 px 以上。
//      两套标尺：L0 每 8 m 抬 1 整格（16 px），全省海报每层带抬 1 px（见下方常量）。
//   3) 坡度不靠"摊薄一级落差"表达，靠**台阶间距**：run = 4/g 格。
//      单级落差恒定整格，任何非整格的斜坡都会糊掉像素边。
// ============================================================

// ---------- 基准比例 ----------
export const GRID_M = 2;              // 1 格 = 2 m（L0 基准）
export const TILE_PX = 16;            // 1 格 = 16 px → 1 px = 0.125 m

// 抬升有两套，别混用：
//   MICRO（L0 玩家尺度）—— 每 8 m 一级，抬 1 整格 = 16 px。坡度靠"踏步间距"表达，
//                         单级落差永远是整格，绝不摊成半级或 1/3 级。
//   MACRO（全省海报 L4）—— 500 m/格 时一个层带就横跨十几格，抬 16 px 会让全省
//                         堆成几百像素高的千层饼，所以压到 1 格 × pp = 2 px/层带。
export const LIFT_TILE = 1.0;                 // MACRO：每个层带抬 1 格（海报 pp=2 时 = 2 px）
export const LIFT_PX = TILE_PX * LIFT_TILE;   // MACRO = 8 px（仅 LIFT_TILE 在 pp=1 时的等价像素）

// ---------- 层带边界（米）----------
// 15 个陆地层 + 水面层。等比约 1.42，低地带更密。
export const BOUNDS = [26, 35, 45, 58, 75, 98, 128, 168, 225, 305, 430, 640, 1000, 1700, 2400];

// surf: 台面主色（草/植被/雪）   soil: 露出的心土色（悬崖侧壁的"高度分界线"）
// 边界按真实高程分位数定（全省陆地 22–2790 m，中位数 184 m），每层都有实际面积，不出现"空层"。
export const TIERS = [
  { id:  0, name: "水面", lo: -9999, hi: 26, surf: [ 72, 122, 168], soil: [ 96,  80,  60] },
  { id:  1, name: "河漫滩", lo: 26, hi: 35, surf: [122, 164,  96], soil: [184, 136,  88] },
  { id:  2, name: "一级阶地", lo: 35, hi: 45, surf: [136, 176, 102], soil: [178, 130,  84] },
  { id:  3, name: "二级阶地", lo: 45, hi: 58, surf: [130, 174,  98], soil: [170, 122,  80] },
  { id:  4, name: "岗地", lo: 58, hi: 75, surf: [122, 168,  94], soil: [162, 116,  76] },
  { id:  5, name: "缓丘", lo: 75, hi: 98, surf: [114, 162,  90], soil: [152, 108,  72] },
  { id:  6, name: "丘陵", lo: 98, hi: 128, surf: [106, 154,  86], soil: [142, 100,  68] },
  { id:  7, name: "高丘", lo: 128, hi: 168, surf: [ 98, 144,  82], soil: [132,  92,  64] },
  { id:  8, name: "低山", lo: 168, hi: 225, surf: [ 90, 134,  78], soil: [122,  86,  60] },
  { id:  9, name: "中山", lo: 225, hi: 305, surf: [ 84, 122,  76], soil: [112,  80,  56] },
  { id: 10, name: "中高山", lo: 305, hi: 430, surf: [ 80, 114,  76], soil: [102,  74,  54] },
  { id: 11, name: "亚高山", lo: 430, hi: 640, surf: [ 82, 108,  78], soil: [ 94,  68,  52] },
  { id: 12, name: "高山", lo: 640, hi: 1000, surf: [ 94, 110,  86], soil: [ 86,  62,  50] },
  { id: 13, name: "高山针叶", lo: 1000, hi: 1700, surf: [114, 120, 100], soil: [ 78,  56,  46] },
  { id: 14, name: "草甸·裸岩", lo: 1700, hi: 2400, surf: [142, 144, 126], soil: [ 70,  58,  52] },
  { id: 15, name: "雪线", lo: 2400, hi: 99999, surf: [228, 233, 238], soil: [ 96,  94,  92] }
];

export const MAX_TIER = TIERS.length - 1;

// ---------- 微台阶（L0 局部尺度）----------
// 宏观层带一层厚 7–700 m，80 格（160 m）的窗口里可能一级都跨不过去，
// 所以 L0 另立一套微观标尺：每 8 m 一级台阶，抬升 1 整格。
//   · 宏观层带只管"配色/图例"（tierOf）
//   · 微台阶只管"看得见的高低差"（levelOf）
// 一级台阶 = 8 m 高差 = 16 px 落差 = 16 px 水平 = 正好一格。
// 这一格既是台面也是立面，星露谷的"一格一崖"在此成立。
export const MICRO_LIFT_PX = TILE_PX;   // 单级落差 16 px（1 整格），不允许半级
export const STEP_M = 8;                // 每 8 m 一级
export const STEP_PX_PER_M = MICRO_LIFT_PX / STEP_M;   // 2 px/m（垂直）
export const H_PX_PER_M = TILE_PX / GRID_M;            // 8 px/m（水平）
export const V_COMPRESS = H_PX_PER_M / STEP_PX_PER_M;  // 垂直压缩 4×，制图约定，不随地形变

/** 高程（米）→ 连续台阶数（可为小数；取整后即为第几级台地） */
export function levelOf(h) {
  return h > 0 ? h / STEP_M : 0;
}

/** 高程（米）→ 连续土色（层带土壤色之间线性插值，让每一级台阶的露土都有细微差别） */
export function soilAt(h) {
  const t = tierOf(h);
  const nt = Math.min(MAX_TIER, t + 1);
  const span = TIERS[t].hi - TIERS[t].lo;
  const f = span > 0 && span < 9000 ? Math.max(0, Math.min(1, (h - TIERS[t].lo) / span)) : 0;
  return mix(TIERS[t].soil, TIERS[nt].soil, f * 0.55);
}


/** 高程（米）→ 层号 0..15 */
export function tierOf(h) {
  if (!(h >= BOUNDS[0])) return 0;
  for (let i = 1; i < BOUNDS.length; i++) if (h < BOUNDS[i]) return i;
  return MAX_TIER;
}

/** 层号 → 该层下界（米） */
export function tierLo(t) { return t <= 0 ? 0 : BOUNDS[t - 1]; }

// ---------- 坡度衔接 ----------
// 这里要纠正一个直觉错误：**坡不是"把一级落差摊薄"，而是"把多级台阶排密"。**
//   · 单级落差恒定 16 px，永远只占 1 格宽 —— 摊薄会得到 5.3px 这种非整数行高，
//     一上屏就是抗锯齿糊边，像素味全丢；半级（8px）更糟，会把一堵崖拆成虚线。
//   · 坡度的真实表达是**相邻两级台阶的水平间距**：run = STEP_M / (g · GRID_M) = 4/g 格。
//     g=0.1 → 每 40 格升一级（缓，像缓坡）；g=0.7 → 每 5.7 格升一级（陡，像楼梯）；
//     g>1 → 间距 <4 格，多级挤在一起并成一堵直壁。
//   · softenR 只是**崖线错位半径**：让台地边缘不要长成一条笔直的刀切边，
//     它改变"边界落在哪一格"，不改变任何一级的落差，也不承担坡度表达。
export const SLOPE = [
  { key: "flat",   name: "台地", minG: 0,     maxG: 0.052,    softenR: 0, note: "3° 以下，一屏之内不换级" },
  { key: "gentle", name: "缓坡", minG: 0.052, maxG: 0.213,    softenR: 2, note: "每 19–77 格升一级" },
  { key: "middle", name: "中坡", minG: 0.213, maxG: 0.466,    softenR: 1, note: "每 9–19 格升一级" },
  { key: "steep",  name: "陡坡", minG: 0.466, maxG: 0.839,    softenR: 0, note: "每 5–9 格升一级，台阶密集" },
  { key: "cliff",  name: "陡崖", minG: 0.839, maxG: Infinity, softenR: 0, note: "间距 <5 格，多级并成直壁" }
];

export function slopeClass(g) {
  for (const s of SLOPE) if (g < s.maxG) return s;
  return SLOPE[SLOPE.length - 1];
}

/**
 * 坡度 → 相邻两级台阶的水平间距（格）。
 * 这就是"坡度衔接区"的实际宽度：坡度越缓，衔接越长；坡度越陡，衔接越短。
 * 台地返回 Infinity（一级都不升）。
 */
export function riserRunCells(g) {
  if (!(g > SLOPE[0].maxG)) return Infinity;
  return STEP_M / (g * GRID_M);          // = 4 / g
}

/** 坡度 → 崖线错位半径 R（格）。只去锯齿，不改落差 */
export function softenR(g) {
  for (const s of SLOPE) if (g < s.maxG) return s.softenR;
  return 0;
}

/** 坡度 → 一屏（80 格 = 160 m 水平）内能看到的台阶级数，用来判断"读得像坡还是像墙" */
export function risersPerScreen(g, screenCells = 80) {
  const run = riserRunCells(g);
  return isFinite(run) ? screenCells / run : 0;
}

// ---------- 侧壁（露土剖面）----------
// 只画朝南（+y）的层界：3/4 俯视下只有南面能被看到，
// 东西向的层界用 1px 描边带过，北面完全不可见。
export const FACE = {
  lip: 1,        // 顶缘草皮断面（1px）
  sub: 1,        // 表土
  base: 1,       // 底部暗影
  striate: 3     // 每隔 3px 打一条横向土纹
};

// ---------- 画面常量 ----------
export const PALETTE = {
  voidBg:   [ 22,  26,  22],
  shadow:   [ 30,  26,  20],
  edgeDark: [ 26,  22,  16],
  water:    [ 72, 122, 168],
  waterHi:  [ 96, 148, 190],
  foam:     [178, 208, 218]
};

// ---------- LOD 阶梯 ----------
// 全省 748.5 × 480 km。2m/格 = 898 亿格，任何机器都烤不出来，
// 所以基准比例只管"局部真实"，全省图按 LOD 降采样。
export const LOD = [
  { id: "L0", cellM: 2,    span: "374,250 × 240,000", note: "玩家尺度基准，流式加载，不烘焙" },
  { id: "L1", cellM: 8,    span: " 93,563 ×  60,000", note: "区域视图" },
  { id: "L2", cellM: 32,   span: " 23,391 ×  15,000", note: "县域" },
  { id: "L3", cellM: 128,  span: "  5,848 ×   3,750", note: "市域拼图" },
  { id: "L4", cellM: 500,  span: "  1,497 ×     960", note: "全省一张图（现有 hubei.bin）" }
];

// ---------- 工具 ----------
export function mix(a, b, k) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k)
  ];
}
export function shade(c, k) {
  return [
    Math.max(0, Math.min(255, Math.round(c[0] * k))),
    Math.max(0, Math.min(255, Math.round(c[1] * k))),
    Math.max(0, Math.min(255, Math.round(c[2] * k)))
  ];
}
