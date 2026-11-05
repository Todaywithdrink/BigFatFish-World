// 行为探针：让本地 NPC 在无头世界里自己跑一段时间，看它是否
//   - 不用寻路也能走起来（撞了就绕）
//   - 走过草地会留下土路
// 用法：node tools/brain-probe.mjs [秒数]
import { GameMap } from "../src/map.mjs";
import { World } from "../src/world.mjs";
import { Mind } from "../agents/brain.mjs";

const SECONDS = Number(process.argv[2] || 120);
const map = GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const world = new World(map);

// 从一片草地起步：村中心是石板路，踩不出土路
let gx = 32, gy = 40;
outer:
for (let y = 30; y < 50; y++) {
  for (let x = 20; x < 46; x++) {
    const t = map.tile(x, y);
    if (t && t.kind === "grass") { gx = x; gy = y; break outer; }
  }
}

const v = world.spawn({ name: "测试鱼", role: "wanderer", home: { x: gx, y: gy } });
v.x = gx + 0.5;
v.y = gy + 0.5;
v.tileX = gx;
v.tileY = gy;
v.explored = new Set();
for (let dy = -4; dy <= 4; dy++) {
  for (let dx = -4; dx <= 4; dx++) v.explored.add((gx + dx) + "," + (gy + dy));
}

const mind = new Mind(world, v);
const start = { x: v.x, y: v.y };
let walkingTicks = 0, departures = 0, stuckTicks = 0;

for (let t = 0; t < SECONDS * 10; t++) {
  world.step();
  if (t % 10 === 0) {
    const hadPath = v.path.length > 0;
    mind.update().catch(() => {});
    if (!hadPath && v.path.length) departures++;
  }
  if (v.state === "walking") walkingTicks++;
  if (mind.stuck > 0) stuckTicks++;
}

let paved = 0;
for (const kind of world.patches.values()) if (kind === "path") paved++;

const dist = Math.hypot(v.x - start.x, v.y - start.y);
console.log("起点 → 终点   " + start.x.toFixed(1) + "," + start.y.toFixed(1) + " → " + v.x.toFixed(1) + "," + v.y.toFixed(1));
console.log("直线位移      " + dist.toFixed(1) + " 格");
console.log("出发次数      " + departures);
console.log("行走 tick     " + walkingTicks + " / " + SECONDS * 10);
console.log("卡住 tick     " + stuckTicks);
console.log("踩出的土路    " + paved + " 格");
console.log("已探索        " + v.explored.size + " 格");

const checks = [
  [dist > 3, "NPC 确实走动了"],
  [paved > 0, "草地被踩成了路"],
  [v.explored.size >= 81, "探索范围没有退化"],
  [Number.isFinite(v.x) && Number.isFinite(v.y), "坐标没有 NaN"]
];
let fail = 0;
for (const [c, m] of checks) {
  console.log((c ? "  ok   " : "  FAIL ") + m);
  if (!c) fail++;
}
console.log(fail ? "\n" + fail + " 项未通过" : "\n全部通过");
process.exitCode = fail ? 1 : 0;
