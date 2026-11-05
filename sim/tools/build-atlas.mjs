// 图集构建（零依赖：只用 node 内置 zlib）
//
// 一次构建产出 atlas.png + atlas.js，分成四个分区：
//   ① ground  行 0..3    地皮（原 tiles2.png，32 格）—— 位置固定，保证 tmj 的 gid 映射不变
//   ② props   行 4..8    道具/建筑（原 tiles.png，40 格）—— 同上
//   ③ deco    props 之后  多格装饰资源（从任意 CC0 源图按像素矩形裁剪，如 48×47 的水井）
//   ④ shore   最后        程序化派生的水岸过渡瓦片（16 邻接掩码 × 2 动画帧 = 32 格）
//
// 设计原则：
//   · ①② 的位置绝不能动，否则已导出的 Tiled 地图会整体错位；
//   · ③ 用清单（DECO）声明"从哪张源图的哪个像素矩形取什么名字"，以后加资源只改清单、不碰代码；
//   · ④ 不依赖源图里恰好有岸线瓦片，而是按"白泡沫边 + 浅蓝过渡 + 内侧压暗"的像素语言从水面瓦片派生，
//     保证与现有水色严格同源，永远不会出现贴图对不齐。
//
// 用法：node sim/tools/build-atlas.mjs [--verbose]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePNG, encodePNG, cropRGBA } from "./png-codec.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.dirname(HERE);
const VIEWER = path.join(SIM, "viewer");
const SRC = path.join(SIM, "assets", "_src");
const VERBOSE = process.argv.includes("--verbose");

const TILE = 16;
const COLS = 8;

// ---------- ③ 装饰资源清单 ----------
// 每项：name 语义名；src 源图相对 assets/_src 的路径；x,y,w,h 源图像素矩形（已用连通域+行直方图核过边界）
const DECO = [
  { name: "well", src: "zelda-like/gfx/Overworld.png", x: 352, y: 144, w: 48, h: 47, note: "石砌水井（3×3 格），村庄地标" }
];

// ---------- ④ 水岸派生参数 ----------
const SHORE_FOAM = [255, 255, 255];   // 泡沫主色
const SHORE_WAVE = 4;                 // 每 N 像素一个向内的小浪尖（像素画的经典节奏）
const SHORE_SHADE = 0.90;             // 内侧压暗系数（很轻，只用来分隔水面层次）

// 派生水岸瓦片。
// 像素语言：外圈 1px 实心泡沫 → 每 SHORE_WAVE 像素向内凸 1px 形成浪尖 → 浪尖下方再压暗一格。
// 之所以不画"均匀虚线"，是因为 16px 瓦片上一个虚点只有 1px，放大后会读成一圈机械的画框。
function makeShore(baseRGBA, mask, phase) {
  const out = Buffer.from(baseRGBA);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const i = (y * TILE + x) * 4;
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
  };
  const get = (x, y) => {
    const i = (y * TILE + x) * 4;
    return [out[i], out[i + 1], out[i + 2]];
  };
  const darken = (c, k) => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];

  const edges = [
    { bit: 1, at: (i) => [i, 0], in1: (i) => [i, 1], in2: (i) => [i, 2] },                  // 北
    { bit: 2, at: (i) => [TILE - 1, i], in1: (i) => [TILE - 2, i], in2: (i) => [TILE - 3, i] }, // 东
    { bit: 4, at: (i) => [i, TILE - 1], in1: (i) => [i, TILE - 2], in2: (i) => [i, TILE - 3] }, // 南
    { bit: 8, at: (i) => [0, i], in1: (i) => [1, i], in2: (i) => [2, i] }                    // 西
  ];

  for (const e of edges) {
    if (!(mask & e.bit)) continue;
    for (let i = 0; i < TILE; i++) {
      const [x, y] = e.at(i);
      set(x, y, SHORE_FOAM[0], SHORE_FOAM[1], SHORE_FOAM[2]);        // 外圈实心泡沫

      // 每 SHORE_WAVE 像素向内凸一格：浪尖
      const isCrest = ((i + phase) % SHORE_WAVE === 0);
      if (isCrest) {
        const [x1, y1] = e.in1(i);
        set(x1, y1, SHORE_FOAM[0], SHORE_FOAM[1], SHORE_FOAM[2]);
        const [x2, y2] = e.in2(i);
        const d = darken(get(x2, y2), SHORE_SHADE);
        set(x2, y2, d[0], d[1], d[2]);
      }
    }
  }

  // 两侧同时临陆 → 角落补泡沫，避免直角处出现断层
  if ((mask & 1) && (mask & 8)) set(0, 0, ...SHORE_FOAM);
  if ((mask & 1) && (mask & 2)) set(TILE - 1, 0, ...SHORE_FOAM);
  if ((mask & 4) && (mask & 8)) set(0, TILE - 1, ...SHORE_FOAM);
  if ((mask & 4) && (mask & 2)) set(TILE - 1, TILE - 1, ...SHORE_FOAM);

  return out;
}

// ============================================================
// 载入源图
// ============================================================
function loadTileset(jsFile) {
  const src = fs.readFileSync(jsFile, "utf8");
  const win = {};
  new Function("window", src)(win);
  return win[Object.keys(win)[0]];
}

const ts2 = loadTileset(path.join(VIEWER, "tiles2.js"));
const ts1 = loadTileset(path.join(VIEWER, "tiles.js"));
const img2 = decodePNG(path.join(VIEWER, "tiles2.png"));
const img1 = decodePNG(path.join(VIEWER, "tiles.png"));

const rows2 = Math.ceil(img2.h / TILE);
const rows1 = Math.ceil(img1.h / TILE);
const groundCells = rows2 * COLS;

// ============================================================
// 派生：水岸瓦片
// ============================================================
// mask 位：1=北有陆地 2=东 4=南 8=西

// 取 tiles2.png（或任意图集图）里某一格的像素
function tileAt(img, cellIndex, cols = COLS) {
  const cx = cellIndex % cols, cy = Math.floor(cellIndex / cols);
  return cropRGBA(img, cx * TILE, cy * TILE, TILE, TILE).rgba;
}

const waterCellA = ts2.idx.water_a;
const waterCellB = ts2.idx.water_b;
if (waterCellA == null || waterCellB == null) throw new Error("tiles2.js 缺少 water_a / water_b");
const waterRGBA = [tileAt(img2, waterCellA), tileAt(img2, waterCellB)];

// 32 格：帧 × 掩码
const shoreTiles = [];
for (let frame = 0; frame < 2; frame++) {
  for (let mask = 0; mask < 16; mask++) {
    shoreTiles.push(makeShore(waterRGBA[frame], mask, frame));
  }
}

// ============================================================
// 布局：①② 原样拼接 → ③ 货架式装箱 → ④ 8 列网格
// ============================================================
const decoImgs = DECO.map((d) => {
  const f = path.join(SRC, d.src);
  if (!fs.existsSync(f)) throw new Error("装饰源图缺失: " + f);
  return cropRGBA(decodePNG(f), d.x, d.y, d.w, d.h);
});

// ③ 装箱
const decoPlace = [];
let shelfX = 0, shelfY = rows2 + rows1, shelfH = 0;
for (let i = 0; i < DECO.length; i++) {
  const colsNeeded = Math.ceil(DECO[i].w / TILE);
  const rowsNeeded = Math.ceil(DECO[i].h / TILE);
  if (shelfX + colsNeeded > COLS) {          // 换行
    shelfX = 0;
    shelfY += shelfH;
    shelfH = 0;
  }
  decoPlace.push({ x: shelfX * TILE, y: shelfY * TILE, w: DECO[i].w, h: DECO[i].h });
  shelfX += colsNeeded;
  shelfH = Math.max(shelfH, rowsNeeded);
}
const decoEndRow = shelfY + shelfH;

// ④ 水岸块：8 列排布
const shoreRows = Math.ceil(shoreTiles.length / COLS);
const shoreTopRow = decoEndRow;

const W = COLS * TILE;
const H = (shoreTopRow + shoreRows) * TILE;
const out = Buffer.alloc(W * H * 4);

// 通用：把一块 RGBA 贴到图集像素坐标
function paste(src, dx, dy) {
  for (let y = 0; y < src.h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= H) continue;
    src.rgba.copy(out, (ty * W + dx) * 4, y * src.w * 4, y * src.w * 4 + src.w * 4);
  }
}

// ①② 原逻辑：整图纵向拼接（保持与旧版逐字节一致）
for (let y = 0; y < img2.h; y++) {
  img2.rgba.copy(out, ((y + 0) * W) * 4, y * img2.w * 4, y * img2.w * 4 + img2.w * 4);
}
for (let y = 0; y < img1.h; y++) {
  img1.rgba.copy(out, ((y + rows2 * TILE) * W) * 4, y * img1.w * 4, y * img1.w * 4 + img1.w * 4);
}

// ③ 装饰
DECO.forEach((d, i) => paste(decoImgs[i], decoPlace[i].x, decoPlace[i].y));

// ④ 水岸
shoreTiles.forEach((rgba, i) => {
  const cx = (i % COLS) * TILE;
  const cy = (shoreTopRow + Math.floor(i / COLS)) * TILE;
  for (let y = 0; y < TILE; y++) {
    rgba.copy(out, ((cy + y) * W + cx) * 4, y * TILE * 4, y * TILE * 4 + TILE * 4);
  }
});

// ============================================================
// 写出 + 回读校验
// ============================================================
const png = encodePNG(W, H, out);
fs.writeFileSync(path.join(VIEWER, "atlas.png"), png);

const back = decodePNG(path.join(VIEWER, "atlas.png"));
if (back.w !== W || back.h !== H) throw new Error("回读尺寸不符");
if (!back.rgba.equals(out)) throw new Error("回读像素不一致：编码器有误");

// 校验：①② 区必须与旧图集逐字节相同（防止误改导致地图错位）
const legacy = Buffer.alloc(W * rows2 * TILE * 4);
for (let y = 0; y < rows2 * TILE; y++) {
  img2.rgba.copy(legacy, y * W * 4, y * img2.w * 4, y * img2.w * 4 + img2.w * 4);
}
for (let y = 0; y < rows2 * TILE; y++) {
  if (!back.rgba.subarray(y * W * 4, (y + 1) * W * 4).equals(legacy.subarray(y * W * 4, (y + 1) * W * 4))) {
    throw new Error("地皮区像素被改动（第 " + y + " 行）：gid 映射会错位");
  }
}

// ============================================================
// 生成 atlas.js
// ============================================================
const idxObj = (o) => "{" + Object.entries(o).map(([k, v]) => JSON.stringify(k) + ": " + v).join(", ") + "}";
const decoObj = "{" + DECO.map((d, i) =>
  JSON.stringify(d.name) + ": { x: " + decoPlace[i].x + ", y: " + decoPlace[i].y + ", w: " + d.w + ", h: " + d.h + " }"
).join(", ") + "}";

const js = `// 自动生成，勿手改：sim/tools/build-atlas.mjs
// 素材：tiles2.png + tiles.png（Kenney CC0）+ ${DECO.map((d) => d.src).filter((v, i, a) => a.indexOf(v) === i).join(" + ")}
// 分区：行 0..${rows2 - 1} 地皮 / 行 ${rows2}..${rows2 + rows1 - 1} 道具 / 行 ${decoEndRow - Math.max(1, shelfH)} 起为装饰 / 行 ${shoreTopRow}..${shoreTopRow + shoreRows - 1} 为水岸
// 说明：①② 位置固定（Tiled gid 依赖它）；③④ 只在末尾追加，永远不影响已有映射。
window.ATLAS = {
  img: "/viewer/atlas.png",
  size: ${TILE}, cols: ${COLS}, rows: ${shoreTopRow + shoreRows},

  // 地皮命名索引（atlas 格 = 本表值，对应 Tiled gid = 值 + 1）
  ground: ${idxObj(ts2.idx)},

  // 道具/建筑命名索引（atlas 格 = ${groundCells} + 本表值）
  props: ${idxObj(ts1.idx)},

  PROP_BASE: ${groundCells},

  // ③ 装饰资源：像素矩形（支持多格精灵，渲染层用 frame 直接切）
  deco: ${decoObj},

  // ④ 水岸过渡：mask 位 1=北 2=东 4=南 8=西 为"陆地"；共 16 掩码 × 2 帧
  shore: {
    cell: ${TILE},
    count: ${shoreTiles.length},
    rect: function (mask, frame) {
      var i = (frame ? 1 : 0) * 16 + (mask & 15);
      return {
        x: (i % ${COLS}) * ${TILE},
        y: ${shoreTopRow * TILE} + Math.floor(i / ${COLS}) * ${TILE},
        width: ${TILE}, height: ${TILE}
      };
    }
  },

  /** Tiled gid → atlas 格（0 表示空） */
  idxOfGid: function (gid) {
    if (!gid) return -1;
    return gid <= ${groundCells} ? gid - 1 : (this.PROP_BASE + (gid - ${groundCells + 1}));
  },

  /** 道具表索引（tiles.js 语义）→ atlas 格 */
  idxOfProp: function (i) { return this.PROP_BASE + i; }
};
`;
fs.writeFileSync(path.join(VIEWER, "atlas.js"), js, "utf8");

console.log("atlas.png " + W + "x" + H + " (" + Math.round(png.length / 1024) + "KB)");
console.log("地皮 " + groundCells + " 格 / 道具 " + rows1 * COLS + " 格 / 装饰 " + DECO.length + " 项 / 水岸 " + shoreTiles.length + " 格");
console.log("回读校验通过；地皮区逐字节未变");
if (VERBOSE) {
  DECO.forEach((d, i) => console.log("  deco " + d.name + " → atlas(" + decoPlace[i].x + "," + decoPlace[i].y + ") " + d.w + "x" + d.h));
  console.log("  shore 块起始行 " + shoreTopRow + "（" + shoreRows + " 行）");
}
