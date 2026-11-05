// 角色图集常量生成器（零依赖：只用 node 内置 fs）
// 目的：把"角色帧尺寸 / 朝向行号 / 走路帧数"从渲染代码里的魔法数字，变成角色图旁边自动生成的常量表。
//       美术换一张角色图 → 只需重跑本脚本，渲染代码零改动。
//
// 用法：node sim/tools/build-char.mjs
// 输入：sim/viewer/char.png（RGBA）
// 输出：sim/viewer/char.js
//
// 校验（不合规直接报错退出，把问题挡在美术交付环节而不是运行期）：
//   1. 图宽必须能被帧宽整除（否则帧会错位）
//   2. 每个朝向行必须完整落在图内（y + 帧高 ≤ 图高）
//   3. 帧高必须 ≥ 帧宽（角色应比地块高，否则大概率帧高填错）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWER = path.join(path.dirname(HERE), "viewer");
const CHAR_PNG = path.join(VIEWER, "char.png");

// ---------- 角色表规格（唯一真相源：改这里，然后重跑脚本） ----------
const SPEC = {
  frameW: 16,
  frameH: 22,
  // 每行的 y 起点（行名 → 像素 y）。走路循环为每行前 4 帧，右侧朝向用左侧镜像。
  rows: { down: 6, left: 38, up: 70 },
  walkFrames: 4,
  // 备用动作区（当前渲染器未使用，预留给攻击/工作/游泳）
  note: "walkFrames 为走路循环长度；右侧朝向由 left 行水平镜像得到，不单独占行"
};

function readPngSize(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG：" + file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
}

const { w, h, colorType } = readPngSize(CHAR_PNG);
if (colorType !== 6) throw new Error("char.png 必须是 RGBA（colorType 6），当前 " + colorType);

const errors = [];
if (w % SPEC.frameW !== 0) errors.push(`图宽 ${w} 不能被帧宽 ${SPEC.frameW} 整除`);
if (SPEC.frameH < SPEC.frameW) errors.push(`帧高 ${SPEC.frameH} 小于帧宽 ${SPEC.frameW}，疑似填错`);
for (const [name, y] of Object.entries(SPEC.rows)) {
  if (y < 0 || y + SPEC.frameH > h) errors.push(`朝向行 ${name}（y=${y}）超出图高 ${h}`);
  if (y % 1 !== 0) errors.push(`朝向行 ${name} 的 y 必须是整数`);
}
if (errors.length) {
  console.error("char.png 不合规：\n  - " + errors.join("\n  - "));
  process.exit(1);
}

const cols = w / SPEC.frameW;
if (cols < SPEC.walkFrames) {
  console.error(`图只有 ${cols} 列，少于走路帧数 ${SPEC.walkFrames}`);
  process.exit(1);
}

const js = `// 自动生成，勿手改：sim/tools/build-char.mjs
// 源：sim/viewer/char.png（${w}×${h}，${cols} 列 × ${SPEC.rows ? Object.keys(SPEC.rows).length : 0} 朝向行）
// 说明：${SPEC.note}
window.CHAR_SET = {
  img: "/viewer/char.png",
  frameW: ${SPEC.frameW},
  frameH: ${SPEC.frameH},
  cols: ${cols},
  walkFrames: ${SPEC.walkFrames},
  rows: ${JSON.stringify(SPEC.rows)},
  /** 朝向 → 行 y 起点（right 走 left 行镜像） */
  rowY: function (face) {
    if (face === "right") face = "left";
    return this.rows[face] != null ? this.rows[face] : this.rows.down;
  }
};
`;
fs.writeFileSync(path.join(VIEWER, "char.js"), js, "utf8");
console.log(`char.js 生成完成：${w}×${h}，帧 ${SPEC.frameW}×${SPEC.frameH}，${cols} 列，朝向 ${Object.keys(SPEC.rows).join("/")}，走路 ${SPEC.walkFrames} 帧`);
