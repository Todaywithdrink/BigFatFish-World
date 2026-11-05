// 把一段历史原样重跑一遍。
//
// 用法：
//   1) 从跑着的世界导出黑匣子：
//        curl -H "authorization: Bearer $(cat data/admin.key)" \
//             http://127.0.0.1:8090/api/admin/journal > /tmp/journal.json
//   2) 离线重跑：
//        node tools/replay.mjs /tmp/journal.json
//
// 它能成立，靠的是两件事：tick 是确定的（同一个种子 + 同一串输入 → 同一个世界），
// 以及动作流水记的是"输入"而不是"结果"。所以这个工具除了抓 bug，还能回答
// "如果那天老鲤没有把鱼卖给团子，村子会变成什么样" —— 改一个动作重跑就行。
//
// 这也是世界蓝皮书里"白纸演化"真正需要的东西：不是看它长成什么样，
// 而是能对着同一个起点，比较不同经历长出的不同结果。

import fs from "node:fs";
import { GameMap } from "../src/map.mjs";
import { World } from "../src/world.mjs";
import { loadSave } from "../src/persist.mjs";
import { worldState, worldHash, firstDifference } from "../src/fingerprint.mjs";

const file = process.argv[2];
if (!file) {
  console.error("用法: node tools/replay.mjs <journal.json> [--verbose]");
  process.exit(2);
}

const journal = JSON.parse(fs.readFileSync(file, "utf8"));
if (!journal.start) {
  console.error("这份日志里没有开局快照（start），没法从头重跑。");
  process.exit(2);
}
if (journal.overflow) {
  console.warn("⚠ 记录时流水超过上限，后半段动作没记下来——这次回放注定对不上。\n");
}

const verbose = process.argv.includes("--verbose");

// 起点：地图 + 存档 + 种子，全部来自黑匣子本身，不依赖当前磁盘上的世界
const map = new GameMap(journal.start.map);
const world = new World(map, { seed: journal.seed });
loadSave(world, journal.start.state, { quiet: true });

const startHash = worldHash(world);
console.log("起点  tick " + world.tickCount + "  hash " + startHash + "  " + world.entities.size + " 条鱼");
console.log("终点  tick " + journal.tick + "  hash " + (journal.hash || "(未记录)"));
console.log("动作  " + journal.actions.length + " 条\n");

// 按 tick 重放。顺序是关键：动作先落、再走下一步。
// 真实世界里，一条 t=T 的动作发生在"第 T 步已走完、第 T+1 步还没走"的间隙；
// 回放如果先 step() 再喂动作，落在开局快照同一 tick 的动作（比如服务刚起就
// 进来的注册）会被整整推后一步——少耗一体力、晚生一秒，hash 当场对不上。
// 这个竞态在 journal-test 里是偶发的：注册恰好赶在第一步之前就炸，晚一步就绿。
const acts = journal.actions;
let i = 0, applied = 0, rejected = 0;
const startedAt = Date.now();

while (world.tickCount < journal.tick) {
  while (i < acts.length && acts[i].t <= world.tickCount) {
    const r = world.applyJournalEntry(acts[i++]);
    if (r && r.ok) applied++;
    else {
      rejected++;
      if (verbose) console.log("  拒绝 @" + acts[i - 1].t + " " + acts[i - 1].who + " " + JSON.stringify(acts[i - 1].act) + " → " + (r && r.reason));
    }
  }
  world.step();
}
// 落在最后一 tick 上的动作
while (i < acts.length) {
  const r = world.applyJournalEntry(acts[i++]);
  if (r && r.ok) applied++; else rejected++;
}

const ms = Date.now() - startedAt;
const hash = worldHash(world);

console.log("重跑完成  " + (ms / 1000).toFixed(2) + "s  (" + Math.round(journal.tick / Math.max(1, ms / 1000)) + " tick/s)");
console.log("动作  " + applied + " 条生效 / " + rejected + " 条被拒（被拒是正常的：冷却、距离、库存都在变）");
console.log("结果  hash " + hash);

if (!journal.hash) {
  console.log("\n日志没带终点 hash，只输出结果，无法自动比对。");
  process.exit(0);
}

if (hash === journal.hash) {
  console.log("\n✓ 完全一致：这段历史是确定的，可以放心拿它做对比实验。");
  process.exit(0);
}

console.log("\n✗ 对不上。这段历史里有东西不受 tick 与输入决定。\n");

if (journal.endState) {
  const expected = new World(new GameMap(journal.start.map), { seed: journal.seed });
  loadSave(expected, journal.endState, { quiet: true });
  const diff = firstDifference(worldState(expected), worldState(world));
  console.log("第一处分歧：");
  if (diff) {
    console.log("  字段  " + diff.field + (diff.index != null ? "[" + diff.index + "]" : ""));
    console.log("  当时  " + JSON.stringify(diff.mine));     // 黑匣子里的终点状态
    console.log("  重跑  " + JSON.stringify(diff.theirs));   // 这次算出来的
  } else {
    console.log("  （状态一致但 hash 不同，说明是序列化顺序的问题，不是世界本身）");
  }
} else {
  console.log("日志没带终点状态，只能报 hash。");
}

console.log("\n可能的原因，按概率排：");
console.log("  1. 有代码在 tick 之外读取了墙钟（Date.now / new Date）并影响了状态");
console.log("  2. 有异步回调（LLM、文件、定时器）在 tick 之间改了世界，顺序不稳定");
console.log("  3. 流水超上限被截断，或记录期间有人用 admin 接口直接改了世界");
process.exit(1);
