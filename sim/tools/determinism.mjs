// 复现性测试：同一个种子 + 同一串动作 = 同一个世界。
//
// 这个测试存在的原因：`world.mjs` 顶部一直写着「确定性 tick」，但内核里散着
// Math.random，同一份存档跑两遍会长出两个世界，回放、对比实验、复现线上 bug
// 全部做不了。现在随机全部走 world.rng，所以这条必须成立，且以后一旦有人在
// 内核里偷偷用 Math.random，这里就会红。
//
// 跑法：node tools/determinism.mjs [ticks]

import { GameMap } from "../src/map.mjs";
import { World } from "../src/world.mjs";

const MAP = new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra ? "  " + extra : "")); }
};

function fresh(seed) {
  return new World(GameMap.load(MAP), { seed });
}

/** 一串固定的动作，保证两次运行输入完全一致 */
function script(world) {
  const ids = [...world.entities.keys()];
  const acts = ["move", "forage", "fish", "build", "sew", "say", "rest"];
  return (t) => {
    for (const id of ids) {
      const v = world.entities.get(id);
      if (!v || v.state === "downed") continue;
      const kind = acts[(t + Number(String(id).slice(1))) % acts.length];
      if (kind === "move") {
        world.applyAction(v, { type: "move", dir: ["n", "s", "e", "w"][t % 4], tiles: 3 });
      } else if (kind === "build") {
        world.applyAction(v, { type: "build", x: v.tileX + 1, y: v.tileY, kind: t % 2 ? "flower" : "path" });
      } else if (kind === "sew") {
        world.applyAction(v, { type: "sew", pattern: t % 4 });
      } else if (kind === "say") {
        world.applyAction(v, { type: "say", text: "t" + t, private: t % 3 === 0 });
      } else {
        world.applyAction(v, { type: kind });
      }
    }
  };
}

/** 只比"世界状态"，不比时间戳之类的外围东西 */
function fingerprint(world) {
  const ents = [...world.entities.values()].map((v) => [
    v.id, v.name, v.uid, Math.round(v.x * 1000), Math.round(v.y * 1000), Math.round(v.dir * 1000),
    Math.round(v.hp * 100), Math.round(v.needs.energy * 100), Math.round(v.needs.hunger * 100),
    v.coins, v.talent, JSON.stringify(v.inventory), v.state,
    JSON.stringify(v.appearance || null), v.explored.size
  ]);
  return JSON.stringify({
    tick: world.tickCount,
    clock: world.clock,
    rng: world.rngState(),
    ents,
    patches: [...world.patches.entries()].sort(),
    pairs: [...world.pairs.entries()].sort()
  });
}

const TICKS = Math.max(200, Number(process.argv[2]) || 1200);

console.log("[1] 同种子跑两遍，逐 tick 比对");
{
  const a = fresh(20261104), b = fresh(20261104);
  const seedVillagers = (w) => {
    for (const [name, role] of [["甲", "fisher"], ["乙", "cook"], ["丙", "farmer"]]) w.spawn({ name, role });
  };
  seedVillagers(a); seedVillagers(b);
  ok(fingerprint(a) === fingerprint(b), "初始世界一致（uid、天赋也一样）");

  let divergedAt = -1;
  for (let t = 0; t < TICKS; t++) {
    a.step(); b.step();
    if (divergedAt < 0 && fingerprint(a) !== fingerprint(b)) divergedAt = t;
  }
  ok(divergedAt < 0, TICKS + " tick 后完全一致", divergedAt >= 0 ? "首个分歧 tick=" + divergedAt : "");
  ok(a.rngState() === b.rngState(), "随机流推进到同一位置");
}

console.log("\n[2] 不同种子应该长出不同的世界（否则随机源没生效）");
{
  const a = fresh(1), b = fresh(2);
  for (const w of [a, b]) for (const [name, role] of [["甲", "fisher"], ["乙", "cook"]]) w.spawn({ name, role });
  ok(fingerprint(a) !== fingerprint(b), "不同种子 → 不同 uid/天赋");
}

console.log("\n[3] 存档往返：存下来读回去，再跑一遍必须一模一样");
{
  const a = fresh(424242);
  for (const [name, role] of [["甲", "fisher"], ["乙", "cook"], ["丙", "wanderer"]]) a.spawn({ name, role });
  const act = script(a);
  for (let t = 0; t < 400; t++) { act(t); a.step(); }

  // 直接走真实存档：手写一份"简化存档"看着更干净，但漏掉任何字段
  // （路径、冷却、建造 CD）都会让这条测试变成假绿。用线上那一份代码才作数。
  const { serializeWorld, loadSave } = await import("../src/persist.mjs");
  const save = serializeWorld(a);

  const b = new World(GameMap.load(MAP), { seed: save.seed });
  const loaded = loadSave(b, save, { quiet: true });
  ok(loaded, "存档能装回去");

  ok(fingerprint(a) === fingerprint(b), "读档瞬间状态一致");

  const actB = script(b);
  for (let t = 0; t < 300; t++) { act(t); a.step(); actB(t); b.step(); }
  ok(fingerprint(a) === fingerprint(b), "读档后继续 300 tick 仍一致（随机流接得上）");
}

console.log("\n[4] 内核里不该再有裸随机");
{
  // 这条是给未来的自己看的：如果有人在 world/brain 里写 Math.random，这里会提醒。
  const { readFileSync } = await import("node:fs");
  for (const f of ["../src/world.mjs", "../agents/brain.mjs"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    const hits = src.split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([_, line]) => /Math\.random/.test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line));
    ok(hits.length === 0, f.replace("../", "") + " 无裸 Math.random", hits.length ? "行 " + hits.map(([n]) => n).join(",") : "");
  }
}

console.log("\n" + pass + " passed / " + fail + " failed");
process.exit(fail ? 1 : 0);
