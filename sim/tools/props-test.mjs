// 背包额度 / 可开关实体 / 上锁 专项自检
//   node tools/props-test.mjs
//
// 覆盖：三重额度分别卡住、满包不吞材料、门与地图物理同步、箱子存取、
// 密码/钥匙锁、输入→判断→开关三段轨迹、凭证不外泄、存档往返、同种子双跑。
import { GameMap } from "../src/map.mjs";
import { World } from "../src/world.mjs";
import { ITEMS, BAG_RULES, CHEST_RULES, bagUsage, bagFits, emptyInventory } from "../src/economy.mjs";
import { serializeWorld, loadSave } from "../src/persist.mjs";
import { worldHash } from "../src/fingerprint.mjs";
import { propId, publicProp, hashCredential } from "../src/props.mjs";

const MAP_FILE = new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let pass = 0, fail = 0;
const ok = (c, msg, extra) => {
  if (c) { pass++; console.log("  ok   " + msg); }
  else { fail++; console.log("  FAIL " + msg + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};
const fresh = () => new World(GameMap.load(MAP_FILE), { hearth: true, seed: 77 });
const findChest = (w) => {
  for (const p of w.props.values()) if (p.kind === "chest") return p;
  return null;
};
const findDoor = (w) => {
  for (const p of w.props.values()) if (p.kind === "door") return p;
  return null;
};

console.log("\n[1] 背包三重额度：格子 / 负重 / 单类");
{
  const w = fresh();
  const inv = emptyInventory();
  ok(bagUsage(inv).slots === 0 && bagUsage(inv).weight === 0, "空包占用为 0");
  ok(BAG_RULES.slots === 24 && BAG_RULES.maxWeight === 80, "额度常量可读（24 格 / 80 负重）");

  // 单类上限：木头 stack=50，6 格 = 300 个，301 就会被 kind_limit 卡住
  const overKind = bagFits(inv, { wood: 6 * ITEMS.wood.stack + 1 });
  ok(!overKind.ok && overKind.rule === "kind_limit", "单类物品超过 6 格被拒", overKind);
  const atKindLimit = bagFits(inv, { wood: 6 * ITEMS.wood.stack },
    { slots: 24, maxWeight: 99999, perKindSlots: 6 });
  ok(atKindLimit.ok, "刚好 6 格可以放下（把承重量隔离掉单测格位）");

  // 格子上限：把额度收窄到 5 格，多种物品各占 2 格必然溢出
  const many = {};
  for (const id of Object.keys(ITEMS)) many[id] = ITEMS[id].stack * 2;
  const overSlots = bagFits(inv, many, { slots: 5, maxWeight: 99999, perKindSlots: 99 });
  ok(!overSlots.ok && overSlots.rule === "slots", "超过背包格数被拒", overSlots);

  // 负重上限：6 格花盆只占 6 格，但 40 个 × 2.0 = 80
  const heavy = { flowerpot: ITEMS.flowerpot.stack * 4 };
  const overWeight = bagFits(inv, heavy, { slots: 999, maxWeight: 8, perKindSlots: 99 });
  ok(!overWeight.ok && overWeight.rule === "weight", "低承重时会卡在重量上", overWeight);

  // 满包时产出动作被拒，且背包原样不动
  const v = w.spawn({ name: "额度测试" });
  v.inventory = emptyInventory();
  v.inventory.flowerpot = ITEMS.flowerpot.stack * 6;
  w.map.setKind(Math.floor(v.x), Math.floor(v.y), "flower");  // 保证身边有可采的东西
  const before = v.inventory.flowerpot;
  const forage = w.applyAction(v, { type: "forage" });
  ok(forage.ok === false && forage.reason === "bag_full", "满包时采集被额度拒绝", forage);
  ok(v.inventory.flowerpot === before, "被拒后背包原样不动");
}

console.log("\n[2] 满包不吞材料：制作 / 做菜的净变化一次算清");
{
  const w = fresh();
  const v = w.spawn({ name: "木匠" });
  v.inventory = emptyInventory();
  v.inventory.wood = 2;
  // 造一个"包里刚好塞不下产出、但材料扣掉后本可以"的场景：背包塞满重物
  v.inventory.flowerpot = ITEMS.flowerpot.stack * 6;
  const r = w.applyAction(v, { type: "craft", recipe: "plank" });
  ok(r.ok === false && r.reason === "bag_full", "装不下时制作直接拒绝", r);
  ok(v.inventory.wood === 2, "拒绝后材料没有被吞掉");
  ok(v.cooldowns.craft === 0, "拒绝后也不吃冷却（键在 spawn 里已初始化）");
}

console.log("\n[3] 门：开关与地图物理状态同步，上锁后开不了");
{
  const w = fresh();
  const d = findDoor(w);
  ok(!!d, "地图上的门已登记成 prop");
  const id = d.id;
  const tile = () => w.map.tile(d.x, d.y);
  ok(tile().walkable === false, "门初始关闭：不可通行");

  let r = w.propControl({ op: "open", id });
  ok(r.ok && r.prop.open, "开门成功", r);
  ok(tile().walkable === true && tile().opaque === false && tile().soundproof === false,
    "开门同步了 walkable / opaque / soundproof");
  ok(r.trace.length === 3 && r.trace.map((t) => t.stage).join("→") === "输入→判断→开关",
    "三段轨迹顺序正确", r.trace);

  r = w.propControl({ op: "close", id });
  ok(r.ok && !r.prop.open && tile().walkable === false, "关门成功且恢复物理阻挡");

  r = w.propControl({ op: "setLock", id, mode: "code", newSecret: "1234", hint: "四位数" });
  ok(r.ok && r.prop.lock.mode === "code" && r.prop.lock.hasSecret, "密码锁配置成功", r);
  ok(d.lock.secret !== "1234" && d.lock.secret === hashCredential(id, "1234"), "只存 sha256 摘要，不存明文");
  ok(!JSON.stringify(publicProp(d)).includes(d.lock.secret), "对外视图不含密码摘要");

  // 装好锁默认不上锁（现实里也是装完再拧上），先显式上锁
  r = w.propControl({ op: "lock", id, credential: { type: "code", value: "1234" } });
  ok(r.ok && r.prop.lock.locked, "上锁需要交出当前凭证", r);

  r = w.propControl({ op: "open", id });
  ok(!r.ok && r.trace.some((t) => t.stage === "输入" && t.ok === false), "没输入凭证：卡在「输入」段", r.trace);
  ok(tile().walkable === false, "没凭证时门确实没开");

  r = w.propControl({ op: "open", id, credential: { type: "code", value: "9999" } });
  ok(!r.ok && r.reason === "wrong_credential" && r.trace.find((t) => t.stage === "判断").ok === false,
    "密码错：卡在「判断」段", r);

  r = w.propControl({ op: "open", id, credential: { type: "code", value: "1234" } });
  ok(r.ok && r.prop.open && !r.prop.lock.locked && tile().walkable, "密码对：一步解锁并开门（开关段执行）", r);

  r = w.propControl({ op: "lock", id, credential: { type: "code", value: "1234" } });
  ok(r.ok && r.prop.lock.locked && !r.prop.open && !tile().walkable, "上锁同时把门关上", r);
  r = w.propControl({ op: "open", id });
  ok(!r.ok, "锁着时无凭证仍开不了");
  r = w.propControl({ op: "unlock", id, credential: { type: "code", value: "1234" } });
  ok(r.ok && !r.prop.lock.locked, "显式解锁成功");
  r = w.propControl({ op: "setLock", id, mode: "code", newSecret: "abcd" });
  ok(!r.ok && r.reason === "credential_required", "改配已有锁必须交出旧凭证", r);
  r = w.propControl({ op: "setLock", id, mode: "none", credential: { type: "code", value: "1234" } });
  ok(r.ok && !r.prop.lock.hasSecret, "交出旧凭证后可以拆除锁具");
}

console.log("\n[4] 储物箱：开合、存取、容量、拆箱保护");
{
  const w = fresh();
  const c = findChest(w);
  ok(!!c, "广场旁自动生成了一口公共储物箱");
  ok(CHEST_RULES.slots === 30 && CHEST_RULES.maxWeight === 200, "箱子额度比背包宽");

  const v = w.spawn({ name: "存东西的" });
  // 把人挪到箱子旁边（箱子本身不可走，站相邻格）
  v.x = c.x + 1.5; v.y = c.y + 0.5;
  v.inventory = emptyInventory();
  v.inventory.fish = 5;
  const id = c.id;

  let r = w.propControl({ op: "deposit", id, item: "fish", count: 2, actorId: v.id });
  ok(!r.ok && r.reason === "not_open", "箱盖没开时不能存", r);
  r = w.propControl({ op: "open", id, actorId: v.id });
  ok(r.ok && r.prop.open, "掀开箱盖");
  r = w.propControl({ op: "deposit", id, item: "fish", count: 2, actorId: v.id });
  ok(r.ok && c.items.fish === 2 && v.inventory.fish === 3, "存入 2 条鱼：箱 +2 / 包 -2", r);
  ok(r.bag && r.bag.slots === Math.ceil(3 / ITEMS.fish.stack), "返回更新后的背包额度视图");

  r = w.propControl({ op: "withdraw", id, item: "fish", count: 1, actorId: v.id });
  ok(r.ok && c.items.fish === 1 && v.inventory.fish === 4, "取出 1 条鱼：箱 -1 / 包 +1", r);
  r = w.propControl({ op: "deposit", id, item: "fish", count: 99, actorId: v.id });
  ok(!r.ok && r.reason === "not_enough", "身上不够不能硬存", r);

  // 箱子锁：锁着时既开不了也不能存取
  r = w.propControl({ op: "setLock", id, mode: "key", newSecret: "KEY-01", hint: "铜钥匙" });
  ok(r.ok && r.prop.lock.mode === "key", "钥匙锁配置成功");
  r = w.propControl({ op: "lock", id, credential: { type: "key", value: "KEY-01" } });
  ok(r.ok && r.prop.lock.locked && !r.prop.open, "上锁并合上箱盖");
  r = w.propControl({ op: "open", id, credential: { type: "key", value: "WRONG" } });
  ok(!r.ok && r.reason === "wrong_credential", "错钥匙被拒");
  r = w.propControl({ op: "open", id, credential: { type: "key", value: "KEY-01" } });
  ok(r.ok && r.prop.open, "对钥匙一步解锁并掀盖");

  // 拆箱保护：还有东西不让拆
  w.patches.set(`${c.x},${c.y}`, "crate");
  r = w.applyAction(v, { type: "remove", x: c.x, y: c.y });
  ok(!r.ok && r.reason === "chest_not_empty", "箱里有东西时拒绝拆除", r);
  r = w.propControl({ op: "withdraw", id, item: "fish", count: 1, actorId: v.id });
  ok(r.ok, "取空箱子");
  r = w.applyAction(v, { type: "remove", x: c.x, y: c.y });
  ok(r.ok && !w.props.has(id), "取空后可以拆除，prop 一并注销", r);
}

console.log("\n[5] 对外出口：能力表、快照脱敏、Agent 与控制台同规则");
{
  const w = fresh();
  const c = findChest(w);
  w.propControl({ op: "setLock", id: c.id, mode: "code", newSecret: "hunter2" });
  w.propControl({ op: "lock", id: c.id, credential: { type: "code", value: "hunter2" } });
  const snapshot = w.snapshot(null);
  const view = snapshot.props.find((p) => p.id === c.id);
  ok(!!view, "snapshot 带 props");
  ok(!JSON.stringify(snapshot).includes(c.lock.secret) && !JSON.stringify(snapshot).includes("hunter2"),
    "快照里既没有摘要也没有明文");
  ok(view.lock.hasSecret === true && view.lock.hint !== undefined, "快照仍能看出「有锁」");

  const v = w.spawn({ name: "AI" });
  v.x = c.x + 1.5; v.y = c.y + 0.5;
  const viaAction = w.applyAction(v, { type: "open", id: c.id });
  ok(!viaAction.ok && viaAction.reason === "credential_required", "Agent 走 applyAction 同样要凭证");
  const viaConsole = w.propControl({ op: "open", id: c.id });
  ok(!viaConsole.ok && viaConsole.reason === "credential_required", "控制台走 propControl 同样要凭证");
  ok(viaAction.reason === viaConsole.reason, "两条入口判断结果一致");
}

console.log("\n[6] 存档往返与回放确定性");
{
  const w = fresh();
  const c = findChest(w);
  w.propControl({ op: "setLock", id: c.id, mode: "code", newSecret: "pw-42", hint: "提示" });
  w.propControl({ op: "open", id: c.id, credential: { type: "code", value: "pw-42" } });
  const v = w.spawn({ name: "存档者" });
  v.x = c.x + 1.5; v.y = c.y + 0.5;
  v.inventory.fish = 3;
  w.propControl({ op: "deposit", id: c.id, item: "fish", count: 2, actorId: v.id });
  const d = findDoor(w);
  w.propControl({ op: "open", id: d.id });

  const saved = serializeWorld(w);
  ok(Array.isArray(saved.props) && saved.props.length === w.props.size, "存档写入了 props");
  const w2 = fresh();
  ok(loadSave(w2, saved, { quiet: true }), "存档能装回去");
  const c2 = w2.props.get(c.id), d2 = w2.props.get(d.id);
  ok(c2 && c2.items.fish === 2 && c2.lock.secret === c.lock.secret && c2.open, "箱内物品 / 密码摘要 / 开合都还原");
  ok(d2 && d2.open && w2.map.tile(d2.x, d2.y).walkable, "门的开合与地图物理一起还原");
  ok(worldHash(w) === worldHash(w2), "读档瞬间世界指纹一致");

  // 同种子双跑：新功能不能引入非确定性
  const run = () => {
    const a = new World(GameMap.load(MAP_FILE), { hearth: true, seed: 4242 });
    for (let i = 0; i < 300; i++) a.step();
    const chest = findChest(a);
    a.propControl({ op: "setLock", id: chest.id, mode: "code", newSecret: "same" });
    a.propControl({ op: "open", id: chest.id, credential: { type: "code", value: "same" } });
    for (let i = 0; i < 200; i++) a.step();
    return worldHash(a);
  };
  const h1 = run(), h2 = run();
  ok(h1 === h2, "同种子双跑指纹一致", { h1, h2 });
}

console.log("\n结果: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
