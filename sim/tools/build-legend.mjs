#!/usr/bin/env node
// ============================================================
// build-legend.mjs —— 由规格文件直接生成图例页（避免文档与代码脱节）
//
// 输入：sim/tools/stardew-spec.mjs（单一真源）+ sim/maps/hubei.tiers.json（面积统计）
// 输出：sim/viewer/height-legend.html（自包含，图片走相对路径）
//
// 用法：node sim/tools/build-legend.mjs
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRID_M, TILE_PX, LIFT_TILE, LIFT_PX, LOD, BOUNDS, TIERS, MAX_TIER,
  SLOPE, STEP_M, MICRO_LIFT_PX, V_COMPRESS, riserRunCells, risersPerScreen
} from "./stardew-spec.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM = path.resolve(HERE, "..");
const OUT = path.join(SIM, "viewer", "height-legend.html");

const stat = JSON.parse(fs.readFileSync(path.join(SIM, "maps", "hubei.tiers.json"), "utf8"));
const land = stat.land;
const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const pct = (n) => (n / land * 100);

// 垂直压缩：8m 按 1:1 应画多少 px，实际画多少
const truePx = (STEP_M / (GRID_M / TILE_PX));
const compress = truePx / MICRO_LIFT_PX;

const tierRows = TIERS.map((t, i) => {
  const s = stat.tiers[i] || { hist: 0 };
  const thick = (t.hi > 9000 || t.lo < 0) ? "—" : (t.hi - t.lo) + " m";
  return `<tr>
    <td class="id">T${i}</td>
    <td><span class="sw" style="background:${hex(t.surf)}"></span>${t.name}</td>
    <td class="num">${t.lo < 0 ? "&lt;26" : t.lo}${t.hi > 9000 ? "+" : "–" + t.hi}</td>
    <td class="num">${thick}</td>
    <td><span class="sw" style="background:${hex(t.soil)}"></span><code>${hex(t.soil)}</code></td>
    <td>
      <div class="bar"><i style="width:${Math.min(100, pct(s.hist) * 4).toFixed(1)}%"></i></div>
      <span class="num small">${pct(s.hist).toFixed(2)}%</span>
    </td>
  </tr>`;
}).join("\n");

// 每档取几何中点作为代表坡度（比算术中点更贴近真实分布：坡度是乘性尺度）
const midG = (s) => (s.maxG === Infinity ? s.minG * 1.6 : Math.sqrt(Math.max(s.minG, 0.004) * s.maxG));

const slopeRows = SLOPE.map((s) => {
  const g = midG(s);
  const run = riserRunCells(g);
  const per = risersPerScreen(g);
  const runTxt = isFinite(run)
    ? `${run.toFixed(1)} 格<span class="small"> / ${Math.round(run * TILE_PX)} px</span>`
    : "— <span class=\"small\">（不换级）</span>";
  return `<tr>
  <td>${s.name}</td>
  <td class="num">${s.minG.toFixed(3)}–${s.maxG === Infinity ? "∞" : s.maxG.toFixed(3)}</td>
  <td class="num">${g.toFixed(2)}</td>
  <td class="num">${runTxt}</td>
  <td class="num">${per ? per.toFixed(1) + " 级" : "0"}</td>
  <td class="small">${s.note}</td>
</tr>`;
}).join("\n");

const sampleRows = (stat.samples || []).map((s) => {
  const g = s.gap || {};
  const gapTxt = g.n
    ? `最密 ${g.min} · 中位 <b class="hl">${g.med}</b> · 最疏 ${g.max}`
    : "整片一级（无换级）";
  return `<tr>
  <td><code>${s.name}</code><div class="small">${s.note}</div></td>
  <td class="num">${s.lo}–${s.hi}</td>
  <td class="num">${s.relief} m</td>
  <td class="num">${s.maxLiftPx} px</td>
  <td class="num">${g.n || 0}</td>
  <td class="num small">${gapTxt}</td>
</tr>`;
}).join("\n") || `<tr><td colspan="6" class="small">未烘焙样张（先跑 hubei-stardew.mjs）</td></tr>`;

const lodRows = LOD.map((l) => `<tr>
  <td class="id">${l.id}</td><td class="num">${l.cellM} m</td>
  <td class="num">${l.span}</td><td>${l.note}</td>
</tr>`).join("\n");

// 侧壁剖面：按真实像素画，再放大 6×
const ZOOM = 6;
const faceSeq = [];
faceSeq.push({ h: 1, c: "#ffffff", label: "唇边 1px（草皮断面）" });
faceSeq.push({ h: 1, c: "#8a6a4a", label: "草根 1px" });
for (let i = 0; i < 12; i++) faceSeq.push({ h: 1, c: i % 3 === 0 ? "#7a5a3c" : "#8a6a4a", label: "" });
faceSeq.push({ h: 1, c: "#4a3524", label: "脚影 1px" });
const Z = 9;                 // 剖面放大倍数
const FX = 70, FY = 96;      // 崖壁在 SVG 中的左上角
const SECT = `<svg viewBox="0 0 470 300" width="100%" style="display:block">
  <defs>
    <linearGradient id="proj" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1d2418" stop-opacity=".92"/>
      <stop offset="1" stop-color="#1d2418" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <!-- 上侧台面 -->
  <rect x="${FX}" y="${FY - 34}" width="${16 * Z}" height="34" fill="#7fb069"/>
  <rect x="${FX}" y="${FY - 34}" width="${16 * Z}" height="6" fill="#8fbf77"/>
  <!-- 崖壁 16px -->
  <rect x="${FX}" y="${FY}" width="${16 * Z}" height="${16 * Z}" fill="#8a6a4a"/>
  <rect x="${FX}" y="${FY}" width="${16 * Z}" height="${Z}" fill="#f2f2e0"/>
  <rect x="${FX}" y="${FY + Z}" width="${16 * Z}" height="${Z}" fill="#9b7f56"/>
  ${[3, 6, 9, 12, 15].map((r) => `<rect x="${FX}" y="${FY + r * Z}" width="${16 * Z}" height="2" fill="#74563a"/>`).join("")}
  <rect x="${FX}" y="${FY + 15 * Z}" width="${16 * Z}" height="${Z}" fill="#4a3524"/>
  <!-- 下侧台面 + 投影 -->
  <rect x="${FX}" y="${FY + 16 * Z}" width="${16 * Z}" height="60" fill="#6fa05a"/>
  <rect x="${FX}" y="${FY + 16 * Z}" width="${16 * Z}" height="46" fill="url(#proj)"/>
  <!-- 标注 -->
  <g stroke="#8d9a7f" stroke-width="1" fill="none">
    <path d="M${FX + 16 * Z + 6},${FY + Z / 2} H${FX + 16 * Z + 34}"/>
    <path d="M${FX + 16 * Z + 6},${FY + 2 * Z} H${FX + 16 * Z + 34}"/>
    <path d="M${FX + 16 * Z + 6},${FY + 7 * Z} H${FX + 16 * Z + 34}"/>
    <path d="M${FX + 16 * Z + 6},${FY + 15 * Z} H${FX + 16 * Z + 34}"/>
    <path d="M${FX + 16 * Z + 6},${FY + 22 * Z} H${FX + 16 * Z + 34}"/>
  </g>
  <g fill="#dbe4cf" font-size="12" font-family="Microsoft YaHei">
    <text x="${FX + 16 * Z + 40}" y="${FY + Z / 2 + 4}">唇边 1px · 草皮断面（提亮 30%）</text>
    <text x="${FX + 16 * Z + 40}" y="${FY + 2 * Z + 4}">草根 1px · 草色与土色 62% 混合</text>
    <text x="${FX + 16 * Z + 40}" y="${FY + 7 * Z + 4}">土体 12px · 每 3px 一条土层暗纹</text>
    <text x="${FX + 16 * Z + 40}" y="${FY + 15 * Z + 4}">脚影 1px · 土色 ×0.60</text>
    <text x="${FX + 16 * Z + 40}" y="${FY + 22 * Z + 4}">投影 ≤14px · k 0.56 → 0.90</text>
  </g>
  <text x="${FX}" y="${FY - 46}" fill="#c8a165" font-size="12" font-family="Microsoft YaHei">上侧台面</text>
  <text x="${FX}" y="${FY + 16 * Z + 78}" fill="#8d9a7f" font-size="11" font-family="Microsoft YaHei">崖下台面（被投影压暗）</text>
  <text x="${FX - 8}" y="${FY + 8 * Z}" fill="#c8a165" font-size="12" text-anchor="end" font-family="Microsoft YaHei">16 px</text>
  <text x="${FX - 8}" y="${FY + 8 * Z + 16}" fill="#8d9a7f" font-size="11" text-anchor="end" font-family="Microsoft YaHei">=${STEP_M} m</text>
</svg>`;

const slices = [
  ["shennongjia", "神农架东麓 · 1940 m", "高山针叶，坡陡、阶距短"],
  ["wushan", "巫山余脉 · 878 m", "中山，典型阶梯坡"],
  ["tongbai", "桐柏山前 · 294 m", "丘陵，缓坡宽踏步"],
  ["pingyuan", "江汉平原北缘 · 58 m", "平原，无台阶，仅水面与田块"]
].map(([k, t, d]) => `<figure>
  <img src="hubei-stardew-l0-${k}.png" alt="${t}">
  <figcaption><b>${t}</b><span>${d}</span></figcaption>
</figure>`).join("");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>湖北省 · 星露谷式高度分层规格</title>
<style>
  :root {
    --bg:#12150f; --panel:#1a1f16; --panel2:#222a1d; --line:#2f3a28;
    --fg:#dbe4cf; --dim:#8d9a7f; --accent:#c8a165; --accent2:#7fb069;
    --soil:#b8865a;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.7 "Microsoft YaHei", system-ui, sans-serif; }
  .wrap { max-width:1180px; margin:0 auto; padding:36px 24px 80px; }
  h1 { font-size:26px; margin:0 0 6px; letter-spacing:.5px; }
  h2 { font-size:17px; margin:44px 0 14px; padding-left:10px;
       border-left:3px solid var(--accent); }
  h3 { font-size:14px; color:var(--accent); margin:26px 0 10px; font-weight:600; }
  .sub { color:var(--dim); margin:0 0 28px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .k { color:var(--dim); font-size:12px; }
  .card .v { font-size:20px; font-weight:600; color:var(--accent); margin-top:2px; }
  .card .u { font-size:12px; color:var(--dim); }
  table { width:100%; border-collapse:collapse; margin-top:8px; font-size:13px; }
  th { text-align:left; color:var(--dim); font-weight:500; font-size:12px;
       border-bottom:1px solid var(--line); padding:8px 10px; }
  td { padding:7px 10px; border-bottom:1px solid rgba(47,58,40,.55); vertical-align:middle; }
  tr:hover td { background:rgba(127,176,105,.05); }
  .num { font-variant-numeric:tabular-nums; }
  .small { font-size:11px; color:var(--dim); }
  .id { color:var(--dim); font-size:12px; }
  .sw { display:inline-block; width:12px; height:12px; border-radius:3px;
        margin-right:7px; vertical-align:-1px; box-shadow:0 0 0 1px rgba(0,0,0,.45); }
  code { font-family:ui-monospace,Consolas,monospace; font-size:11px; color:var(--dim); }
  .bar { display:inline-block; width:120px; height:6px; background:#0d100b;
         border-radius:3px; overflow:hidden; vertical-align:middle; margin-right:8px; }
  .bar i { display:block; height:100%; background:linear-gradient(90deg,#5e8c4f,#a8c86a); }
  .split { display:grid; grid-template-columns:1.15fr .85fr; gap:26px; align-items:start; }
  .sec { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px; }
  .sec-row { position:relative; border-radius:1px; }
  .sec-row span { position:absolute; left:calc(100% + 14px); top:50%;
                  transform:translateY(-50%); white-space:nowrap; font-size:11px; color:var(--fg); }
  .note { background:rgba(200,161,101,.08); border-left:3px solid var(--accent);
          padding:12px 16px; border-radius:0 8px 8px 0; color:#e6ecdc; font-size:13px; }
  .gal { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:14px; }
  figure { margin:0; background:var(--panel); border:1px solid var(--line);
           border-radius:10px; overflow:hidden; }
  figure img { display:block; width:100%; image-rendering:pixelated; }
  figcaption { padding:9px 12px; font-size:12px; display:flex; gap:10px; flex-wrap:wrap; }
  figcaption span { color:var(--dim); }
  .poster img { width:100%; display:block; border-radius:10px; border:1px solid var(--line); }
  ul { padding-left:20px; color:#c3cdb6; }
  li { margin:5px 0; }
  b.hl { color:var(--accent); }
</style>
</head>
<body>
<div class="wrap">

  <h1>湖北省 · 星露谷式高度分层规格</h1>
  <p class="sub">2 m / 格 基准 · 一格一崖 · 露土分界 —— 本页由 <code>stardew-spec.mjs</code> 直接生成，与烘焙代码同源</p>

  <h2>1 比例与标尺</h2>
  <div class="cards">
    <div class="card"><div class="k">格距</div><div class="v">2 m</div><div class="u">16 px / 格 · 1 px = 0.125 m</div></div>
    <div class="card"><div class="k">台阶高差</div><div class="v">${STEP_M} m</div><div class="u">一级台地 = 一段高程带</div></div>
    <div class="card"><div class="k">台阶抬升</div><div class="v">${MICRO_LIFT_PX} px</div><div class="u">= ${(MICRO_LIFT_PX / TILE_PX).toFixed(1)} 整格</div></div>
    <div class="card"><div class="k">垂直压缩</div><div class="v">${compress.toFixed(1)}×</div><div class="u">1:1 应为 ${truePx} px</div></div>
    <div class="card"><div class="k">全省格数（L0）</div><div class="v">898 亿</div><div class="u">374,250 × 240,000</div></div>
    <div class="card"><div class="k">层带数</div><div class="v">${TIERS.length}</div><div class="u">T0 水面 + ${MAX_TIER} 级陆地</div></div>
  </div>

  <div class="note" style="margin-top:18px">
    <b class="hl">为什么不是 1:1：</b>8 m 高差按 1:1 应占 ${truePx} px。
    但一个 80 格（160 m）的视口里只有 25–40 m 落差，1:1 会得到 12–20 级台阶，
    屏幕上全是等高线。压到 ${MICRO_LIFT_PX} px 后，同一视口只剩 3–5 级台地，
    正好是星露谷一个屏幕的层次密度。这个压缩比是<b class="hl">制图约定</b>，写死在规格里，不随地形变。
  </div>

  <h2>2 层带表（宏观配色 / 全省图例）</h2>
  <table>
    <thead><tr><th>层</th><th>名称</th><th>高程区间 (m)</th><th>层厚</th><th>露土色（分界线）</th><th>占陆域面积</th></tr></thead>
    <tbody>${tierRows}</tbody>
  </table>
  <p class="small" style="margin-top:10px">
    层带只管<b>配色与图例</b>，不直接决定台阶：层厚 7–700 m 不等，一个 160 m 视口跨不过去。
    真正画出台阶的是下面这套固定步长。
  </p>

  <h2>3 台阶与崖壁剖面</h2>
  <div class="split">
    <div>
      <table>
        <thead><tr><th>部位</th><th>像素</th><th>作用</th></tr></thead>
        <tbody>
          <tr><td>唇边</td><td class="num">1 px</td><td>草皮断面，提亮 30%，是台地的"边界线"</td></tr>
          <tr><td>草根</td><td class="num">1 px</td><td>草色与土色 62% 混合，避免草直接切土</td></tr>
          <tr><td>土体</td><td class="num">12 px</td><td>心土色，每 3 px 压一条暗纹（土层）</td></tr>
          <tr><td>脚影</td><td class="num">1 px</td><td>土色 × 0.60，崖脚收边</td></tr>
          <tr><td>投影</td><td class="num">≤14 px</td><td>下方台面渐隐，k 从 0.56 → 0.90</td></tr>
        </tbody>
      </table>
      <p class="small" style="margin-top:12px">
        只画朝南（+y）的崖面：3/4 俯视看不到东/西侧面；东西向落差用 2 px 土色侧棱带过，
        否则 45° 台阶上的崖壁会断成一节节方块，整条崖线读成虚线。
      </p>
    </div>
    <div class="sec">${SECT}</div>
  </div>

  <h2>4 坡度衔接（台阶密度）</h2>
  <table>
    <thead><tr><th>坡度级</th><th>梯度区间 (m/m)</th><th>代表 g</th><th>相邻两级台阶水平间距</th><th>一屏 80 格可见级数</th><th>读数</th></tr></thead>
    <tbody>${slopeRows}</tbody>
  </table>
  <div class="note" style="margin-top:14px">
    <b class="hl">坡不是"摊薄一级落差"，而是"把多级台阶排密"。</b>
    单级落差恒为 ${MICRO_LIFT_PX} px、恒占 1 格宽。若把 ${MICRO_LIFT_PX} px 摊到 3 格（5.3 px/行），行高非整数，一上屏就被抗锯齿糊成渐变；
    摊成半级（8 px）则会把一堵崖拆成两段虚线。所以坡度只控制<b>相邻两级的间距</b>：
    <code>run = STEP_M / (g · GRID_M) = 4 / g</code> 格。
    g=0.10 → 40 格一级（缓）；g=0.40 → 10 格一级（中）；g=0.70 → 5.7 格一级（陡）；g&gt;1 → 间距不足 4 格，多级挤成一堵直壁。
  </div>
  <p class="small" style="margin-top:10px">
    崖线外侧另染 2 格土色（合计 3–5 格宽），这是"斜"的颜色读法；
    <code>softenR</code> 只让崖线在相邻 0–2 格内错位、去掉刀切边，不改变任何一级的落差。
  </p>

  <h2>5 LOD 阶梯</h2>
  <table>
    <thead><tr><th>级</th><th>格距</th><th>全省格数</th><th>用途</th></tr></thead>
    <tbody>${lodRows}</tbody>
  </table>
  <p class="small" style="margin-top:10px">
    L0 是<b>玩家尺度基准</b>，只流式加载村落周边，不烘焙；L4 才是"一张全省图"。
  </p>

  <h2>6 全省图（L4 · 500 m/格 · 2 px/格）</h2>
  <div class="poster"><img src="hubei-stardew.png" alt="湖北省分层地形图"></div>
  <p class="small" style="margin-top:10px">
    全省 748.5 × 480 km，2 m/格 是 898 亿格，没有任何机器能一次烤出来，所以这张是 L4 降采样：
    500 m/格。层带、配色、露土分界规则与 L0 <b>完全同源</b>，只有抬升按制图压缩——
    每个层带抬 ${(LIFT_TILE * 2).toFixed(1)} px（${LIFT_TILE} 格 × 2 px/格），${MAX_TIER} 级合计 ${(MAX_TIER * LIFT_TILE * 2).toFixed(0)} px。
    若沿用 L0 的 ${MICRO_LIFT_PX} px/级，全省会堆成 ${MAX_TIER * MICRO_LIFT_PX} px 高的千层饼，版面上再没有地形可言。
    <b class="hl">"2 m/格 + 16 px 一级"只在 L0 成立</b>，看局部请对照下一节的样张。
  </p>

  <h2>7 L0 样张（2 m/格 · 80 格视口 = 160 m）</h2>
  <div class="gal">${slices}</div>

  <h2>8 实测校验</h2>
  <p class="small">下面这些数字不是规格表里抄的，是烘焙完直接遍历 <code>lift</code> 场统计出来的：逐列找"抬升发生变化"的行，量相邻两次换级的距离。它用来证明规格表没有和渲染脱节。</p>
  <table>
    <thead><tr><th>样张</th><th>高程 (m)</th><th>高差</th><th>最大抬升</th><th>换级处数</th><th>相邻两级间距（格）</th></tr></thead>
    <tbody>${sampleRows}</tbody>
  </table>
  <p class="small" style="margin-top:10px">
    间距 25–44 格（神农架、巫山）= 每 50–88 m 水平升一级，属于缓坡档；
    桐柏山前中位 11 格，是丘陵密集台阶；江汉平原整片同一级，一屏之内不换级。
    偶尔出现 1 格（如巫山），是真实陡坎：两级台阶紧邻，合起来就是一堵 32 px 直壁——这是地形本身陡，不是衔接失败。
  </p>

</div>
</body>
</html>`;

fs.writeFileSync(OUT, html);
console.log(`[legend] → ${path.relative(SIM, OUT)}  (${(html.length / 1024).toFixed(0)} KB)`);
