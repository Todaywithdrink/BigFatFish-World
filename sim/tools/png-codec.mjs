// PNG 编解码（零依赖，只用 node 内置 zlib）
// 支持：8bit 灰度 / RGB / 调色板(PLTE+tRNS) / 灰度+Alpha / RGBA，无隔行
// 说明：Kenney Tiny 系列是 8bit 调色板 PNG，早期脚本只认 RGB/RGBA 会直接失败，故此处统一处理。
import fs from "node:fs";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 解码 PNG 为 RGBA8。
 * @returns {{w:number,h:number,rgba:Buffer}}
 */
export function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let plte = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "PLTE") plte = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (interlace !== 0) throw new Error(file + ": 不支持隔行 PNG");
  if (bitDepth !== 8) throw new Error(file + ": 仅支持 8bit（实际 " + bitDepth + "）");

  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error(file + ": 不支持的色彩类型 " + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.alloc(stride * h);       // 反滤波后的原始采样
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const base = y * (stride + 1);
    const ft = raw[base];
    const cur = Buffer.from(raw.subarray(base + 1, base + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      if (ft === 1) cur[i] = (cur[i] + a) & 255;
      else if (ft === 2) cur[i] = (cur[i] + b) & 255;
      else if (ft === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    cur.copy(px, y * stride);
    prev = cur;
  }

  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * ch, d = i * 4;
    if (colorType === 3) {
      const pi = px[i];
      if (!plte || pi * 3 + 2 >= plte.length) { rgba[d + 3] = 0; continue; }
      rgba[d] = plte[pi * 3];
      rgba[d + 1] = plte[pi * 3 + 1];
      rgba[d + 2] = plte[pi * 3 + 2];
      rgba[d + 3] = trns && pi < trns.length ? trns[pi] : 255;
    } else if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
      rgba[d + 3] = 255;
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s];
      rgba[d + 3] = px[s + 1];
    } else if (colorType === 2) {
      rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = 255;
    } else {
      rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = px[s + 3];
    }
  }
  return { w, h, rgba };
}

/** 编码 RGBA8 为 PNG（filter 0） */
export function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

/** 从 RGBA 图里裁一块（越界部分填透明） */
export function cropRGBA(img, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let dy = 0; dy < h; dy++) {
    const sy = y + dy;
    if (sy < 0 || sy >= img.h) continue;
    const copyW = Math.max(0, Math.min(w, img.w - x));
    if (copyW <= 0) continue;
    img.rgba.copy(out, dy * w * 4, (sy * img.w + x) * 4, (sy * img.w + x + copyW) * 4);
  }
  return { w, h, rgba: out };
}

/** 取某格 16×16 瓦片的 RGBA buffer */
export function getTile(img, col, row, size = 16) {
  return cropRGBA(img, col * size, row * size, size, size).rgba;
}

/** 该瓦片是否全透明（用于判断源图空格） */
export function isBlank(tileRGBA) {
  for (let i = 3; i < tileRGBA.length; i += 4) if (tileRGBA[i] > 8) return false;
  return true;
}
