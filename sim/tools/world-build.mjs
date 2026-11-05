#!/usr/bin/env node
// ============================================================
// world-build.mjs —— 真实比例省级世界地图构建器（纯 Node，零第三方依赖）
//
// 输入：
//   sim/assets/geo/hubei-boundary.json   湖北省行政边界（阿里云 DataV GeoAtlas，官方审图数据）
// 输出：
//   sim/maps/hubei.bin                   群系网格（1 字节/格，行优先）
//   sim/maps/hubei.json                  元数据（投影参数、图例、城市锚点、统计）
//   sim/viewer/world-preview.png         1px/格 全图预览（小地图与快速审图用）
//
// 设计要点：
//   · 真实比例：局部等距圆柱投影，1 格 = 0.5 km，经纬度按 31°N 处的实际公里数换算
//   · 省界用扫描线栅格化（逐行求边交点，奇偶填充），不做逐格点在多边形内测试
//   · 地形用「山脉多边形 + 内部距离衰减 + 值噪声」生成高程，再按高程分群系
//   · 江河湖泊按公开地理坐标编码折线/椭圆，宽度取真实量级（长江 1.6km = 3 格）
//
// 用法：
//   node sim/tools/world-build.mjs            构建
//   node sim/tools/world-build.mjs --stats    额外打印群系统计
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePNG } from "./png-codec.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.resolve(HERE, "..");
const SRC_GEO = path.join(SIM, "assets", "geo", "hubei-boundary.json");
const OUT_BIN = path.join(SIM, "maps", "hubei.bin");
const OUT_META = path.join(SIM, "maps", "hubei.json");
const OUT_PNG = path.join(SIM, "viewer", "world-preview.png");
const OUT_ELEV = path.join(SIM, "maps", "hubei.elev.bin");
const OUT_ELEV16 = path.join(SIM, "maps", "hubei.elev16.bin");
const OUT_MACRO = path.join(SIM, "maps", "hubei.macro.bin");

const TILE_KM = 0.5;          // 1 格 = 0.5 km
const PAD = 8;                // 四周留白（格）

// ---------- 群系码 ----------
const B = {
  VOID: 0,      // 省界之外（未探索）
  LAKE: 1,      // 湖泊 / 水库
  RIVER: 2,     // 干流（长江、汉江）
  PLAIN: 3,     // 平原农田
  FOREST: 4,    // 丘陵林地
  MOUNTAIN: 5,  // 山地
  HIGH: 6,      // 高山
  SNOW: 7       // 雪线以上（神农顶一带）
};
const BNAME = ["省界外", "湖泊", "干流", "平原", "林地", "山地", "高山", "雪线"];
const PALETTE = [
  [36, 42, 40], [62, 116, 182], [52, 104, 172],
  [116, 172, 92], [62, 116, 72], [104, 112, 88], [150, 154, 142], [228, 231, 235]
];

// ---------- 投影（局部等距圆柱，31°N 处的真实公里数）----------
const PHI0 = 31.15 * Math.PI / 180;
const KM_LNG = 111.320 * Math.cos(PHI0);   // 1° 经度 ≈ 95.25 km
const KM_LAT = 111.132;                    // 1° 纬度 ≈ 111.13 km

// ---------- 公开地理要素编码 ----------
// 河流：折线 + 真实宽度（km）
const RIVERS = [
  { name: "长江", w: 1.6, pts: [
    [110.06, 31.05], [110.42, 31.00], [110.90, 30.83], [111.30, 30.70],
    [111.58, 30.58], [111.80, 30.45], [112.15, 30.33], [112.40, 30.05],
    [112.62, 29.86], [113.10, 29.85], [113.58, 29.90], [113.95, 30.00],
    [114.20, 30.45], [114.32, 30.62], [114.55, 30.55], [114.85, 30.42],
    [115.05, 30.25], [115.35, 30.10], [115.62, 29.94]
  ]},
  { name: "汉江", w: 0.9, pts: [
    [110.45, 32.85], [110.75, 32.72], [111.20, 32.60], [111.50, 32.55],
    [111.70, 32.40], [112.10, 32.05], [112.25, 31.85], [112.40, 31.50],
    [112.55, 31.20], [112.75, 30.90], [112.90, 30.60], [113.20, 30.55],
    [113.60, 30.58], [114.10, 30.60], [114.27, 30.61]
  ]},
  { name: "清江", w: 0.5, pts: [
    [109.45, 30.30], [109.75, 30.28], [110.05, 30.35], [110.45, 30.45],
    [110.95, 30.50], [111.45, 30.42]
  ]},
  { name: "沮漳河", w: 0.4, pts: [[111.05, 31.35], [111.35, 31.05], [111.62, 30.72], [111.78, 30.44]] },
];

// 湖泊 / 水库：中心 + 半轴（km）
const LAKES = [
  { name: "洪湖", c: [113.35, 29.85], r: [13.0, 5.0] },
  { name: "梁子湖", c: [114.55, 30.33], r: [11.0, 7.0] },
  { name: "长湖", c: [112.55, 30.42], r: [9.5, 4.0] },
  { name: "斧头湖", c: [114.08, 29.98], r: [6.0, 4.5] },
  { name: "大冶湖", c: [115.10, 30.02], r: [6.0, 2.4] },
  { name: "保安湖", c: [114.75, 30.06], r: [4.2, 2.8] },
  { name: "丹江口水库", c: [111.38, 32.62], r: [11.0, 4.5] },
  { name: "漳河水库", c: [111.95, 30.95], r: [5.5, 3.6] },
  { name: "白莲河水库", c: [115.55, 30.75], r: [5.5, 3.2] },
  { name: "富水水库", c: [115.05, 29.75], r: [4.8, 2.8] },
  { name: "陆水水库", c: [113.85, 29.66], r: [4.2, 2.6] },
  { name: "东湖", c: [114.39, 30.55], r: [3.6, 2.6] }
];

// 山脉：山脊线 + 主峰高程（m）+ 山体半宽（km）。
// 用「脊线距离 → 高斯衰减」而不是「多边形平顶」——山脉是脊状隆起，
// 平顶模型会把整片区域抬到主峰高度（第一版就踩了这个坑：高山面积反超山地）。
const RIDGES = [
  { name: "大巴山", peak: 1300, width: 19, pts: [[108.60, 32.10], [109.20, 32.20], [109.90, 32.35], [110.60, 32.50], [111.20, 32.62]] },
  { name: "神农架", peak: 1850, width: 15, pts: [[110.10, 31.20], [110.40, 31.38], [110.68, 31.45], [110.95, 31.35], [111.20, 31.15]] },
  { name: "武陵山", peak: 1350, width: 21, pts: [[108.60, 29.75], [109.20, 29.80], [109.75, 30.00], [110.15, 30.30], [110.30, 30.65]] },
  { name: "巫山", peak: 1300, width: 11, pts: [[110.05, 30.85], [110.25, 31.05], [110.40, 31.25]] },
  { name: "荆山", peak: 1050, width: 13, pts: [[110.95, 31.30], [111.45, 31.35], [111.85, 31.15]] },
  { name: "桐柏山", peak: 800, width: 10, pts: [[112.95, 32.28], [113.45, 32.38], [113.85, 32.35]] },
  { name: "大别山", peak: 1150, width: 15, pts: [[114.85, 30.95], [115.30, 31.15], [115.75, 31.35], [116.10, 31.42]] },
  { name: "幕阜山", peak: 950, width: 13, pts: [[113.80, 29.25], [114.20, 29.18], [114.55, 29.32], [114.68, 29.55]] },
  { name: "大洪山", peak: 700, width: 12, pts: [[112.60, 31.55], [113.00, 31.45], [113.30, 31.30]] }
];

// 城市锚点（后续村落落位用；本阶段只进元数据，不绘制）
const CITIES = [
  ["武汉", 114.31, 30.59], ["黄石", 115.04, 30.20], ["十堰", 110.80, 32.63],
  ["宜昌", 111.29, 30.69], ["襄阳", 112.12, 32.01], ["鄂州", 114.89, 30.39],
  ["荆门", 112.20, 31.04], ["孝感", 113.92, 30.92], ["荆州", 112.24, 30.33],
  ["黄冈", 114.87, 30.45], ["咸宁", 114.32, 29.84], ["随州", 113.37, 31.69],
  ["恩施", 109.49, 30.27], ["仙桃", 113.44, 30.36], ["潜江", 112.90, 30.40],
  ["天门", 113.17, 30.66], ["神农架", 110.68, 31.74]
];

// ---------- 噪声 ----------
function h2(x, y) {
  let n = (x | 0) * 374761393 + (y | 0) * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}
const smooth = (t) => t * t * (3 - 2 * t);
function noise2(x, y) {           // 值噪声，双线性 + 平滑
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smooth(x - xi), ty = smooth(y - yi);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
function fbm(x, y) { return noise2(x, y) * 0.6 + noise2(x * 2.1 + 7.3, y * 2.1 + 3.7) * 0.3 + noise2(x * 4.3 + 1.9, y * 4.3 + 8.1) * 0.1; }

// ---------- 读取边界 ----------
if (!fs.existsSync(SRC_GEO)) {
  console.error(`缺少边界数据：${SRC_GEO}`);
  console.error("下载：curl -o sim/assets/geo/hubei-boundary.json https://geo.datav.aliyun.com/areas_v3/bound/420000.json");
  process.exit(1);
}
const geo = JSON.parse(fs.readFileSync(SRC_GEO, "utf8"));
const feature = geo.features ? geo.features[0] : geo;
const geom = feature.geometry;
const polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];

// bbox
let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
(function walk(c) {
  if (typeof c[0] === "number") {
    if (c[0] < minLng) minLng = c[0];
    if (c[0] > maxLng) maxLng = c[0];
    if (c[1] < minLat) minLat = c[1];
    if (c[1] > maxLat) maxLat = c[1];
    return;
  }
  for (const k of c) walk(k);
})(geom.coordinates);

const LNG0 = minLng - PAD * TILE_KM / KM_LNG;
const LAT1 = maxLat + PAD * TILE_KM / KM_LAT;
const W = Math.ceil((maxLng - minLng) * KM_LNG / TILE_KM) + PAD * 2;
const H = Math.ceil((maxLat - minLat) * KM_LAT / TILE_KM) + PAD * 2;

const xOf = (lng) => (lng - LNG0) * KM_LNG / TILE_KM;
const yOf = (lat) => (LAT1 - lat) * KM_LAT / TILE_KM;

// ---------- ① 扫描线栅格化省界（奇偶填充，逐多边形取并集）----------
const land = new Uint8Array(W * H);
let ringCount = 0, edgeCount = 0;

for (const poly of polys) {
  // 该多边形的所有环（外环 + 洞）先求纵向范围，减少无效行
  const rings = poly.map((ring) => ring.map(([lng, lat]) => [xOf(lng), yOf(lat)]));
  ringCount += rings.length;
  let yTop = Infinity, yBot = -Infinity;
  for (const r of rings) for (const p of r) { if (p[1] < yTop) yTop = p[1]; if (p[1] > yBot) yBot = p[1]; }

  const y0 = Math.max(0, Math.floor(yTop) - 1), y1 = Math.min(H - 1, Math.ceil(yBot) + 1);
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (const r of rings) {
      for (let i = 0, n = r.length; i < n; i++) {
        const a = r[i], b = r[(i + 1) % n];
        edgeCount++;
        // 半开区间判交，保证顶点只计一次
        if ((a[1] <= yc) === (b[1] <= yc)) continue;
        const t = (yc - a[1]) / (b[1] - a[1]);
        xs.push(a[0] + t * (b[0] - a[0]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const lo = Math.max(0, Math.ceil(xs[k] - 0.5));
      const hi = Math.min(W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let x = lo; x <= hi; x++) land[y * W + x] = 1;
    }
  }
}

// ---------- ② 高程场（山脉内部距离衰减 + 噪声）----------
const elev = new Float32Array(W * H);

function distToPolyEdge(px, py, pts) {
  let best = Infinity;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const wx = px - a[0], wy = py - a[1];
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - t * vx, dy = wy - t * vy;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 区域基准高程：控制点反距离加权（IDW）。
// 只靠山脊高斯会漏掉大片低山丘陵（鄂东北、鄂东南），平原占比会虚高到 74%，
// 与湖北"七山一水两分田"的实际地貌不符，因此先铺一层宏观地势。
const CONTROL = [
  [113.00, 30.40, 28], [114.30, 30.60, 25], [112.20, 30.30, 32], [113.90, 31.00, 45],
  [112.10, 32.00, 90], [113.40, 31.70, 120], [112.20, 31.00, 80], [111.30, 30.70, 120],
  [109.50, 30.30, 520], [110.80, 32.60, 350], [110.70, 31.50, 620], [114.90, 30.50, 90],
  [115.00, 30.20, 80], [114.30, 29.80, 120], [114.40, 29.30, 400], [115.20, 31.20, 300],
  [111.20, 31.70, 470], [110.60, 30.20, 640], [109.70, 32.20, 520], [112.80, 32.20, 130],
  [115.80, 31.00, 250], [111.60, 29.90, 300]
];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = y * W + x;
    if (!land[idx]) continue;
    const lng = LNG0 + (x + 0.5) * TILE_KM / KM_LNG;
    const lat = LAT1 - (y + 0.5) * TILE_KM / KM_LAT;
    let num = 0, den = 0;
    for (const [clng, clat, ce] of CONTROL) {
      const dx = (lng - clng) * KM_LNG, dy = (lat - clat) * KM_LAT;
      const d2 = dx * dx + dy * dy + 1e-6;
      const wgt = 1 / (d2 * d2);              // 4 次幂：近处主导，远处平滑过渡
      num += ce * wgt; den += wgt;
    }
    elev[idx] = num / den + fbm(x / 90, y / 90) * 40;
  }
}

// 山脊：逐条脊线做高斯衰减，取各山体最大值叠加
function distToPolyline(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const wx = px - a[0], wy = py - a[1];
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - t * vx, dy = wy - t * vy;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

for (const rg of RIDGES) {
  const pts = rg.pts.map(([lng, lat]) => [xOf(lng), yOf(lat)]);
  const reach = rg.width * 2.6 / TILE_KM;        // 2.6σ 截断，再远衰减已 <0.1%
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [px, py] of pts) {
    if (px < x0) x0 = px; if (px > x1) x1 = px;
    if (py < y0) y0 = py; if (py > y1) y1 = py;
  }
  const ix0 = Math.max(0, Math.floor(x0 - reach)), ix1 = Math.min(W - 1, Math.ceil(x1 + reach));
  const iy0 = Math.max(0, Math.floor(y0 - reach)), iy1 = Math.min(H - 1, Math.ceil(y1 + reach));
  for (let y = iy0; y <= iy1; y++) {
    for (let x = ix0; x <= ix1; x++) {
      const idx = y * W + x;
      if (!land[idx]) continue;
      const dKm = distToPolyline(x + 0.5, y + 0.5, pts) * TILE_KM;
      if (dKm > rg.width * 2.6) continue;
      // 脊线本身有起伏（山峰/垭口），用沿脊噪声调制再乘横向高斯，叠加到基准地势上
      const along = fbm(x / 55, y / 55) * 0.35 + 0.72;
      elev[idx] += rg.peak * along * Math.exp(-((dKm / rg.width) ** 2));
    }
  }
}

// 宏观高程存档：后面的粗糙度是给 1px/格 山体阴影用的（±280 m、4.5 km 波长），
// 局部 2m/格 的层带渲染如果直接读它，会在 320 m 窗口里堆出几百米的假高差。
const macroElev = Float32Array.from(elev);

// 粗糙度：高频噪声按高程加权——低地近乎平坦，山地出现碎石/沟谷质感。
// 没有这一层，山体会是光滑的高斯色带，一眼看出是算出来的。
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = y * W + x;
    if (!land[idx]) continue;
    const rug = Math.min(1, elev[idx] / 900);
    elev[idx] += (fbm(x / 9 + 3.3, y / 9 + 7.7) - 0.5) * 560 * rug
               + (fbm(x / 3.1 + 1.1, y / 3.1 + 5.5) - 0.5) * 110 * rug;
  }
}

// ---------- ③ 群系分类 ----------
const grid = new Uint8Array(W * H);
let maxElev = 0, maxAt = -1;
for (let i = 0; i < grid.length; i++) {
  if (!land[i]) { grid[i] = B.VOID; continue; }
  const e = elev[i];
  if (e > maxElev) { maxElev = e; maxAt = i; }
  if (e >= 2450) grid[i] = B.SNOW;
  else if (e >= 1050) grid[i] = B.HIGH;
  else if (e >= 450) grid[i] = B.MOUNTAIN;
  else if (e >= 120) grid[i] = B.FOREST;
  else {
    // 平原里掺少量林地斑块，避免一大片死平
    grid[i] = fbm(i % W / 34 + 11.3, Math.floor(i / W) / 34 + 5.1) > 0.74 ? B.FOREST : B.PLAIN;
  }
}

// ---------- ④ 水系覆盖（湖泊 → 干流 → 支流）----------
let lakeCells = 0, riverCells = 0;

for (const lk of LAKES) {
  const cx = xOf(lk.c[0]), cy = yOf(lk.c[1]);
  const rx = lk.r[0] / TILE_KM, ry = lk.r[1] / TILE_KM;
  // 湖岸不规则化：半径乘噪声
  const gx0 = Math.max(0, Math.floor(cx - rx - 2)), gx1 = Math.min(W - 1, Math.ceil(cx + rx + 2));
  const gy0 = Math.max(0, Math.floor(cy - ry - 2)), gy1 = Math.min(H - 1, Math.ceil(cy + ry + 2));
  for (let y = gy0; y <= gy1; y++) {
    for (let x = gx0; x <= gx1; x++) {
      const idx = y * W + x;
      if (!land[idx]) continue;
      const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
      // 两级扰动：粗粒度让湖岸有大凹凸，细粒度补碎边；单级只会得到"毛边椭圆"
      const wobble = 0.80 + fbm(x / 11, y / 11) * 0.34 + (fbm(x / 3.5 + 7.1, y / 3.5 + 2.3) - 0.5) * 0.16;
      if (nx * nx + ny * ny <= wobble * wobble) { grid[idx] = B.LAKE; lakeCells++; }
    }
  }
}

// 折线细分 + 法线噪声偏移：真实河道没有直线段，纯折线一眼假
function meander(pts, ampCells) {
  const out = [];
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 0.001;
    const n = Math.max(2, Math.ceil(len * TILE_KM / 2));   // 每 2 km 一个采样点
    const nx = -dy / len, ny = dx / len;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const sd = s + t * len;
      // 双频：低频给大弯（~50km 波长）、高频给小摆（~11km），
      // 单频在 600km 长的汉江上会退化成一条直线。
      const off = (fbm(sd * 0.019, 11.7) - 0.5) * 2 * ampCells * 1.8
                + (fbm(sd * 0.085, 3.9) - 0.5) * 2 * ampCells * 0.55;
      out.push([a[0] + dx * t + nx * off, a[1] + dy * t + ny * off]);
    }
    s += len;
  }
  out.push(pts[pts.length - 1]);
  return out;
}

for (const rv of RIVERS) {
  const pts = meander(rv.pts.map(([lng, lat]) => [xOf(lng), yOf(lat)]), Math.min(9, rv.w / TILE_KM * 4.2));
  const halfW = Math.max(0.5, rv.w / TILE_KM / 2);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const bx0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - halfW - 2));
    const bx1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0]) + halfW + 2));
    const by0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - halfW - 2));
    const by1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1]) + halfW + 2));
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy || 1;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const idx = y * W + x;
        if (grid[idx] === B.VOID) continue;
        const wx = x + 0.5 - a[0], wy = y + 0.5 - a[1];
        let t = (wx * vx + wy * vy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = wx - t * vx, dy = wy - t * vy;
        if (dx * dx + dy * dy <= halfW * halfW) {
          if (grid[idx] !== B.RIVER) riverCells++;
          grid[idx] = B.RIVER;
        }
      }
    }
  }
}

// ---------- ⑤ 输出 ----------
fs.mkdirSync(path.dirname(OUT_BIN), { recursive: true });
fs.writeFileSync(OUT_BIN, Buffer.from(grid.buffer));

// 高程通道：12m / 单位，Uint8（0 保留给省界外）。
// 只有群系码时，大面积山地只能靠随机噪点表现，视觉上永远是平涂；
// 把高程单独发出去，渲染层就能做真正的山体阴影（hillshade）。
const ELEV_UNIT = 12;
const elevU8 = new Uint8Array(W * H);
for (let i = 0; i < elevU8.length; i++) {
  if (!land[i]) { elevU8[i] = 0; continue; }
  elevU8[i] = Math.min(255, Math.max(1, Math.round(elev[i] / ELEV_UNIT)));
}
fs.writeFileSync(OUT_ELEV, Buffer.from(elevU8.buffer));

// 高程通道（高精度）：2m / 单位，Uint16LE（0 保留给省界外）。
// 8bit/12m 只有 256 级，低于 36m 的层带会被整段跳过（12→24→36 之间没有 26/30），
// 分带渲染时会出现"空层"。世界图本身用不到这个精度，但 2m/格 的局部层带必须是连续的。
const ELEV16_UNIT = 2;
const elevU16 = new Uint16Array(W * H);
for (let i = 0; i < elevU16.length; i++) {
  if (!land[i]) { elevU16[i] = 0; continue; }
  elevU16[i] = Math.min(65535, Math.max(1, Math.round(elev[i] / ELEV16_UNIT)));
}
fs.writeFileSync(OUT_ELEV16, Buffer.from(elevU16.buffer));

// 宏观高程通道：2m / 单位，不含粗糙度
const macroU16 = new Uint16Array(W * H);
for (let i = 0; i < macroU16.length; i++) {
  if (!land[i]) { macroU16[i] = 0; continue; }
  macroU16[i] = Math.min(65535, Math.max(1, Math.round(macroElev[i] / ELEV16_UNIT)));
}
fs.writeFileSync(OUT_MACRO, Buffer.from(macroU16.buffer));

const stat = new Array(8).fill(0);
for (let i = 0; i < grid.length; i++) stat[grid[i]]++;

const meta = {
  name: "湖北省",
  source: "阿里云 DataV GeoAtlas（行政边界，官方审图数据）+ 公开地理要素编码",
  projection: "local-equirectangular",
  tileKm: TILE_KM,
  w: W, h: H,
  lng0: LNG0, lat1: LAT1, kmPerDegLng: KM_LNG, kmPerDegLat: KM_LAT,
  spanKm: { x: +(W * TILE_KM).toFixed(1), y: +(H * TILE_KM).toFixed(1) },
  biome: Object.fromEntries(Object.entries(B).map(([k, v]) => [v, k])),
  elevFile: "hubei.elev.bin",
  elevUnit: ELEV_UNIT,
  elev16File: "hubei.elev16.bin",
  elev16Unit: 2,
  macroFile: "hubei.macro.bin",
  maxElev: Math.round(maxElev),
  palette: PALETTE,
  cities: CITIES.map(([n, lng, lat]) => ({ name: n, lng, lat, x: +(xOf(lng)).toFixed(1), y: +(yOf(lat)).toFixed(1) })),
  stats: { cells: W * H, land: stat.slice(3).reduce((a, b) => a + b, 0), byBiome: stat }
};
fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2));

// 预览 PNG：1px / 格
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < grid.length; i++) {
  const c = PALETTE[grid[i]] || PALETTE[0];
  const v = (h2(i % W, Math.floor(i / W)) - 0.5) * 14;
  rgba[i * 4] = Math.max(0, Math.min(255, c[0] + v));
  rgba[i * 4 + 1] = Math.max(0, Math.min(255, c[1] + v));
  rgba[i * 4 + 2] = Math.max(0, Math.min(255, c[2] + v));
  rgba[i * 4 + 3] = 255;
}
fs.writeFileSync(OUT_PNG, encodePNG(W, H, rgba));

// ---------- 报告 ----------
const km2 = (n) => (n * TILE_KM * TILE_KM).toLocaleString("zh-CN", { maximumFractionDigits: 0 }) + " km²";
console.log(`湖北省世界图构建完成`);
console.log(`  网格      ${W} × ${H} 格（${meta.spanKm.x} × ${meta.spanKm.y} km，1 格 = ${TILE_KM} km）`);
console.log(`  省界      ${polys.length} 个多边形 / ${ringCount} 个环 / ${edgeCount} 条边`);
console.log(`  陆地面积  ${km2(meta.stats.land)}（官方 18.59 万 km²）`);
for (let c = 0; c < 8; c++) {
  if (!stat[c]) continue;
  console.log(`  ${BNAME[c].padEnd(5, "　")} ${String(stat[c]).padStart(8)} 格  ${(stat[c] / grid.length * 100).toFixed(1).padStart(5)}%`);
}
console.log(`  最高点    ${Math.round(maxElev)} m（格 ${maxAt % W}, ${Math.floor(maxAt / W)}）`);
console.log(`  湖泊 ${lakeCells} 格 / 干流 ${riverCells} 格`);
console.log(`  产物      ${path.relative(SIM, OUT_BIN)} (${(fs.statSync(OUT_BIN).size / 1048576).toFixed(2)} MB)`);
console.log(`            ${path.relative(SIM, OUT_META)}`);
console.log(`            ${path.relative(SIM, OUT_PNG)} (${W}×${H})`);
console.log(`            ${path.relative(SIM, OUT_ELEV)} (${(fs.statSync(OUT_ELEV).size / 1048576).toFixed(2)} MB, 12m/单位)`);
console.log(`            ${path.relative(SIM, OUT_ELEV16)} (${(fs.statSync(OUT_ELEV16).size / 1048576).toFixed(2)} MB, 2m/单位)`);
console.log(`            ${path.relative(SIM, OUT_MACRO)} (${(fs.statSync(OUT_MACRO).size / 1048576).toFixed(2)} MB, 宏观高程)`);
