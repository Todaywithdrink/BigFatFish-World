// 生成 sim/data/village.json —— 一个可复现的小镇（确定性，无随机种子漂移）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const W = 64, H = 64;
const NOTE = ".".repeat(W).split("");
const grid = Array.from({ length: H }, () => NOTE.slice());
const heights = Array.from({ length: H }, () => Array(W).fill(0));

const put = (x, y, ch) => { if (x >= 0 && y >= 0 && x < W && y < H) grid[y][x] = ch; };
const rect = (x0, y0, x1, y1, ch) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, ch); };
const heightRect = (x0, y0, x1, y1, h) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (heights[y] && x >= 0 && y >= 0 && x < W && y < H) heights[y][x] = h; };

// 1) 林地边界
rect(0, 0, W - 1, 1, "T");
rect(0, H - 2, W - 1, H - 1, "T");
rect(0, 0, 1, H - 1, "T");
rect(W - 2, 0, W - 1, H - 1, "T");

// 2) 主路：十字
rect(10, 35, 54, 37, ",");
rect(31, 12, 33, 52, ",");

// 3) 广场
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = x - 32, dy = y - 36;
  if (dx * dx + dy * dy <= 36) put(x, y, ",");
}

// 3.5) 池塘（先画，房子会覆盖它）
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = (x - 12) / 5, dy = (y - 54) / 3.5;
  if (dx * dx + dy * dy <= 1) put(x, y, "W");
}

// 3.5) 留言板：广场西南角
put(29, 39, "N");

// 3.6) 广场中心的喷泉（3x3 石台 + 中间水）
put(32, 36, "W");
put(31, 36, "O"); put(33, 36, "O");
put(32, 35, "O"); put(32, 37, "O");
put(31, 35, "O"); put(33, 35, "O"); put(31, 37, "O"); put(33, 37, "O");

// 3.7) 路灯：沿主路两侧
for (const x of [20, 26, 38, 44]) { put(x, 34, "L"); put(x, 38, "L"); }
for (const y of [20, 26, 46, 52]) { put(30, y, "L"); put(34, y, "L"); }

// 3.8) 长椅：广场两侧
put(28, 33, "B"); put(28, 34, "B");
put(36, 39, "B"); put(36, 40, "B");

// 3.9) 栈桥：从东岸伸进池塘
for (let x = 14; x <= 19; x++) put(x, 53, "P");
put(19, 52, "P"); put(19, 54, "P");

// 3.95) 零散的花
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
for (let y = 4; y < H - 4; y++) {
  for (let x = 4; x < W - 4; x++) {
    if (grid[y][x] !== ".") continue;
    if (hash2(x, y) > 0.955) put(x, y, "x");
  }
}

// 4) 房子：7 宽 6 高，南墙开门
// 只有 3 栋房子；以后要住人得自己拿木头盖
const houses = [
  { x: 14, y: 20 }, { x: 24, y: 44 }, { x: 44, y: 20 }
];
const homes = [];
for (const h of houses) {
  const { x, y } = h;
  rect(x, y, x + 6, y + 5, "#");          // 外墙
  rect(x + 1, y + 1, x + 5, y + 4, "f");  // 地板
  put(x + 3, y + 5, "D");                 // 门
  put(x + 1, y + 1, "b");                 // 床
  put(x + 5, y + 1, "s");                 // 灶
  homes.push({ x: x + 3, y: y + 6 });     // 门口
}

// 6) 北边的小山（高 2），西侧一条坡道
heightRect(40, 6, 53, 16, 2);
for (let y = 6; y <= 16; y++) heights[y][40] = 1;     // 坡道
rect(40, 6, 53, 16, ".");
put(47, 10, "R");   // 山顶一块石头
put(50, 12, "R");

// 7) 悬崖：小山南沿直接掉回地面（height 2 -> 0），留给摔倒
for (let x = 41; x <= 52; x++) heights[17][x] = 0;

// 8) 零散树
const trees = [[8, 12], [9, 30], [20, 55], [38, 55], [52, 30], [55, 12], [12, 8], [30, 6], [50, 40], [8, 40], [36, 48], [19, 12]];
for (const [x, y] of trees) put(x, y, "T");

// 8.7) 农田：西南
for (let y = 40; y <= 46; y++) {
  for (let x = 4; x <= 12; x++) {
    put(x, y, "S");
    if ((x - 4) % 3 === 1) put(x, y, "C");
  }
}
put(8, 47, "H"); put(9, 47, "H"); put(10, 47, "H");   // 田边树篱

// 8.8) 果园：东侧
for (let y = 20; y <= 30; y += 3) {
  for (let x = 56; x <= 60; x += 2) {
    if (grid[y][x] === ".") put(x, y, "T");
  }
}

// 8.9) 市集摊位：广场北侧
put(28, 32, "M"); put(29, 32, "M");
put(36, 32, "M"); put(37, 32, "M");

// 8.95) 树篱把广场和主路分开一段
for (let x = 20; x <= 26; x += 2) put(x, 33, "H");
for (let x = 38; x <= 44; x += 2) put(x, 33, "H");

// 9) 围栏（不可走、透光、隔音弱）—— 用来测试"墙挡视线"
rect(26, 30, 30, 30, "=");
rect(34, 30, 38, 30, "=");

const LEGEND = {
  ".": { kind: "grass", walkable: true, opaque: false, soundproof: false },
  ",": { kind: "path", walkable: true, opaque: false, soundproof: false },
  "#": { kind: "wall", walkable: false, opaque: true, soundproof: true },
  "D": { kind: "door", walkable: false, opaque: true, soundproof: true },
  "f": { kind: "floor", walkable: true, opaque: false, soundproof: false },
  "b": { kind: "bed", walkable: false, opaque: false, soundproof: false },
  "s": { kind: "stove", walkable: false, opaque: false, soundproof: false },
  "T": { kind: "tree", walkable: false, opaque: true, soundproof: false },
  "W": { kind: "water", walkable: false, opaque: false, soundproof: false },
  "R": { kind: "rock", walkable: false, opaque: true, soundproof: true },
  "=": { kind: "fence", walkable: false, opaque: true, soundproof: false },
  "x": { kind: "flower", walkable: true, opaque: false, soundproof: false },
  "L": { kind: "lamp", walkable: false, opaque: false, soundproof: false },
  "B": { kind: "bench", walkable: false, opaque: false, soundproof: false },
  "P": { kind: "plank", walkable: true, opaque: false, soundproof: false },
  "O": { kind: "fountain", walkable: false, opaque: false, soundproof: false },
  "N": { kind: "board", walkable: false, opaque: false, soundproof: false },
  "S": { kind: "soil", walkable: true, opaque: false, soundproof: false },
  "C": { kind: "crop", walkable: false, opaque: false, soundproof: false },
  "M": { kind: "stall", walkable: false, opaque: false, soundproof: false },
  "H": { kind: "hedge", walkable: false, opaque: true, soundproof: false },
  "V": { kind: "barrel", walkable: false, opaque: false, soundproof: false },
  "~": { kind: "sand", walkable: true, opaque: false, soundproof: false },
  "t": { kind: "stump", walkable: false, opaque: false, soundproof: false }
};

const out = {
  width: W,
  height: H,
  rows: grid.map((r) => r.join("")),
  heights: heights.map((r) => r.join("")),
  legend: LEGEND,
  spawn: { x: 32, y: 34 },
  homes
};

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, "..", "data", "village.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.log("wrote " + outPath);
console.log("houses: " + houses.length + "  homes: " + JSON.stringify(homes));