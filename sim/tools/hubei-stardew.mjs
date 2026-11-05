#!/usr/bin/env node
// ============================================================
// hubei-stardew.mjs —— 湖北省「星露谷式」高度分层地图烘焙器
//
// 比例：L0 基准 1 格 = 2 m / 16 px（1 px = 0.125 m）
// 数据：sim/maps/hubei.bin（群系 500m/格）+ hubei.elev.bin（高程 12m/单位）
//
// 产出：
//   sim/viewer/hubei-stardew.png          全省分层图（L4 数据，2px/格 = 2994×1920）
//   sim/viewer/hubei-stardew-l0-<slug>.png  2m/格 局部样张（160 格 = 320m，2048²→2560²）
//   sim/maps/hubei.tiers.json             层带统计（运行时图例/校验用）
//
// 用法：
//   node sim/tools/hubei-stardew.mjs                 全量烘焙
//   node sim/tools/hubei-stardew.mjs --only poster
//   node sim/tools/hubei-stardew.mjs --only slice
//   node sim/tools/hubei-stardew.mjs --check          只打层带面积统计
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePNG } from "./png-codec.mjs";
import {
  GRID_M, TILE_PX, LIFT_TILE, LIFT_PX, BOUNDS, TIERS, MAX_TIER,
  MICRO_LIFT_PX, STEP_M, levelOf, tierOf, slopeClass, softenR, riserRunCells, soilAt, PALETTE, mix, shade
} from "./stardew-spec.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.resolve(HERE, "..");
const IN_BIN = path.join(SIM, "maps", "hubei.bin");
const IN_ELEV = path.join(SIM, "maps", "hubei.macro.bin");   // 宏观高程（不含山体阴影用的粗糙度）
const IN_META = path.join(SIM, "maps", "hubei.json");
const OUT_POSTER = path.join(SIM, "viewer", "hubei-stardew.png");
const OUT_TIERS = path.join(SIM, "maps", "hubei.tiers.json");

// ---------- 噪声（值噪声 + fbm，连续性依赖整数格哈希）----------
function h2(x, y) {
  // 必须用 Math.imul 做 32 位乘法：普通 * 会超过 2^53，double 精度塌掉，
  // 哈希退化成近似常数——所有"按格随机"的分支都会选中同一个，整片地表变成纯色。
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
const smoothstep = (t) => t * t * (3 - 2 * t);
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smoothstep(x - xi), ty = smoothstep(y - yi);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}
function fbm(x, y, oct = 4) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f + i * 31.7, y * f + i * 17.3) * amp; norm += amp; amp *= 0.5; f *= 2; }
  return s / norm;
}

// ---------- 读取世界 ----------
const meta = JSON.parse(fs.readFileSync(IN_META, "utf8"));
const W = meta.w, H = meta.h;
const biome = new Uint8Array(fs.readFileSync(IN_BIN));
const elevBuf = fs.readFileSync(IN_ELEV);
const elev16 = new Uint16Array(elevBuf.buffer, elevBuf.byteOffset, elevBuf.length / 2);
const ELEV_UNIT = meta.elev16Unit || 2;   // 2 m / 单位（8bit 那路 12m/单位会跳过整段层带）
const CELL_KM = meta.tileKm;                 // 0.5 km / 格
const KM_LNG = meta.kmPerDegLng;
const KM_LAT = meta.kmPerDegLat;
const LNG0 = meta.lng0, LAT1 = meta.lat1;

const isWaterBiome = (b) => b === 1 || b === 2;
const isVoid = (b) => b === 0;

/** 双线性采样高程（米）。越界返回 NaN */
function elevAt(gx, gy) {
  if (gx < -1 || gy < -1 || gx > W || gy > H) return NaN;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx = gx - x0, ty = gy - y0;
  // 0 = 省界外。绝不能当 0 米参与插值，否则省界一侧会被拉出上千米的假陡坡；
  // 这里按有效样本重新归一化权重，全无效才返回 NaN。
  const at = (x, y) => {
    const xx = Math.max(0, Math.min(W - 1, x)), yy = Math.max(0, Math.min(H - 1, y));
    const e = elev16[yy * W + xx];
    return e === 0 ? NaN : e * ELEV_UNIT;
  };
  const s00 = at(x0, y0), s10 = at(x0 + 1, y0), s01 = at(x0, y0 + 1), s11 = at(x0 + 1, y0 + 1);
  let acc = 0, wsum = 0;
  const add = (v, w) => { if (isFinite(v)) { acc += v * w; wsum += w; } };
  add(s00, (1 - tx) * (1 - ty)); add(s10, tx * (1 - ty));
  add(s01, (1 - tx) * ty);       add(s11, tx * ty);
  return wsum > 0 ? acc / wsum : NaN;
}
function maskAt(gx, gy, pred) {
  if (gx < 0 || gy < 0 || gx > W - 1 || gy > H - 1) return 0;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx = gx - x0, ty = gy - y0;
  const at = (x, y) => pred(biome[Math.min(H - 1, y) * W + Math.min(W - 1, x)]) ? 1 : 0;
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty)
       + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

// ---------- 连续层坐标（用于坡度过渡插值）----------
function tierFloat(h) {
  if (h < BOUNDS[0]) return (h / BOUNDS[0]) * 1;            // 0..1
  for (let i = 1; i < BOUNDS.length; i++) {
    if (h < BOUNDS[i]) return i + (h - BOUNDS[i - 1]) / (BOUNDS[i] - BOUNDS[i - 1]);
  }
  return MAX_TIER;
}

// ---------- 2m 尺度细节合成 ----------
// 500m DEM 升到 2m 是纯插值，一个 320m 的切片连一个源格都盖不满；
// 不补细节的话画面就是一块纯色。细节幅度按真实坡度加权：平原几乎不动，山地出沟壑。
function detailAt(mx, my, base, g) {
  if (base > 2400) return (fbm(mx / 40, my / 40, 3) - 0.5) * 10;
  const rough = Math.min(1, g * 5.5) * (0.55 + fbm(mx / 900, my / 900, 2) * 0.9);
  let d = 0;
  d += (fbm(mx / 145, my / 145, 3) - 0.5) * (4 + 20 * rough);      // 大起伏（波长要远大于台阶间距，否则台地边缘被打成散点）
  d += -(Math.abs(fbm(mx / 72 + 13.1, my / 72 + 7.7, 2) - 0.5) * 2) * (1.5 + 6 * rough); // 冲沟
  d += (fbm(mx / 24 + 3.3, my / 24 + 2.1, 2) - 0.5) * (0.4 + 1.0 * rough);              // 碎石
  if (base < 170) d = d * 0.34 + (fbm(mx / 260 + 5.5, my / 260 + 2.2, 2) - 0.5) * 4.0;  // 低地只留缓起伏
  return d;
}

// ---------- 绘制 ----------
function makeCanvas(w, h, bg) {
  const img = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    img[i * 4] = bg[0]; img[i * 4 + 1] = bg[1]; img[i * 4 + 2] = bg[2]; img[i * 4 + 3] = 255;
  }
  return img;
}
function px(img, cw, ch, x, y, c) {
  if (x < 0 || y < 0 || x >= cw || y >= ch) return;
  const i = (y * cw + x) * 4;
  img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; img[i + 3] = 255;
}
function rect(img, cw, ch, x, y, w, h, c) {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) px(img, cw, ch, x + dx, y + dy, c);
}

/**
 * 核心绘制：逐列从北往南（远→近）画，后画的南侧格自然盖住北侧的侧壁，
 * 这是 2.5D 像素地图唯一正确的遮挡顺序，换成"由上到下逐行画"会立刻出错。
 *
 * @param {object} d  {tier:Int8Array, lift:Float32Array(px), wet:Uint8Array}
 */
function paint(w, h, pp, d, opt = {}) {
  const maxLift = opt.maxLift || 0;
  const pad = Math.ceil(maxLift) + 2;
  const CW = w * pp, CH = h * pp + pad + 2;
  const img = makeCanvas(CW, CH, opt.bg || PALETTE.voidBg);
  const outline = !!opt.outline;
  const texScale = opt.texScale || 1;

  for (let x = 0; x < w; x++) {
    const ox = x * pp;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      const t = d.tier[i];
      if (t < 0) continue;
      const L = d.lift[i];
      const topY = Math.round(y * pp - L) + pad;
      const tier = TIERS[t];
      const wet = d.wet && d.wet[i];
      const slant = d.slope ? d.slope[i] / 255 : 0;
      const lvK = d.lvShade ? d.lvShade[i] / 1000 : 1;
      const hx = h2(x * 7 + 13, y * 11 + 5);

      // ---- 台面 ----
      let base = tier.surf;
      if (wet) base = PALETTE.water;
      // 雪线不做整片纯白，掺裸岩斑，否则就是一块白色贴纸
      if (t === MAX_TIER && !wet && hx > 0.72) base = mix(base, [138, 140, 132], 0.55);
      // 坡面染土色：像素画里"斜"是靠颜色读出来的，纯几何只有在 45° 才够
      if (slant > 0.02 && !wet) base = mix(base, d.hgt ? soilAt(d.hgt[i]) : tier.soil, slant * 0.30);
      if (lvK !== 1) base = shade(base, lvK);
      // 逐格微抖动：完全同色的台面在像素图里像贴纸
      const j = (hx - 0.5) * (wet ? 3 : 7);
      base = [base[0] + j, base[1] + j, base[2] + j];
      // 西北方向光：台面按坡向微调明度，纯平涂的台地看不出起伏
      if (d.hgt && !wet) {
        const hL = x > 0 ? d.hgt[i - 1] : d.hgt[i];
        const hR = x + 1 < w ? d.hgt[i + 1] : d.hgt[i];
        const hU = y > 0 ? d.hgt[i - w] : d.hgt[i];
        const hD = y + 1 < h ? d.hgt[i + w] : d.hgt[i];
        const kk = 1 + Math.max(-0.13, Math.min(0.13, (-(hR - hL) - (hD - hU)) * 0.012));
        base = shade(base, kk);
      }
      rect(img, CW, CH, ox, topY, pp, pp, base);

      // ---- 台面纹理 ----
      if (pp >= 6) {
        const s = Math.max(1, Math.round(pp / 16 * 1.5));   // 纹理点尺寸随 pp 缩放
        if (wet) {
          // 水面横纹
          if (y % 2 === 0 && hx > 0.45) rect(img, CW, CH, ox + Math.floor(pp * 0.2), topY + Math.floor(pp * 0.55), Math.floor(pp * 0.6), s, PALETTE.waterHi);
        } else if (t <= 4) {
          // 低地：田垄 / 草簇
          if (hx > 0.62) {
            for (let r = 2; r < pp; r += 5) rect(img, CW, CH, ox + 1, topY + r, pp - 2, 1, shade(base, 0.9));
          } else if (hx > 0.52) {
            // 草簇：一竖两撇
            const gx2 = ox + 3 + (Math.floor(hx * 977) % 9);
            const gy2 = topY + 3 + (Math.floor(hx * 613) % 9);
            rect(img, CW, CH, gx2, gy2, 1, 4, shade(base, 0.74));
            rect(img, CW, CH, gx2 - 1, gy2 + 1, 1, 3, shade(base, 0.80));
            rect(img, CW, CH, gx2 + 2, gy2, 1, 3, shade(base, 1.22));
            rect(img, CW, CH, gx2 + 1, gy2 + 2, 1, 2, shade(base, 1.10));
          } else if (hx > 0.40 && hx < 0.46) {
            // 碎石
            rect(img, CW, CH, ox + 5, topY + 6, 3, 2, shade(base, 0.72));
            rect(img, CW, CH, ox + 5, topY + 6, 2, 1, shade(base, 1.18));
          } else if (hx > 0.30 && hx < 0.34) {
            rect(img, CW, CH, ox + 6, topY + 7, 2, 1, [238, 226, 150]);   // 零星小花
          }
        } else if (t >= 9) {
          // 山地地表：克制点状草簇 + 少量碎石（大片纯色比满屏小方块更像地图）
          const gx2 = ox + 2 + (Math.floor(hx * 977) % 11), gy2 = topY + 3 + (Math.floor(hx * 613) % 10);
          if (hx > 0.62) {
            rect(img, CW, CH, gx2, gy2, 1, 3, shade(base, 0.80));
            rect(img, CW, CH, gx2 + 1, gy2 + 1, 1, 2, shade(base, 1.14));
          } else if (hx > 0.46) {
            rect(img, CW, CH, gx2, gy2, 3, 2, shade(base, 0.86));
            rect(img, CW, CH, gx2, gy2, 2, 1, shade(base, 1.10));
          } else if (hx > 0.30) {
            rect(img, CW, CH, gx2, gy2, 1, 1, shade(base, 0.88));
          }
        } else {
          // 林地：树冠暗块 + 树干
          if (hx > 0.42) {
            rect(img, CW, CH, ox + 4, topY + 3, pp - 8, pp - 6, shade(base, 0.78));
            rect(img, CW, CH, ox + 5, topY + 4, pp - 10, pp - 9, shade(base, 0.9));
            rect(img, CW, CH, ox + 5, topY + 5, 2, 2, shade(base, 1.18));
          } else if (hx < 0.18) {
            rect(img, CW, CH, ox + 7, topY + 9, 1, 3, [92, 70, 48]);
          }
        }
      }

      // ---- 南侧露土侧壁（高度分界线）----
      const Ls = (y + 1 < h) ? d.lift[(y + 1) * w + x] : L;
      const tS = (y + 1 < h) ? d.tier[(y + 1) * w + x] : -1;
      const wetS = d.wet && y + 1 < h && d.wet[(y + 1) * w + x];
      let fh = Math.round(L - Ls);
      if (fh > 0 && !wet) {
        if (opt.dbg) opt.dbg.faces.push(fh);
        if (tS < 0) fh = Math.min(fh, 1);
        let soil = d.hgt ? soilAt(d.hgt[i]) : tier.soil;
        // 临水一侧的"崖"其实是河岸，画成土色会在江面上拉出一条橙褐色的假河道
        if (wetS) { soil = mix(shade(soil, 0.72), PALETTE.water, 0.35); fh = 0; }   // 河岸不画崖
        for (let r = 0; r < fh; r++) {
          let c;
          if (r === 0) c = mix(tier.surf, [255, 255, 236], 0.30);   // 草皮断面的亮口
          else if (r === 1) c = mix(tier.surf, soil, 0.62);          // 草根过渡
          else if (r >= fh - 1) c = shade(soil, 0.60);               // 脚影
          else c = (r % 3 === 0) ? shade(soil, 0.90) : soil;         // 土层横纹
          rect(img, CW, CH, ox, topY + pp + r, pp, 1, c);
        }
      }
      // 北侧更高 → 崖下投一道渐隐阴影。这是"高低差"最关键的一笔：
      // 没有它，上下两级台面同色，崖壁再准也读成平面上的线描。
      const Ln = (y > 0) ? d.lift[(y - 1) * w + x] : L;
      if (Ln > L) {
        const sh = Math.min(pp, Math.round((Ln - L) * 0.85));
        for (let r = 0; r < sh; r++) {
          // 水面吃影要轻：按陆地那套压暗，江面会变成一条黑线
          const k = wet ? 0.86 + 0.12 * (r / Math.max(1, sh))
                        : 0.56 + 0.34 * (r / Math.max(1, sh));
          rect(img, CW, CH, ox, topY + r, pp, 1, shade(base, k));
        }
      }

      // ---- 东西向落差：2px 土色侧棱 ----
      // 3/4 俯视看不到东/西侧面，但 45° 台阶上如果只留 1px 描边，
      // 崖壁会断成一节节的方块，整条崖线读成虚线。这里补 2px 土色棱把台阶串起来。
      if (pp >= 4 && !wet) {
        const Lw = (x > 0) ? d.lift[i - 1] : L;
        const Le = (x + 1 < w) ? d.lift[i + 1] : L;
        const soilE = d.hgt ? soilAt(d.hgt[i]) : tier.soil;
        if (Lw - L >= 1) rect(img, CW, CH, ox, topY, 2, pp, mix(shade(base, 0.62), soilE, 0.55));
        if (Le - L >= 1) rect(img, CW, CH, ox + pp - 2, topY, 2, pp, mix(shade(base, 0.62), soilE, 0.55));
        else if (Le - L <= -1) rect(img, CW, CH, ox + pp - 1, topY, 1, pp, shade(base, 0.80));
      }

      // ---- 省界描边 ----
      if (outline) {
        const nearVoid =
          (x > 0 && d.tier[i - 1] < 0) || (x + 1 < w && d.tier[i + 1] < 0) ||
          (y > 0 && d.tier[i - w] < 0) || (y + 1 < h && d.tier[i + w] < 0);
        if (nearVoid) {
          if (x > 0 && d.tier[i - 1] < 0) rect(img, CW, CH, ox, topY, 1, pp, PALETTE.edgeDark);
          if (x + 1 < w && d.tier[i + 1] < 0) rect(img, CW, CH, ox + pp - 1, topY, 1, pp, PALETTE.edgeDark);
          if (y > 0 && d.tier[i - w] < 0) rect(img, CW, CH, ox, topY, pp, 1, PALETTE.edgeDark);
          if (y + 1 < h && d.tier[i + w] < 0) rect(img, CW, CH, ox, topY + pp - 1, pp, 1, PALETTE.edgeDark);
        }
      }
    }
  }
  return { w: CW, h: CH, rgba: img };
}

/** 全图调色：轻微提饱和 + 提对比。程序生成的调色板天然偏灰，
 *  不加这一道，整张图会像"水泥地"，怎么调层带色都救不回来。 */
function grade(rgba, sat = 1.22, con = 1.07) {
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    let nr = l + (r - l) * sat, ng = l + (g - l) * sat, nb = l + (b - l) * sat;
    nr = (nr - 128) * con + 128; ng = (ng - 128) * con + 128; nb = (nb - 128) * con + 128;
    rgba[i] = Math.max(0, Math.min(255, Math.round(nr)));
    rgba[i + 1] = Math.max(0, Math.min(255, Math.round(ng)));
    rgba[i + 2] = Math.max(0, Math.min(255, Math.round(nb)));
  }
  return rgba;
}

// ---------- 全省海报（L4 数据，pp=2）----------
function buildPoster(pp = 2, noWrite = false) {
  const tier = new Int8Array(W * H);
  const lift = new Float32Array(W * H);
  const wet = new Uint8Array(W * H);

  for (let i = 0; i < W * H; i++) {
    const b = biome[i];
    if (isVoid(b)) { tier[i] = -1; continue; }
    if (isWaterBiome(b)) { tier[i] = 0; wet[i] = 1; continue; }
    tier[i] = tierOf(elev16[i] * ELEV_UNIT);
  }

  // 3×3 众数滤波：500m/格 的层带边界会被噪声打成麻点，众数能保住台面、削掉孤立点
  const sm = new Int8Array(W * H);
  const cnt = new Int16Array(MAX_TIER + 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (tier[i] < 0) { sm[i] = -1; continue; }
      cnt.fill(0);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const t = tier[yy * W + xx];
        if (t >= 0) cnt[t]++;
      }
      let best = tier[i], bc = -1;
      for (let t = 0; t <= MAX_TIER; t++) {
        // 同票时偏向原值，避免整块台面在边界上抖成另一层
        const c = cnt[t] + (t === tier[i] ? 0.5 : 0);
        if (c > bc) { bc = c; best = t; }
      }
      sm[i] = best;
    }
  }

  const maxLift = (MAX_TIER) * LIFT_TILE * pp;
  for (let i = 0; i < W * H; i++) lift[i] = sm[i] < 0 ? 0 : sm[i] * LIFT_TILE * pp;

  const out = paint(W, H, pp, { tier: sm, lift, wet }, { maxLift, outline: true, bg: PALETTE.voidBg });
  grade(out.rgba, 1.16, 1.05);
  if (!noWrite) {
    fs.writeFileSync(OUT_POSTER, encodePNG(out.w, out.h, out.rgba));
    console.log(`[poster] ${out.w}×${out.h} → ${path.relative(SIM, OUT_POSTER)}`);
  }

  // 统计
  const hist = new Array(TIERS.length).fill(0);
  let land = 0;
  for (let i = 0; i < W * H; i++) { if (sm[i] >= 0) { hist[sm[i]]++; if (!wet[i]) land++; } }
  return { hist, land, sm };
}

// ---------- L0 切片（2m/格）----------
function buildSlice(lng, lat, cells, pp = TILE_PX, name = "slice") {
  const cx = (lng - LNG0) * KM_LNG / CELL_KM;       // 切片中心：源格坐标
  const cy = (LAT1 - lat) * KM_LAT / CELL_KM;
  const half = cells / 2;
  const STEP = CELL_KM * 1000 / GRID_M;             // 1 源格 = 250 个 2m 格

  const n = cells * cells;
  const hgt = new Float32Array(n);
  const wet = new Uint8Array(n);
  const valid = new Uint8Array(n);
  const gsrc = new Float32Array(n);

  // ① 高程合成
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const k = j * cells + i;
      // 切片中心对齐到源格坐标，再按 2m 步长外推
      const sgx = cx + (i - half) / STEP;
      const sgy = cy + (j - half) / STEP;
      const base = elevAt(sgx, sgy);
      if (!isFinite(base)) continue;
      // 坡度：宏观场上的中心差分（米/米）
      const stepS = 1.2;                             // 0.6 km 采样臂长
      const eE = elevAt(sgx + stepS, sgy), eW = elevAt(sgx - stepS, sgy);
      const eN = elevAt(sgx, sgy - stepS), eS = elevAt(sgx, sgy + stepS);
      const g = Math.hypot(
        (eE - eW) / (stepS * CELL_KM * 1000),
        (eS - eN) / (stepS * CELL_KM * 1000)
      );

      // 世界米坐标（跨切片连续，噪声不会每张图重新洗牌）
      const worldX = (i - half) * GRID_M + (lng - LNG0) * KM_LNG * 1000;
      const worldY = (j - half) * GRID_M + (LAT1 - lat) * KM_LAT * 1000;

      const wetF = maskAt(sgx, sgy, isWaterBiome);
      const wob = (fbm(worldX / 26, worldY / 26, 3) - 0.5) * 0.42;
      const isWet = wetF + wob > 0.5;

      let hv = base + detailAt(worldX, worldY, base, g);
      if (isWet) hv = Math.min(hv, 4);
      hgt[k] = hv; wet[k] = isWet ? 1 : 0; valid[k] = 1; gsrc[k] = g;
    }
  }

  // ①b 轻度平滑：细节噪声会在 4 m 尺度上抖出大量孤立台阶，
  //     把等高线打成一节节的短划。先做 5×5 箱式平滑，等高线才是连贯的长线。
  {
    const src = Float32Array.from(hgt);
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const i = y * cells + x;
        if (!valid[i]) continue;
        let s2 = 0, c2 = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= cells) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= cells) continue;
            const k2 = yy * cells + xx;
            if (!valid[k2]) continue;
            s2 += src[k2]; c2++;
          }
        }
        hgt[i] = s2 / Math.max(1, c2);
      }
    }
  }

  // ② 基准面：切片内最低陆地点对应的台阶号。
  //    抬升相对本场景，否则 1500 m 的山区绝对台阶号会把画面顶到几千像素高。
  let hmin = Infinity;
  for (let k = 0; k < n; k++) if (valid[k] && !wet[k] && hgt[k] < hmin) hmin = hgt[k];
  if (!isFinite(hmin)) hmin = 0;
  const L0 = Math.floor(levelOf(hmin)) - 1;

  // ③ 台阶坐标 u（相对基准面，1 级 = 一段高程带）
  const UMAX = 40;
  const u = new Float32Array(n);
  const macro = new Int8Array(n);
  for (let k = 0; k < n; k++) {
    if (!valid[k]) { macro[k] = -1; continue; }
    macro[k] = wet[k] ? 0 : tierOf(hgt[k]);
    if (wet[k]) { u[k] = 0; continue; }
    let v = levelOf(hgt[k]) - L0;
    if (v > UMAX) v = UMAX + (v - UMAX) * 0.35;  // 超陡坡软压缩，不让画面无限长高
    u[k] = v;
  }

  // ④ 量化到整数级，再用变量半径箱式模糊把硬台阶摊成斜坡。
  //    半径 R ⇒ 过渡带宽 2R+1 格（缓坡 7 格 / 中坡 5 格 / 陡坡 3 格 / 陡崖 1 格）。
  const q = new Int16Array(n);
  for (let k = 0; k < n; k++) q[k] = valid[k] ? Math.round(u[k]) : 0;

  const blurR = (R) => {
    const out = new Float32Array(n);
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const i = y * cells + x;
        if (!valid[i]) { out[i] = 0; continue; }
        let s = 0, c = 0;
        for (let dy = -R; dy <= R; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= cells) continue;
          for (let dx = -R; dx <= R; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= cells) continue;
            const k2 = yy * cells + xx;
            if (!valid[k2]) continue;
            s += q[k2]; c++;
          }
        }
        out[i] = s / Math.max(1, c);
      }
    }
    return out;
  };
  const b1 = blurR(1), b2 = blurR(2), b3 = blurR(3);
  let qMin = 1e9;
  for (let k = 0; k < n; k++) if (valid[k] && !wet[k]) qMin = Math.min(qMin, q[k]);
  if (!isFinite(qMin)) qMin = 0;

  const lift = new Float32Array(n);
  const tier = new Int8Array(n);
  const slopeAmt = new Uint8Array(n);
  const lvShade = new Uint16Array(n);
  let maxLift = 0, steps = 0;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const i = y * cells + x;
      if (!valid[i]) { tier[i] = -1; lift[i] = 0; continue; }
      tier[i] = macro[i];
      if (wet[i]) { lift[i] = 0; continue; }
      // 本格坡度（用合成后的高程做中心差分）
      const eE = hgt[y * cells + Math.min(cells - 1, x + 1)];
      const eW = hgt[y * cells + Math.max(0, x - 1)];
      const eS = hgt[Math.min(cells - 1, y + 1) * cells + x];
      const eN = hgt[Math.max(0, y - 1) * cells + x];
      const g = Math.hypot((eE - eW) / (2 * GRID_M), (eS - eN) / (2 * GRID_M));
      // 崖线错位半径 R：只决定"边界落在相邻哪一格"，不摊薄任何一级的落差。
      // 台阶本来就挤（间距 < 6 格）时不再错位，否则相邻两级的边界互相串开，崖线烂成筛子。
      const run = riserRunCells(g);
      const R = Math.min(softenR(g), Math.max(0, Math.floor(run / 6)));
      const src = R === 0 ? u : R === 1 ? b1 : R === 2 ? b2 : b3;
      const qq = q[i];
      // 钳到 ±0.5：台面内部保持整数（平），只有边界附近出现小数，模糊才只作用在崖线上
      const uc = Math.max(qq - 0.5, Math.min(qq + 0.5, src[i]));
      // 只允许整级（16px）落差。半级（8px）会把一堵崖壁拆成两段，看上去像一串虚线；
      // 逐像素量化则会把缓坡摊成"每格 1px"的斜纹，台阶感与土色分界全丢。
      // 坡度的"斜"由**踏步间距**表达：缓坡上层间距大、陡坡间距小，这正是星露谷的处理。
      const px = Math.round(uc) * MICRO_LIFT_PX;
      lift[i] = px;
      if (px > maxLift) maxLift = px;
      if (px > 0) steps++;
      // 坡面带：凡是距离层界 ≤2 格的格子都染土色，宽 3~5 格 —— 这条带子就是"坡度衔接区"
      {
        let hit = 0;
        for (let dy = -2; dy <= 2 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= cells) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= cells) continue;
            if (q[yy * cells + xx] !== qq) { hit = dy === 0 && Math.abs(dx) <= 1 || Math.abs(dy) <= 1 && dx === 0 ? 255 : 150; break; }
          }
        }
        slopeAmt[i] = hit;
      }
      // 每升一级，台面亮度 +1.2%：同一层带内上下两级台面因此有可读的色阶差，
      // 否则崖壁再准也像画在平板上的等高线。
      lvShade[i] = Math.round(1000 * (1 + Math.max(-0.05, Math.min(0.13, (qq - qMin) * 0.012))));
    }
  }

  const dbg = process.env.DBG ? { faces: [] } : null;
  const out = paint(cells, cells, pp, { tier, lift, wet, hgt, slope: slopeAmt, lvShade }, {
    maxLift, bg: PALETTE.voidBg, dbg
  });
  if (dbg) {
    const h = {};
    for (const f of dbg.faces) h[f] = (h[f] || 0) + 1;
    console.log("  [dbg] faces", dbg.faces.length, JSON.stringify(h));
  }
  const file = path.join(SIM, "viewer", `hubei-stardew-l0-${name}.png`);
  fs.writeFileSync(file, encodePNG(out.w, out.h, out.rgba));
  let hmax = -Infinity;
  for (let k = 0; k < n; k++) if (valid[k]) hmax = Math.max(hmax, hgt[k]);
  if (process.env.DBG) {
    const uniq = new Set();
    let lmin = 1e9;
    for (let k = 0; k < n; k++) if (valid[k]) { uniq.add(lift[k]); lmin = Math.min(lmin, lift[k]); }
    const hist = {};
    for (let k = 0; k < n; k++) if (valid[k]) hist[q[k]] = (hist[q[k]] || 0) + 1;
    console.log("  [dbg] lift", lmin, "..", maxLift, "distinct", uniq.size, "u-range",
      Math.min(...u), Math.max(...u));
    console.log("  [dbg] q hist", JSON.stringify(hist));
    const col = 80, rows = [];
    for (let y = 0; y < cells; y += 8) {
      const k = y * cells + col;
      rows.push(`${y}:h${hgt[k].toFixed(0)} u${u[k].toFixed(2)} q${q[k]} L${lift[k]}`);
    }
    console.log("  [dbg] col80\n    " + rows.join("\n    "));
  }
  console.log(`[slice:${name}] ${lng},${lat}  基准 ${hmin.toFixed(0)}m  高差 ${(hmax - hmin).toFixed(0)}m  ` +
    `最大抬升 ${maxLift}px  有台阶 ${steps} 格  ${out.w}×${out.h} → ${path.relative(SIM, file)}`);

  // ---- 实测台阶间距：逐列找"抬升发生变化"的行，量相邻两次换级的距离 ----
  // 这是"坡度衔接区宽度"的唯一硬证据：它不看规格表，只看烘出来的 lift 场。
  const gapStat = (() => {
    const gaps = [];
    for (let x = 0; x < cells; x++) {
      let prevRow = null, lastChange = null;
      for (let y = 0; y < cells; y++) {
        const k = y * cells + x;
        if (!valid[k] || wet[k]) { prevRow = null; lastChange = null; continue; }
        if (prevRow !== null && lift[k] !== lift[prevRow * cells + x]) {
          if (lastChange !== null) gaps.push(y - lastChange);
          lastChange = y;
        }
        prevRow = y;
      }
    }
    if (!gaps.length) return { n: 0, min: null, p25: null, med: null, p75: null, max: null };
    gaps.sort((a, b) => a - b);
    const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
    return { n: gaps.length, min: gaps[0], p25: q(.25), med: q(.5), p75: q(.75), max: gaps[gaps.length - 1] };
  })();
  console.log(gapStat.n
    ? `  [gap] ${gapStat.n} 处 · 最密 ${gapStat.min} 格 · 中位 ${gapStat.med} 格 · 最疏 ${gapStat.max} 格`
    : "  [gap] 无换级（整片同一级台地）");
  return { tier, lift, cells, gapStat, hmin, hmax, maxLift, name };
}

// ---------- 统计 ----------
function report(hist, land) {
  console.log("\n层带面积分布（全省陆域）:");
  console.log("层  名称              高程区间(m)        格数      占比");
  let cum = 0;
  for (let t = 1; t <= MAX_TIER; t++) {
    const n = hist[t] || 0;
    cum += n;
    const p = (n / land * 100);
    console.log(
      `${String(t).padStart(2)}  ${TIERS[t].name.padEnd(14)} ` +
      `${String(TIERS[t].lo).padStart(5)}–${String(TIERS[t].hi === 99999 ? "  ∞" : TIERS[t].hi).padStart(5)} ` +
      `${String(n).padStart(9)}  ${p.toFixed(2).padStart(6)}%`
    );
  }
  console.log(` 水面/滩涂(T0) ${String(hist[0] || 0).padStart(9)} 格`);
  console.log(` 合计 ${cum} 格（校验 ${Math.abs(cum - land) < 1 ? "OK" : "偏差 " + (cum - land)}）`);
}

// ---------- 主流程 ----------
const argv = process.argv.slice(2);
const only = (() => { const i = argv.indexOf("--only"); return i >= 0 ? argv[i + 1] : null; })();

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`用法: node sim/tools/hubei-stardew.mjs [--only poster|slice] [--check]`);
  process.exit(0);
}

if (argv.includes("--check")) {
  const { hist, land } = buildPoster(1, true);   // pp=1 且不落盘，只为统计
  report(hist, land);
  process.exit(0);
}

const t0 = Date.now();
let posterRes = null;
if (!only || only === "poster") posterRes = buildPoster(2);

const SLICES = [
  { name: "shennongjia", lng: 110.881, lat: 31.255, note: "神农架东麓 1940 m（1 km 内起伏 202 m）" },
  { name: "wushan",      lng: 111.306, lat: 31.071, note: "巫山余脉 878 m（起伏 126 m）" },
  { name: "tongbai",     lng: 112.854, lat: 32.209, note: "桐柏山前 294 m（起伏 54 m）" },
  { name: "pingyuan",    lng: 114.476, lat: 30.909, note: "江汉平原北缘 58 m（起伏 6 m）" }
];
const sampleStats = [];
if (!only || only === "slice") {
  for (const s of SLICES) {
    const r = buildSlice(s.lng, s.lat, 80, TILE_PX, s.name);
    sampleStats.push({
      name: s.name, note: s.note,
      lo: Math.round(r.hmin), hi: Math.round(r.hmax),
      relief: Math.round(r.hmax - r.hmin),
      maxLiftPx: r.maxLift,
      gap: r.gapStat
    });
  }
}

if (posterRes) {
  report(posterRes.hist, posterRes.land);
  const out = {
    generated: new Date().toISOString(),
    gridM: GRID_M, tilePx: TILE_PX, stepM: STEP_M, liftPx: MICRO_LIFT_PX,
    posterLiftPxPerTier: LIFT_TILE * 2,
    bounds: BOUNDS,
    tiers: TIERS.map((t, i) => ({
      id: i, name: t.name, lo: t.lo, hi: t.hi,
      surf: t.surf, soil: t.soil, hist: posterRes.hist[i] || 0
    })),
    land: posterRes.land,
    // 四张 L0 样张的实测换级间距 —— 坡度衔接宽度的硬证据
    samples: sampleStats
  };
  fs.writeFileSync(OUT_TIERS, JSON.stringify(out, null, 2));
  console.log(`[tiers] → ${path.relative(SIM, OUT_TIERS)}`);
}

console.log(`\n完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
