// 随机打动作：找崩溃、NaN、越界和状态腐坏
// 用法：node tools/fuzz.mjs [轮数] [种子]
import { GameMap } from "../src/map.mjs";
import { World } from "../src/world.mjs";
import { ensureChest } from "../src/props.mjs";

const ROUNDS = Number(process.argv[2] || 3000);
const SEED = Number(process.argv[3] || 12345);

let s = SEED >>> 0;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const map = GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const world = new World(map);
ensureChest(world); // 没有箱子，存取这条链在 fuzz 里永远是断的

const folk = [];
for (let i = 0; i < 6; i++) {
  const v = world.spawn({ name: "f" + i, role: pick(["fisher", "farmer", "cook", "wanderer"]), home: { x: 32 + i, y: 36 } });
  v.x = 32 + i + 0.5; v.y = 36.5; v.tileX = 32 + i; v.tileY = 36;
  v.coins = 50;
  folk.push(v);
}
world.tickCount = 1000;

const ITEM_IDS = ["wood", "plank", "fish", "crop", "dish", "cloth", "flower", "ore"];
const ACTIONS = [
  () => ({ type: "move", dir: pick(["n", "s", "e", "w", "left", "up", "zzz", "", null, 3]), tiles: pick([1, 2, 30, -5, 1e9, "x", null]) }),
  () => ({ type: "moveTo", x: pick([10, 30, NaN, 1e9, "a"]), y: pick([10, 30, NaN, -1e9]) }),
  () => ({ type: "say", text: pick(["你好", "", null, "x".repeat(500), "😀".repeat(50)]), to: pick([null, ...folk.map((f) => f.id), "nobody"]), private: pick([true, false, 1, "yes"]) }),
  () => ({ type: "give", targetId: pick([...folk.map((f) => f.id), "nobody"]), item: pick([...ITEM_IDS, "gold", "", null]), count: pick([1, -5, 999, 0, NaN, 1e9]) }),
  () => ({ type: "quote", targetId: pick(folk.map((f) => f.id)), side: pick(["sell", "buy", "hack"]), item: pick([...ITEM_IDS, "gold"]), count: pick([1, -3, 999, NaN]), price: pick([0, 5, -100, 1e12, NaN]), want: pick([null, { item: "wood", count: 2 }, { item: "gold", count: 1 }]) }),
  () => ({ type: "accept", quoteId: pick(["q1", "q2", "q999", null]) }),
  () => ({ type: "decline", quoteId: pick(["q1", null]) }),
  () => ({ type: "attack", targetId: pick([...folk.map((f) => f.id), "nobody"]), intensity: pick([0, 0.5, 1, 5, -3, NaN]) }),
  () => ({ type: "build", x: pick([32, 33, NaN]), y: pick([36, 37, NaN]), kind: pick(["flower", "path", "wall", "", null]) }),
  () => ({ type: "remove", x: pick([32, 33, NaN]), y: pick([36, 37]) }),
  () => ({ type: "chop", x: pick([32, 33, NaN]), y: pick([36, 37]) }),
  () => ({ type: "fish" }), () => ({ type: "forage" }), () => ({ type: "eat" }),
  () => ({ type: "rest" }), () => ({ type: "stop" }), () => ({ type: "wait" }),
  () => ({ type: "cook", recipe: pick(["soup", "nope", null]) }),
  () => ({ type: "craft", recipe: pick(["plank", "nope", null]) }),
  () => ({ type: "interact", x: pick([32, 33, NaN]), y: pick([36, 37]) }),
  () => ({ type: "shareMap", targetId: pick([...folk.map((f) => f.id), "nobody"]) }),
  () => ({ type: "post", text: pick(["hi", "", null, "x".repeat(400)]) }),
  () => ({ type: "publish", kind: "auction", item: pick(ITEM_IDS), count: pick([1, 2]), price: pick([5, NaN]), seconds: pick([10, -5]) }),
  () => ({ type: "placeBid", protocolId: pick(["p1", null]), price: pick([5, NaN, -3]) }),
  () => ({ type: "closeAuction", protocolId: pick(["p1", null]) }),
  () => ({ type: "face", dir: pick([0, Math.PI, NaN, 1e9]) }),
  () => ({ type: "buildHouse", x: pick([30, 40]), y: pick([40, 45]) }),
  () => ({ type: "sew", hue: pick([0, 359, 1e9, NaN]), pattern: pick([0, 1, 2, 99]) }),
  () => ({ type: "nonsense", foo: 1 }),
  () => null
];

// 门 / 储物箱 / 锁也进常驻模糊测试：重点打「输入 → 判断 → 开关」三段里的脏参数。
// 凭证要能被推到摘要比对，坐标要能被推到距离校验，物品名要能撞上原型链。
const PROP_IDS = [...world.props.keys()];
const CHEST_ID = PROP_IDS.find((id) => id.startsWith("chest:")) || "";

function makePropAction(v) {
  const id = pick([...PROP_IDS, CHEST_ID, "", null, "nope:1,2", "__proto__", "constructor", NaN, {}, 1e9]);
  const prop = world.props.get(String(id));
  // 一半概率把操作者挪到物件旁，让 open / deposit / withdraw 的真实分支真的跑到，
  // 另一半留在原地，覆盖 too_far 的拒绝路径。
  if (prop && rnd() < 0.5) {
    v.x = prop.x + 0.5;
    v.y = prop.y + 0.5;
  }
  return {
    type: pick(["inspectProp", "open", "close", "lock", "unlock", "setLock", "deposit", "withdraw",
      "", null, "nonsense", 7]),
    id,
    x: pick([32, 33, NaN, null]),
    y: pick([36, 37, NaN, null]),
    kind: pick(["chest", "door", null]),
    mode: pick(["code", "key", "none", "hack", null]),
    newSecret: pick(["1234", "", null, "x".repeat(200), NaN, {}]),
    secret: pick(["1234", "", null]),
    credential: pick(["1234", null, { type: "code", value: "1234" }, { type: "key", value: "k1" }, NaN]),
    code: pick(["1234", "", null, NaN]),
    keyId: pick(["k1", "", null]),
    item: pick([...ITEM_IDS, "__proto__", "gold", "", null]),
    count: pick([1, 2, -5, 0, NaN, 1e9, "x"]),
    hint: pick(["", "test", "x".repeat(200)])
  };
}

const problems = [];
const seen = new Set();
const report = (kind, detail) => {
  const key = kind + "|" + detail;
  if (seen.has(key)) return;
  seen.add(key);
  problems.push(kind + ": " + detail);
};

for (let i = 0; i < ROUNDS; i++) {
  const v = pick(folk);
  const act = i % 5 === 0 ? makePropAction(v) : (pick(ACTIONS)() || {});
  try {
    world.applyAction(v, act);
  } catch (err) {
    report("throw", (act && act.type) + " → " + err.message);
  }
  if (i % 7 === 0) {
    try { world.step(); } catch (err) { report("step-throw", err.message); }
  }

  for (const e of world.entities.values()) {
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) report("nan-pos", e.name + " " + e.x + "," + e.y);
    if (!Number.isFinite(e.coins)) report("nan-coins", e.name + " " + e.coins);
    if (e.coins < 0) report("neg-coins", e.name + " " + e.coins);
    if (!Number.isFinite(e.hp) || e.hp < 0 || e.hp > e.maxHp) report("bad-hp", e.name + " " + e.hp);
    if (!Number.isFinite(e.needs.energy) || e.needs.energy < -1 || e.needs.energy > 101) report("bad-energy", e.name + " " + e.needs.energy);
    if (!Number.isFinite(e.dir)) report("nan-dir", e.name);
    for (const [id, n] of Object.entries(e.inventory || {})) {
      if (!Number.isFinite(n) || n < 0) report("bad-inv", e.name + " " + id + "=" + n);
    }
  }

  // 门 / 箱 / 锁被反复脏打之后，状态不能腐坏：开合与锁定必须是布尔，
  // 凭证只能是字符串摘要（不能变成对象 / NaN 泄漏），箱内数量必须有限非负。
  for (const p of world.props.values()) {
    if (typeof p.open !== "boolean") report("bad-prop-open", p.id + " " + p.open);
    if (!p.lock || typeof p.lock.locked !== "boolean") report("bad-prop-lock", p.id);
    if (p.lock && p.lock.secret != null && typeof p.lock.secret !== "string") {
      report("bad-prop-secret", p.id + " " + typeof p.lock.secret);
    }
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) report("bad-prop-pos", p.id);
    if (p.kind === "chest") {
      for (const [id, n] of Object.entries(p.items || {})) {
        if (!Number.isFinite(n) || n < 0) report("bad-chest-item", p.id + " " + id + "=" + n);
      }
    }
  }
}

console.log("轮数 " + ROUNDS + "，村民 " + folk.length + "，剩余实体 " + world.entities.size);
console.log("tick " + world.tickCount + "，报价 " + world.quotes.size + "，协议 " + world.protocols.size + "，补丁 " + world.patches.size);
if (!problems.length) {
  console.log("没有发现异常");
} else {
  console.log("\n发现 " + problems.length + " 类问题：");
  for (const p of problems) console.log("  - " + p);
}
process.exitCode = problems.length ? 1 : 0;
