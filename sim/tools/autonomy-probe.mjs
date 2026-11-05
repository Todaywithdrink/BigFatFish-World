// 自主性探针：让一村人在无头世界里自己过几天，看他们到底有没有"活"。
//
// 检查的不是"有没有走起来"，而是：
//   - 有没有自己找到吃的（不是靠脚本喂）
//   - 目标会不会换（而不是一条链跑到底）
//   - 经历有没有改变性格
//   - 会不会自己盖房、自己成镇
//   - 同样的种子跑两遍，世界是不是同一个（自主决策也要可回放）
//
// 用法：node tools/autonomy-probe.mjs [天数] [人数]
import { GameMap } from "../src/map.mjs";
import { World } from "../src/world.mjs";
import { spawnCast } from "../src/cast.mjs";
import { attachBrains } from "../agents/brain.mjs";
import { worldHash } from "../src/fingerprint.mjs";
import { readFileSync } from "node:fs";

const DAYS = Math.max(1, Math.min(10, Number(process.argv[2] || 1)));
const COUNT = Math.max(1, Math.min(8, Number(process.argv[3] || 4)));
const TICKS = DAYS * 12000;

const MAP_FILE = new URL("../data/world-map.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function build(seed) {
  const map = GameMap.load(MAP_FILE);
  const world = new World(map, { seed, hearth: true });
  spawnCast(world, map, COUNT);
  const brains = attachBrains(world, { timer: false });
  return { world, map, brains };
}

function run(seed, days) {
  const { world, brains } = build(seed);
  const goalKinds = new Map();
  const startTraits = new Map();
  for (const [id, m] of brains.minds) startTraits.set(id, { ...m.bb.traits });

  for (let t = 0; t < days * 12000; t++) {
    world.step();
    brains.tick();
    for (const [id, m] of brains.minds) {
      const k = m.bb.lastAdopted && m.bb.lastAdopted.kind;
      if (k && !goalKinds.has(k)) goalKinds.set(k, { tick: world.tickCount, by: m.v.name });
    }
  }
  const rows = [];
  for (const [id, m] of brains.minds) {
    const v = world.entities.get(id);
    const s = m.bb.mem.stats;
    const drift = Object.keys(m.bb.traits)
      .map((k) => Math.abs(m.bb.traits[k] - ((startTraits.get(id) || {})[k] ?? m.bb.traits[k])))
      .reduce((a, b) => a + b, 0);
    rows.push({
      name: v ? v.name : id, alive: !!v && v.state !== "dead",
      state: v ? v.state : "-",
      meals: s.meals || 0, catches: s.catches || 0, chops: s.chops || 0,
      houses: s.houses || 0, talks: s.talks || 0,
      hunger: v ? Math.round(v.needs.hunger) : 0,
      energy: v ? Math.round(v.needs.energy) : 0,
      explored: v && v.explored ? v.explored.size : 0,
      traitDrift: Math.round(drift * 10) / 10,
      goals: m.bb.goals.map((g) => g.label).join("/") || "-",
      thought: m.bb.thought || "-"
    });
  }
  return { world, rows, goalKinds, hash: worldHash(world) };
}

console.log("世界：" + DAYS + " 游戏日 × " + COUNT + " 人");
const a = run(7, DAYS);

console.log("\n居民状态");
for (const r of a.rows) {
  console.log(
    "  " + r.name.padEnd(4, "　") +
    " 活:" + (r.alive ? "是" : "否") +
    " 状态:" + r.state +
    " 吃饭:" + r.meals +
    " 钓鱼:" + r.catches +
    " 砍树:" + r.chops +
    " 盖房:" + r.houses +
    " 说话:" + r.talks +
    " 探索:" + r.explored +
    " 饥饿:" + r.hunger +
    " 精力:" + r.energy +
    " 性格漂移:" + r.traitDrift
  );
  console.log("       此刻：" + r.thought + "    目标：" + r.goals);
}

console.log("\n出现过的目标种类（" + a.goalKinds.size + "）");
for (const [k, v] of a.goalKinds) console.log("  " + k + "  首次 @" + v.tick + " tick (" + v.by + ")");

const built = a.rows.reduce((n, r) => n + r.houses, 0);
const meals = a.rows.reduce((n, r) => n + r.meals, 0);
const drifts = a.rows.reduce((n, r) => n + r.traitDrift, 0);
const explored = a.rows.reduce((n, r) => n + r.explored, 0);
const settlements = a.world.settlements.size;

// 同一 seed 再跑一遍：自主决策如果掺了墙钟/外部随机，这里会当场分叉
const b = run(7, DAYS);

const checks = [
  [a.rows.every((r) => r.alive), "没有人在自己家里饿死"],
  [meals >= COUNT, "有人真的自己吃上饭了（共 " + meals + " 顿）"],
  [explored > COUNT * 200, "有人自己走出了家门（探索合计 " + explored + " 格）"],
  [a.goalKinds.size >= 5, "目标不是一条写死的链（" + a.goalKinds.size + " 种）"],
  [drifts > 0.2, "经历改变了性格（漂移合计 " + drifts + "）"],
  [built >= 1 || settlements > 0, "有人自己盖了房（" + built + " 栋 / 聚落 " + settlements + "）"],
  [a.rows.every((r) => r.hunger >= 0 && r.energy >= 0), "需求值没有 NaN"],
  [a.hash === b.hash, "同种子双跑，世界完全一致（" + a.hash + "）"]
];

console.log("");
let fail = 0;
for (const [ok, msg] of checks) {
  console.log((ok ? "  ok   " : "  FAIL ") + msg);
  if (!ok) fail++;
}
console.log(fail ? "\n" + fail + " 项未通过" : "\n全部通过");
process.exitCode = fail ? 1 : 0;
