// 资产勘察工具：按格裁剪源图 → 整数放大 → 叠加格线标注 → 输出 PNG
// 用途：不打开图像软件也能判断某个 CC0 源图第几行第几列是什么，为"引入新资源"提供依据。
//
// 用法：
//   node sim/tools/sheet-look.mjs <src.png> [col] [row] [cols] [rows] [scale] [out.png]
//   例：node sim/tools/sheet-look.mjs sim/assets/_src/zelda-like/gfx/Overworld.png 0 24 20 12 4 out.png
//   省略参数 → 整图 / 放大 3 倍 / 输出到临时目录
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodePNG, encodePNG } from "./png-codec.mjs";

const TILE = 16;

const [src, aCol, aRow, aCols, aRows, aScale, aOut] = process.argv.slice(2);
if (!src) {
  console.error("用法: node sim/tools/sheet-look.mjs <src.png> [col] [row] [cols] [rows] [scale] [out.png]");
  process.exit(1);
}
if (!fs.existsSync(src)) throw new Error("源图不存在: " + src);

const img = decodePNG(src);
const gridCols = Math.floor(img.w / TILE), gridRows = Math.floor(img.h / TILE);
const col = Number(aCol || 0), row = Number(aRow || 0);
const cols = Math.min(Number(aCols || gridCols), gridCols - col);
const rows = Math.min(Number(aRows || gridRows), gridRows - row);
const scale = Number(aScale || 3);
const out = aOut || path.join(os.tmpdir(), "sheet-look.png");

const cw = cols * TILE * scale, chh = rows * TILE * scale;
const dst = Buffer.alloc(cw * chh * 4);

// 深灰底：透明区域也能看出瓦片边界
for (let i = 0; i < cw * chh; i++) {
  dst[i * 4] = 24; dst[i * 4 + 1] = 26; dst[i * 4 + 2] = 32; dst[i * 4 + 3] = 255;
}

for (let y = 0; y < rows * TILE; y++) {
  const sy = row * TILE + y;
  if (sy >= img.h) break;
  for (let x = 0; x < cols * TILE; x++) {
    const sx = col * TILE + x;
    if (sx >= img.w) break;
    const s = (sy * img.w + sx) * 4;
    if (img.rgba[s + 3] < 8) continue;
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const d = (((y * scale + dy) * cw) + (x * scale + dx)) * 4;
        dst[d] = img.rgba[s]; dst[d + 1] = img.rgba[s + 1];
        dst[d + 2] = img.rgba[s + 2]; dst[d + 3] = 255;
      }
    }
  }
}

// 格线：行红线、列蓝线，便于口头定位（"第 3 行第 12 列"）
const mark = (px, py, r, g, b) => {
  if (px < 0 || py < 0 || px >= cw || py >= chh) return;
  const d = (py * cw + px) * 4;
  dst[d] = r; dst[d + 1] = g; dst[d + 2] = b; dst[d + 3] = 255;
};
for (let r = 0; r <= rows; r++) {
  const py = r * TILE * scale;
  for (let px = 0; px < cw; px++) mark(px, py, 255, 60, 60);
}
for (let c = 0; c <= cols; c++) {
  const px = c * TILE * scale;
  for (let py = 0; py < chh; py++) mark(px, py, 60, 140, 255);
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, encodePNG(cw, chh, dst));
console.log(JSON.stringify({
  src, size: img.w + "x" + img.h, gridOf16: gridCols + "x" + gridRows,
  crop: { col, row, cols, rows }, scale, out
}));
