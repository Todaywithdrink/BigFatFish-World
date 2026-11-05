// 无头自检：不启动服务，直接跑内核，验证感知/对话/隔音/摔落/隐藏天赋
import { GameMap } from "../src/map.mjs";
import { World, CFG, pub, redactEvent } from "../src/world.mjs";
import { isMinor, stageOf, AGE } from "../src/lifecycle.mjs";

const map = GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const world = new World(map);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ok   " + msg); } else { fail++; console.log("  FAIL " + msg); } };
const drain = (v) => { const e = v.inbox.slice(); v.inbox.length = 0; return e; };

function makeAt(name, x, y, dir, ageDays) {
  const v = world.spawn({ name, role: "wanderer", home: { x: Math.floor(x), y: Math.floor(y) }, ...(ageDays != null ? { ageDays } : {}) });
  v.x = x; v.y = y; v.tileX = Math.floor(x); v.tileY = Math.floor(y); v.dir = dir;
  return v;
}

console.log("\n[1] 视野内的对话");
{
  const a = makeAt("A", 32.5, 34.5, Math.PI / 2);
  const b = makeAt("B", 32.5, 36.5, -Math.PI / 2);
  world.tickCount = 100;
  a.lastSpokeTick = -9999;
  const r = world.applyAction(a, { type: "say", text: "今天鱼好多", to: b.id });
  ok(r.ok, "say 成功");
  const inbox = drain(b);
  ok(inbox.some((e) => e.type === "utterance" && e.text === "今天鱼好多"), "B 收到了完整台词");
}

console.log("\n[2] 关着的门隔音，开门后能听见");
{
  world.tickCount = 200;
  const inA = makeAt("inA", 17.5, 24.5, -Math.PI / 2);
  const outB = makeAt("outB", 17.5, 27.5, Math.PI / 2 + Math.PI); // 朝北
  const doorId = "17,25";
  map.setDoor(doorId, false);
  drain(inA); drain(outB);
  inA.lastSpokeTick = -9999;
  world.tickCount = 300;
  world.applyAction(inA, { type: "say", text: "门关着的时候说的话" });
  ok(drain(outB).length === 0, "门关着：外面收不到任何东西");

  map.setDoor(doorId, true);
  drain(inA); drain(outB);
  inA.lastSpokeTick = -9999;
  world.tickCount = 400;
  world.applyAction(inA, { type: "say", text: "门开着说的话" });
  const heard = drain(outB);
  ok(heard.some((e) => e.type === "utterance"), "门开着：外面能听见（真实内容）");
  map.setDoor(doorId, false);
}

console.log("\n[3] 私密对话：听得到但听不清");
{
  world.tickCount = 500;
  const a = makeAt("P", 40.5, 34.5, 0);
  const b = makeAt("Q", 42.5, 34.5, Math.PI);
  const c = makeAt("R", 44.5, 34.5, Math.PI);
  drain(b); drain(c);
  a.lastSpokeTick = -9999;
  world.tickCount = 600;
  world.applyAction(a, { type: "say", text: "秘密：河对岸有宝藏", private: true, to: b.id });
  const rb = drain(b), rc = drain(c);
  const SECRET = "秘密：河对岸有宝藏";
  ok(rb.some((e) => e.type === "utterance"), "对话对象听到了内容");
  ok(rc.some((e) => e.type === "heard_muffled") && !rc.some((e) => e.type === "utterance"), "旁人只收到'听不清'，拿不到内容");

  // 事件体里不能夹带正文（曾经 heard_muffled.from.bubble.text 是漏的）
  const muffled = rc.find((e) => e.type === "heard_muffled");
  ok(muffled && !JSON.stringify(muffled).includes(SECRET), "旁人事件体里没有正文");

  // 观众视角（observer = null）：快照与日志都不能出现正文
  const snap = world.snapshot(null);
  const sa = snap.entities.find((e) => e.id === a.id);
  ok(sa && !(sa.bubble && sa.bubble.text === SECRET), "观众快照里看不到私聊正文");
  // 快照自 2026-11-05 流量优化后不再带 log；观众实际读的是 /api/log 的脱敏出口，
  // 所以按真实出口口径校验，而不是去读一个已经不存在的字段。
  const publicLog = world.log.slice(-200).map((e) => redactEvent(e, null));
  ok(!publicLog.some((e) => JSON.stringify(e).includes(SECRET)), "观众日志里看不到私聊正文");

  // 当事人自己仍然看得到自己说的话
  const own = world.snapshot(a).entities.find((e) => e.id === a.id);
  ok(own && own.bubble && own.bubble.text === SECRET, "当事人自己仍能看到");
}

console.log("\n[4] 背后看不见（视锥）");
{
  world.tickCount = 700;
  const a = makeAt("S", 30.5, 36.5, 0);         // 朝东
  const back = makeAt("T", 26.5, 36.5, 0);      // 西边 4 格
  ok(!world.canSee(a, back), "正后方 4 格看不见");
  const front = makeAt("U", 34.5, 36.5, 0);
  ok(world.canSee(a, front), "正前方 4 格看得见");
  back.x = 30.5; back.y = 37.5;                  // 贴脸 1 格
  ok(world.canSee(a, back), "1 格内不看朝向也能察觉到");
}

console.log("\n[5] 高差限制移动（已取消跌落伤害）");
{
  // 找一处可站立的断崖：相邻两格高差 > 1
  let cliff = null;
  for (let y = 0; y < map.height && !cliff; y++) {
    for (let x = 0; x < map.width - 1 && !cliff; x++) {
      const t1 = map.tile(x, y), t2 = map.tile(x + 1, y);
      if (t1 && t2 && t1.walkable && t2.walkable && Math.abs(t1.height - t2.height) > 1) {
        cliff = { x, y };
      }
    }
  }
  ok(!!cliff, "地图里存在可站立断崖" + (cliff ? "（" + cliff.x + "," + cliff.y + " 高差跳变）" : ""));
  if (cliff) {
    const f = makeAt("F", cliff.x + 0.5, cliff.y + 0.5, 0);
    f.hp = 100;
    const r = world.applyAction(f, { type: "move", dir: "e", tiles: 1 });
    ok(f.tileX === cliff.x, "高差 >1 走不过去（停在 " + f.tileX + "）");
    ok(f.hp === 100, "没有跌落伤害 (hp=" + f.hp + ")");
  }
}

console.log("\n[6] 关着门进不去（寻路）");
{
  map.setDoor("17,25", false);
  const p = map.findPath(32, 34, 17, 23);
  ok(p === null, "门关着时寻路失败");
  map.setDoor("17,25", true);
  const p2 = map.findPath(32, 34, 17, 23);
  ok(Array.isArray(p2) && p2.length > 0, "开门后能找到路");
  map.setDoor("17,25", false);
}

console.log("\n[7] 天赋不外露");
{
  const snap = world.snapshot();
  const anyTalent = snap.entities.some((e) => "talent" in e || "recipeProgress" in e);
  ok(!anyTalent, "snapshot 里没有 talent / recipeProgress");
  const v = world.entities.get(snap.entities[0].id);
  ok(typeof v.talent === "number" && v.talent >= 0.6 && v.talent <= 1.4, "天赋在服务端存在且在 0.6~1.4");
}

console.log("\n[8] 技能随天赋加速");
{
  const a = world.spawn({ name: "slow" }); a.talent = 0.6;
  const b = world.spawn({ name: "fast" }); b.talent = 1.4;
  const { addXp } = await import("../src/skills.mjs");
  addXp(a, "cooking", 100); addXp(b, "cooking", 100);
  ok(b.skills.cooking.xp > a.skills.cooking.xp, "同样的练习，天赋高的经验更多");
}

console.log("\n[9] 遗忘曲线：不用会退，常用不退");
{
  const { addXp, decaySkills } = await import("../src/skills.mjs");
  const opts = { graceTicks: CFG.SKILL_GRACE_TICKS, ratePerHour: CFG.SKILL_DECAY_PER_HOUR };
  const T0 = 100;

  // 遗忘是"每小时结算一次"，所以要按小时推进，而不是一次跳三十天
  const runHours = (v, hours, fromTick, onHour) => {
    let drops = [];
    for (let h = 1; h <= hours; h++) {
      const tick = fromTick + h * 500;
      if (onHour) onHour(tick, h);
      drops = drops.concat(decaySkills(v, tick, opts));
    }
    return drops;
  };

  const idle = world.spawn({ name: "idle" }); idle.talent = 1;
  const busy = world.spawn({ name: "busy" }); busy.talent = 1;
  world.tickCount = T0;
  addXp(idle, "fishing", 900, T0);
  addXp(busy, "fishing", 900, T0);
  const lv0 = idle.skills.fishing.level;
  ok(lv0 >= 3, "先练到 " + lv0 + " 级");

  // 前 48 小时是宽限期：一小时一小时地结算，也不该掉
  runHours(idle, 48, T0);
  ok(idle.skills.fishing.level === lv0, "宽限期内不生疏");

  // 之后放着不管整整三十天：必须掉级
  const drops = runHours(idle, 30 * 24, T0 + 48 * 500);
  ok(idle.skills.fishing.level < lv0, "三十天不用会退级 (" + lv0 + " → " + idle.skills.fishing.level + ")");
  ok(drops.some((d) => d.skill === "fishing"), "掉级会报事件，能广播给观众");

  // 同样的时间，但每天照常钓鱼：稳得住，不该掉
  runHours(busy, 48 + 30 * 24, T0, (tick, h) => {
    if (h % 24 === 0) addXp(busy, "fishing", 60, tick);   // 一天十來条
  });
  ok(busy.skills.fishing.level >= lv0, "一直在用就不退 (level=" + busy.skills.fishing.level + ")");

  // 再放十年：忘到巅峰的一半就停手，不会归零
  runHours(idle, 10 * 365 * 24, T0 + 100000);
  const floorXp = idle.skills.fishing.best * 0.5;
  ok(idle.skills.fishing.xp >= Math.floor(floorXp), "只忘到巅峰的一半，不会归零 (xp=" + Math.round(idle.skills.fishing.xp) + ")");
  ok(idle.skills.fishing.level >= 1, "练过的人仍然比没练过的人强 (level=" + idle.skills.fishing.level + ")");
}

console.log("\n[10] 带外变更通道（改名/接管/发放/生长/新生）");
{
  // 这些都不是 applyAction，但都会改世界。以前它们绕过一切记录，
  // 回放时第一个改名就跟现实分叉；更早还因为"先查实体"的顺序问题，
  // 让"没有空位时注册新居民"直接 400。
  const before = { w: world.map.width, h: world.map.height };
  const g = world.mutate({ kind: "grow", side: "e" });
  ok(g.ok && world.map.width > before.w, "地图能长（不需要先有实体）");

  const born = world.mutate({ kind: "spawn", spec: { name: "新生儿", role: "wanderer", home: null } });
  ok(born.ok && born.id, "新村民能生出来（不需要先有实体）");
  const kid = world.entities.get(born.id);
  ok(!!kid, "生出来的实体真的在世界里");

  world.mutate({ kind: "rename", id: kid.id, name: "小石头" });
  ok(kid.name === "小石头", "改名生效");
  world.mutate({ kind: "external", id: kid.id, on: true });
  ok(kid.external === true, "接管标记生效");
  world.mutate({ kind: "grant", id: kid.id, item: "wood", count: 3, coins: 7 });
  ok((kid.inventory.wood || 0) >= 3 && kid.coins >= 7, "发放物资生效");
  const spot = world.map.findNearest("grass", kid.x, kid.y);
  const tp = world.mutate({ kind: "teleport", id: kid.id, x: spot.x, y: spot.y });
  ok(tp.ok && kid.tileX === spot.x, "传送生效");

  ok(world.mutate({ kind: "nonsense", id: kid.id }).ok === false, "未知变更被拒，不会静默改世界");
  ok(world.mutate({ kind: "rename", id: "v999" }).ok === false, "对不存在的实体改不动东西");
}

console.log("\n[11] 年龄与阶段：孩子只能被生出来，成年后不再变老");
{
  const kid = world.spawn({ name: "小测试", ageDays: 0 });
  ok(stageOf(kid.ageDays) === "child", "0 岁出生是童年");
  ok(isMinor(kid), "童年是未成年");
  const grown = world.mutate({ kind: "age", id: kid.id, ageDays: AGE.ADULT_DAYS });
  ok(grown.ok && grown.stage === "adult", "到 12 天成年（管理员直调）");
  ok(!isMinor(kid), "成年后不再是未成年");
  const old = world.spawn({ name: "老测试", ageDays: 999 });
  ok(stageOf(old.ageDays) === "adult", "成年后不再有新阶段（成年即不老）");
  const legacy = world.spawn({ name: "旧档鱼" });
  delete legacy.ageDays;
  ok(stageOf(legacy.ageDays) === "adult" && !isMinor(legacy), "没有年龄的旧档实体按成年算");
  ok(world.mutate({ kind: "age", id: kid.id, ageDays: -5 }).ok === false, "负年龄被拒");
}

console.log("\n[12] 未成年硬隔离：代码级，不靠模型自律");
{
  const kid = makeAt("熊孩子", 30.5, 40.5, 0, 0);

  // 不能有财产行为
  ok(world.applyAction(kid, { type: "quote", targetId: "v1", side: "sell", item: "wood", count: 1, price: 1 }).reason === "minor", "未成年不能报价");
  ok(world.applyAction(kid, { type: "accept", quoteId: "q0" }).reason === "minor", "未成年不能接单");
  ok(world.applyAction(kid, { type: "publish", kind: "auction", item: "wood", count: 1, price: 1, seconds: 60 }).reason === "minor", "未成年不能开拍卖");
  ok(world.applyAction(kid, { type: "placeBid", protocolId: "p0", price: 1 }).reason === "minor", "未成年不能出价");
  ok(world.applyAction(kid, { type: "buildHouse" }).reason === "minor", "未成年不能盖房");
  ok(world.applyAction(kid, { type: "propose", targetId: "v1" }).reason === "minor", "未成年不能求婚");

  // 根本不允许被人类 AI 接管：这是蓝图 3.2 的红线
  ok(world.mutate({ kind: "external", id: kid.id, on: true }).ok === false, "未成年不能被外部 AI 接管");
  ok(kid.external === false, "接管标记没有被偷偷打开");

  // 身体能力不受限：孩子能走能说
  ok(world.applyAction(kid, { type: "move", dir: "s", tiles: 1 }).ok, "未成年能移动");
  kid.lastSpokeTick = -9999;
  ok(world.applyAction(kid, { type: "say", text: "我要出去玩" }).ok, "未成年能说话");

  world.mutate({ kind: "age", id: kid.id, ageDays: AGE.ADULT_DAYS });
  ok(world.mutate({ kind: "external", id: kid.id, on: true }).ok, "成年后可以被接管");
  world.mutate({ kind: "external", id: kid.id, on: false });
}

console.log("\n[13] 求婚与婚配：成年、未婚、面对面");
{
  world.tickCount = 900;
  const a = makeAt("求婚者", 40.5, 44.5, 0);
  const b = makeAt("应婚者", 42.5, 44.5, Math.PI);
  drain(a); drain(b);

  const r1 = world.applyAction(a, { type: "propose", targetId: b.id });
  ok(r1.ok && r1.proposalId, "成年面对面求婚成功");
  const got = drain(b);
  ok(got.some((e) => e.type === "proposal_received" && e.fromName === "求婚者"), "对方收到求婚事件");

  ok(world.applyAction(a, { type: "propose", targetId: b.id }).reason === "proposal_pending", "一次只能挂一个求婚");
  ok(world.applyAction(b, { type: "answerProposal", proposalId: "m999", accept: true }).reason === "no_proposal", "不存在的求婚答不了");

  const r2 = world.applyAction(b, { type: "answerProposal", proposalId: r1.proposalId, accept: true });
  ok(r2.ok && r2.married, "答应求婚 → 成婚");
  ok(a.family.spouseId === b.id && b.family.spouseId === a.id, "家庭图双向登记");

  const far = makeAt("远方的鱼", 4.5, 4.5, 0);
  const c = makeAt("第三者", 46.5, 44.5, Math.PI);
  const r3 = world.applyAction(c, { type: "propose", targetId: far.id });
  ok(r3.reason === "too_far", "隔空求婚不行");
  const r4 = world.applyAction(c, { type: "propose", targetId: b.id });
  ok(r4.reason === "target_married", "已婚的不能被再求");
  ok(world.applyAction(a, { type: "propose", targetId: b.id }).reason === "already_married", "已婚的不能再求别人");
}

console.log("\n[14] 生育与遗传：新原住民只能作为孩子出生");
{
  const parents = [...world.entities.values()].filter((v) => v.family && v.family.spouseId).slice(0, 2);
  ok(parents.length >= 2, "有现成的夫妻（上一组测试成的）");
  const [ma, pa] = parents[0].family.spouseId === parents[1].id ? parents : [parents[0], world.entities.get(parents[0].family.spouseId)];
  // 拉到一起
  pa.x = ma.x + 2; pa.y = ma.y; pa.tileX = Math.floor(pa.x); pa.tileY = Math.floor(pa.y);

  const r = world.applyAction(ma, { type: "giveBirth", name: "小鲤鱼" });
  ok(r.ok && r.child, "已婚夫妻能生孩子");
  const child = world.entities.get(r.child.id);
  ok(child.ageDays === 0 && stageOf(child.ageDays) === "child", "孩子从 0 岁出生，不是凭空成年");
  ok(child.family.parents.includes(ma.id) && child.family.parents.includes(pa.id), "父母关系登记");
  ok(ma.family.children.includes(child.id) && pa.family.children.includes(child.id), "孩子记在双方名下");
  ok(child.talent >= 0.6 && child.talent <= 1.4, "天赋遗传后仍在区间内 (" + child.talent + ")");
  ok(world.applyAction(ma, { type: "giveBirth" }).reason === "cooldown", "生育有冷却（3 游戏日）");

  const single = makeAt("单身鱼", 50.5, 44.5, 0);
  ok(world.applyAction(single, { type: "giveBirth" }).reason === "not_married", "单身不能生");

  // 投影不泄密：talent 仍然不可见，但 stage/family 可见
  const snap = pub(child);
  ok(snap.stage === "child" && !("talent" in snap), "对外可见 stage，不可见 talent");
}

console.log("\n[15] 死亡与继承（mortal 世界）");
{
  // 用独立的世界测真死：不能污染上面的公共世界
  const map2 = GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const mw = new World(map2, { seed: 42, mortal: true });

  const dad = mw.spawn({ name: "老父", ageDays: 40, home: null });
  dad.coins = 66;
  dad.inventory.wood = 3;
  const mom = mw.spawn({ name: "老母", ageDays: 38 });
  const son = mw.spawn({ name: "长子", ageDays: 30 });
  const girl = mw.spawn({ name: "幼女", ageDays: 0 });
  dad.family.spouseId = mom.id; mom.family.spouseId = dad.id;
  dad.family.children = [son.id, girl.id]; mom.family.children = [son.id, girl.id];
  son.family.parents = [dad.id, mom.id]; girl.family.parents = [dad.id, mom.id];

  mw.die(dad, "test");
  ok(dad.state === "dead", "成年死亡不可逆（mortal 开）");
  ok(mw.applyAction(dad, { type: "move", dir: "n", tiles: 1 }).reason === "dead", "死人不能行动");
  ok(mw.mutate({ kind: "external", id: dad.id, on: true }).ok === false, "死人不能被接管");
  ok(mom.family.spouseId !== null && mom.state !== "dead", "配偶还在（家庭图不连带清空）");
  const heirEv = mom.inbox.some((e) => e.type === "inherited" && e.coins === 66);
  ok(heirEv, "配偶优先继承（66 币到账）");
  ok(mom.coins === 66 && (mom.inventory.wood || 0) >= 3, "钱和货都过去了");

  // 配头也走了：成年子女继承
  mw.die(mom, "test");
  ok(son.coins >= 66 && (son.inventory.wood || 0) >= 3, "配偶不在时成年子女继承");
  ok(girl.coins === 0, "未成年的妹妹不参与分配（有成年继承人在先）");

  // 未成年永远只是倒下，不会真死
  girl.hp = 0;
  mw.down(girl, "test");
  ok(girl.state === "downed" && girl.state !== "dead", "未成年 hp 归零只是倒下");
  girl.hp = 100; girl.state = "idle";

  // 绝户：没有继承人，财产随人而去
  const lone = mw.spawn({ name: "孤鱼", ageDays: 40 });
  lone.coins = 9; lone.inventory.fish = 2;
  const beforeLost = mw.inboxSize ? mw.inboxSize() : 0;
  mw.die(lone, "test");
  ok(lone.coins === 0, "无人继承时财产清空（绝户）");

  // 非 mortal 世界：成年人也只是倒下
  const soft = world.entities.get(world.entities.keys().next().value);
  const wasState = soft.state;
  world.down(soft, "test");
  ok(soft.state === "downed", "默认（非 mortal）世界里成年死亡仍是倒下");
  soft.state = wasState; soft.hp = 100;
}

console.log("\n[16] 存档往返：年龄 / 家庭 / 生育冷却都要能带走");
{
  const { serializeWorld, loadSave } = await import("../src/persist.mjs");
  const w1 = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 7 });
  const pa = w1.spawn({ name: "父", ageDays: 30 });
  const ma = w1.spawn({ name: "母", ageDays: 28 });
  pa.family.spouseId = ma.id; ma.family.spouseId = pa.id;
  pa.nextBirthTick = 12345;
  const kid = w1.spawn({ name: "娃", ageDays: 2 });
  kid.family.parents = [pa.id, ma.id];
  pa.family.children = [kid.id];

  const data = serializeWorld(w1);
  const w2 = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 7 });
  ok(loadSave(w2, data, { quiet: true }), "读档成功");
  const kp = w2.entities.get(kid.id);
  ok(kp && kp.ageDays === 2 && isMinor(kp), "年龄随档走");
  ok(kp.family.parents.includes(pa.id), "父母关系随档走");
  const kpa = w2.entities.get(pa.id);
  ok(kpa.family.spouseId === ma.id && kpa.nextBirthTick === 12345, "婚配与生育冷却随档走");

  // v2 老档（没有代际字段）兼容
  const v2 = JSON.parse(JSON.stringify(data));
  v2.version = 2;
  for (const v of v2.villagers) { delete v.ageDays; delete v.family; delete v.origin; delete v.nextBirthTick; }
  const w3 = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 7 });
  ok(loadSave(w3, v2, { quiet: true }), "v2 老档能读");
  ok([...w3.entities.values()].every((v) => !isMinor(v)), "老档实体全部按成年算");
}

console.log("\n[17] 手动成长模式：可由小长大，不能变小");
{
  const { AGE } = await import("../src/lifecycle.mjs");
  // 手动模式的角色：平时一岁不长
  const tv = world.spawn({ name: "旅行者甲", ageDays: 0, aging: "manual" });
  const bornDay = tv.bornDay;
  ok(tv.aging === "manual" && tv.bornDay === world.clock.day, "创建日即生日（day " + bornDay + "）");

  const dayBefore = world.clock.day;
  // 推进两个游戏日（24000 tick）：不应自动长
  const startTick = world.tickCount;
  while (world.clock.day < dayBefore + 2) world.step();
  ok(tv.ageDays === 0, "手动模式平时不自动长（推进到 day " + world.clock.day + "，ageDays=" + tv.ageDays + "）");

  // 不能变小：admin 直调年龄只能调大
  ok(world.mutate({ kind: "age", id: tv.id, ageDays: 0 }).ok === true, "等于当前值是允许的（无变化）");
  const shrink = world.mutate({ kind: "age", id: tv.id, ageDays: 30 });
  ok(shrink.ok, "先调大（0 → 30）");
  ok(world.mutate({ kind: "age", id: tv.id, ageDays: 10 }).reason === "age_cannot_shrink", "调小被拒：年龄只能由小长大");

  // 手动 +1 岁
  tv.ageDays = 0; // 直接重置字段绕开 admin 限制（测试内部状态）
  const g1 = world.mutate({ kind: "growUp", id: tv.id });
  ok(g1.ok && g1.ageDays === AGE.YEAR_DAYS, "growUp +1 岁（0 → " + g1.ageDays + "）");
  ok(g1.stage === "adult", "满一岁即成年（1 岁 = " + AGE.YEAR_DAYS + " 游戏日）");
  const g2 = world.mutate({ kind: "growUp", id: tv.id });
  ok(g2.reason === "grow_cooldown", "同一天再决定被拒（至少隔一天）");

  // 隔一天后再决定
  while (world.clock.day < tv.lastGrowDay + 2) world.step();
  const g3 = world.mutate({ kind: "growUp", id: tv.id });
  ok(g3.ok && g3.ageDays === 2 * AGE.YEAR_DAYS && g3.stage === "adult", "隔一天后可以再长一岁 → 成年");

  // 生日保底：+1 岁最晚一年一次
  const kid2 = world.spawn({ name: "旅行者乙", ageDays: 0, aging: "manual" });
  const bday = kid2.bornDay;
  while (world.clock.day < bday + AGE.YEAR_DAYS) world.step();
  ok(kid2.ageDays >= AGE.YEAR_DAYS, "生日那天保底 +1 岁（" + kid2.ageDays + " 天，day " + world.clock.day + "）");

  // auto 模式的角色不能手动加（世界替他长）
  const native = world.spawn({ name: "原住民", ageDays: 5 });
  ok(world.mutate({ kind: "growUp", id: native.id }).reason === "auto_aging", "auto 模式拒绝手动成长");
  // auto 的照常每天长
  const d0 = world.clock.day, a0 = native.ageDays;
  while (world.clock.day < d0 + 1) world.step();
  ok(native.ageDays === a0 + 1, "auto 模式每个游戏日 +1");

  // 模式可切换 + 存档往返
  ok(world.mutate({ kind: "setAging", id: native.id, mode: "manual" }).ok, "切换到手动模式");
  const a1 = native.ageDays;
  while (world.clock.day < world.clock.day + 2) { world.step(); break; }
  const dNow = world.clock.day;
  while (world.clock.day < dNow + 1) world.step();
  ok(native.ageDays === a1, "切到手动后不再自动长");
}

console.log("\n[18] 游戏内论坛：成年人的线上世界，未成年人不可见");
{
  world.tickCount = 2000;
  const adult = makeAt("发帖人", 30.5, 42.5, 0, 30);
  const other = makeAt("刷帖人", 31.5, 42.5, 0, 30);
  const kid = makeAt("小孩", 32.5, 42.5, 0, 0);
  drain(adult); drain(other); drain(kid);

  // 成年人能发帖回帖
  const p1 = world.applyAction(adult, { type: "postForum", text: "村东的鱼今天特别多" });
  ok(p1.ok && p1.seq === 1, "成年人能发帖（seq=1）");
  ok(world.applyAction(adult, { type: "postForum", text: "立刻再发" }).reason === "cooldown", "发帖有冷却");
  const ev = drain(other).find((e) => e.type === "forum_post");
  ok(ev && ev.text === "村东的鱼今天特别多", "其他成年居民收到论坛事件");
  ok(drain(kid).length === 0, "未成年人收不到任何论坛事件");

  // 未成年人不能读也不能发
  ok(world.applyAction(kid, { type: "postForum", text: "我也要发" }).reason === "minor", "未成年不能发帖");
  ok(world.applyAction(kid, { type: "readForum" }).reason === "minor", "未成年不能读论坛");

  // 冷却过了可以回帖
  world.tickCount += 40;
  const p2 = world.applyAction(other, { type: "postForum", text: "真的吗？我下午去看看", replyTo: p1.seq });
  ok(p2.ok && p2.seq === 2, "回帖成功");
  const read = world.applyAction(adult, { type: "readForum" });
  ok(read.ok && read.posts.length === 2 && read.posts[1].replyTo === p1.seq, "读论坛：帖子+回帖都可见");

  // 人类内容网关：导入的"影子"与居民帖子混排
  const imp = world.mutate({ kind: "forumImport", text: "【外部世界】今天有 12000 人观看了这个村子", author: "弹幕君" });
  ok(imp.ok, "网关能导入人类内容");
  const read2 = world.applyAction(other, { type: "readForum" });
  const human = read2.posts.find((p) => p.kind === "human");
  ok(human && human.author === "弹幕君", "导入内容对成年居民可见");
  ok(world.mutate({ kind: "forumImport", text: "   " }).reason === "empty", "空内容进不来");
  const dirty = world.mutate({ kind: "forumImport", text: "a\nb\u0000c" });
  ok(dirty.ok, "控制符被清洗后仍可导入");

  // 存档往返：论坛内容与序号都要带走
  const { serializeWorld, loadSave } = await import("../src/persist.mjs");
  const data = serializeWorld(world);
  const w2 = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 7 });
  loadSave(w2, data, { quiet: true });
  ok(w2.forum.length === world.forum.length && w2.forumSeq === world.forumSeq, "论坛随档走（" + w2.forum.length + " 条，seq=" + w2.forumSeq + "）");
  const r2 = world.applyAction(w2.entities.get(adult.id), { type: "readForum" });
  ok(r2.ok && r2.posts.some((p) => p.kind === "human"), "读档后导入内容仍在");
}

console.log("\n[18b] 论坛热帖 + 双向通道：人类的帖子有人回，回帖送得回去");
{
  world.forum.length = 0; world.forumSeq = 0;
  // 人类导入一帖
  world.mutate({ kind: "forumImport", text: "镇上有人会做鱼汤吗？", author: "路人甲" });
  const humanSeq = world.forum[world.forum.length - 1].seq;

  const a = makeAt("回帖人", 30.5, 40.5, 0);
  // 两居民回人类的帖，一居民回居民的帖
  ok(world.applyAction(a, { type: "postForum", text: "我会！三条鱼换。", replyTo: humanSeq }).ok, "居民回人类的帖");
  const b = makeAt("围观者", 31.5, 40.5, 0);
  ok(world.applyAction(b, { type: "postForum", text: "他做得确实好喝。", replyTo: humanSeq }).ok, "另一居民也回");
  const replySeq = world.forum[world.forum.length - 1].seq;
  const c = makeAt("抬杠的", 32.5, 40.5, 0);
  ok(world.applyAction(c, { type: "postForum", text: "楼上收钱了吧？", replyTo: replySeq }).ok, "居民回居民的帖");

  // 热度：人类帖被回 2 次，居民帖被回 1 次
  const hot = world.applyAction(a, { type: "readForum", hot: true });
  ok(hot.posts[0].seq === humanSeq && hot.posts[0].replies === 2, "热帖排序：被回最多的在最前（" + hot.posts[0].replies + " 回）");
  ok(hot.posts.every((p) => p.replies !== undefined), "帖子带回复数");

  // 双向通道：待导出的 = 全部居民的回帖（回人类帖的、回居民帖的都在——
  // 引擎做搬运工，人类侧要不要用整条讨论串由网关决定）
  const pending = world.pendingForumReplies();
  ok(pending.length === 3, "待导出：居民的全部回帖（实际 " + pending.length + "）");
  // 导出标记
  const n = world.markForumRepliesExported(pending.map((p) => p.seq));
  ok(n === 3 && world.pendingForumReplies().length === 0, "标记导出后不再重复推送");

  // 存档往返：replies / exported 都要带走
  const { serializeWorld, loadSave } = await import("../src/persist.mjs");
  const snap = serializeWorld(world);
  const wl = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 7 });
  loadSave(wl, snap, { quiet: true });
  ok(wl.pendingForumReplies().length === 0, "exported 标记随档走（读档后不重复推送）");
  const hp = wl.forum.find((p) => p.seq === humanSeq);
  ok(hp && hp.replies === 2, "热度随档走");
}

console.log("\n[19] 承诺登记簿：不强制执行，但绝不让你忘");
{
  const a = makeAt("许诺人", 30.5, 40.5, 0);
  const b = makeAt("受诺人", 31.5, 40.5, 0);
  const kid = makeAt("小不点", 32.5, 40.5, 0);
  kid.ageDays = 3; // 直接改字段：测试内部状态

  // 许诺：当面、有内容
  const far = makeAt("远方的人", 40.5, 40.5, 0);
  ok(world.applyAction(a, { type: "promise", targetId: far.id, text: "明天给你带鱼" }).reason === "too_far", "隔空许诺不行：约定要当面");
  ok(world.applyAction(a, { type: "promise", targetId: b.id, text: "   " }).reason === "bad_text", "空约定不行");
  ok(world.applyAction(kid, { type: "promise", targetId: a.id, text: "我长大了给你糖" }).reason === "minor", "未成年不能许诺");

  const r1 = world.applyAction(a, { type: "promise", targetId: b.id, text: "明天给你带三条鱼", coins: 5 });
  ok(r1.ok && r1.commitmentId, "许诺成功");
  const seenA = world.commitmentsFor(a);
  const seenB = world.commitmentsFor(b);
  ok(seenA.length === 1 && seenA[0].role === "i_owe" && seenA[0].otherName === "受诺人", "许诺方视角：我欠的约定");
  ok(seenB.length === 1 && seenB[0].role === "owed_to_me" && seenB[0].otherName === "许诺人", "受诺方视角：别人欠我的");
  ok(seenA[0].coins === 5, "约定可以带金额");

  // 了结：只有欠的一方能了结
  ok(world.applyAction(b, { type: "settle", commitmentId: r1.commitmentId }).reason === "not_yours", "受诺方不能替对方了结");
  const coinsBefore = b.coins;
  const s1 = world.applyAction(a, { type: "settle", commitmentId: r1.commitmentId });
  ok(s1.ok && world.commitmentsFor(a).length === 0, "许诺方宣告完成：登记簿清空");
  ok(b.coins === coinsBefore, "无金额约定了结不动钱");

  // 赊账自动登记：买家没钱也成交，欠款进登记簿
  const seller = makeAt("卖家", 33.5, 41.5, 0);
  const buyer = makeAt("买家", 34.5, 41.5, 0);
  seller.inventory.fish = (seller.inventory.fish || 0) + 3;
  buyer.coins = 0;
  const q = world.applyAction(seller, { type: "quote", targetId: buyer.id, side: "sell", item: "fish", count: 2, price: 7, allowCredit: true });
  ok(q.ok, "赊账报价发出");
  ok(world.applyAction(buyer, { type: "accept", quoteId: q.quoteId }).ok, "没钱也成交（allowCredit）");
  const debts = world.commitmentsFor(buyer).filter((c) => c.kind === "debt");
  ok(debts.length === 1 && debts[0].coins === 7 && debts[0].role === "i_owe", "欠款自动进登记簿");

  // 部分偿还
  buyer.coins = 3;
  const p1 = world.applyAction(buyer, { type: "settle", commitmentId: debts[0].id, coins: 3 });
  ok(p1.ok && p1.rest === 4, "部分偿还：还 3 欠 4");
  ok(buyer.coins === 0 && seller.coins === 3, "钱真的过去了");
  ok(world.commitmentsFor(buyer).some((c) => c.kind === "debt" && c.coins === 4), "余款还挂在登记簿上");

  // 全额还清
  buyer.coins = 10;
  const rest = world.commitmentsFor(buyer).find((c) => c.kind === "debt");
  const p2 = world.applyAction(buyer, { type: "settle", commitmentId: rest.id });
  ok(p2.ok && p2.paid === 4, "全额还清");
  ok(world.commitmentsFor(buyer).length === 0, "还清后登记簿清空");

  // 提醒：过了半天（6000 tick）没还，双方都会收到提醒
  const s2 = world.applyAction(seller, { type: "quote", targetId: buyer.id, side: "sell", item: "fish", count: 1, price: 5, allowCredit: true });
  buyer.coins = 0;
  world.applyAction(buyer, { type: "accept", quoteId: s2.quoteId });
  buyer.inbox.length = 0; seller.inbox.length = 0;
  for (let i = 0; i < 9500; i++) world.step(); // 要跨过两个 3000 对齐点 + 6000 年龄线
  ok(buyer.inbox.some((e) => e.type === "commitment_reminder"), "欠款方收到提醒");
  ok(seller.inbox.some((e) => e.type === "commitment_reminder"), "债主也收到提醒");

  // 上限：每人名下最多 20 条
  world.commitments.clear();
  let added = 0;
  for (let i = 0; i < 25; i++) {
    if (world.addCommitment(buyer.id, seller.id, { kind: "promise", note: "约定" + i })) added++;
  }
  ok(added === 20, "登记簿每人封顶 20 条（实际 " + added + "）");

  // 存档往返：承诺要能带走
  const { serializeWorld, loadSave } = await import("../src/persist.mjs");
  world.commitments.clear();
  world.addCommitment(buyer.id, seller.id, { kind: "debt", coins: 12, note: "测试欠款" });
  const snap = serializeWorld(world);
  const wl = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 7 });
  loadSave(wl, snap, { quiet: true });
  const back = wl.commitmentsFor(wl.entities.get(buyer.id));
  ok(back.length === 1 && back[0].coins === 12 && back[0].note === "测试欠款", "承诺随存档往返不丢");
}

console.log("\n[20] 恩怨继承：死人的债不烂账");
{
  // 手搭家庭：父欠母一笔钱，父死债传给配偶
  const pa = world.spawn({ name: "欠债爹", ageDays: 30 });
  const ma = world.spawn({ name: "持家妈", ageDays: 30 });
  pa.family.spouseId = ma.id; ma.family.spouseId = pa.id;
  world.addCommitment(pa.id, ma.id, { kind: "debt", coins: 9, note: "赌债" });

  // mortal 关着时 die() 只倒地；开着重启世界验继承
  const w2 = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 11, mortal: true });
  const d = w2.spawn({ name: "亡者", ageDays: 30 });
  const heir = w2.spawn({ name: "继承人", ageDays: 30 });
  const stranger = w2.spawn({ name: "路人", ageDays: 30 });
  w2.addCommitment(d.id, stranger.id, { kind: "debt", coins: 5, note: "欠路人的" });
  w2.addCommitment(stranger.id, d.id, { kind: "promise", note: "路人欠亡者的" });
  d.family.spouseId = heir.id; heir.family.spouseId = d.id;

  w2.die(d, "test");
  const heirDebts = w2.commitmentsFor(heir).filter((c) => c.kind === "debt" && c.role === "i_owe");
  ok(heirDebts.length === 1 && heirDebts[0].coins === 5, "死者的债挂到继承人名下");
  const strangerView = w2.commitmentsFor(stranger);
  ok(strangerView.some((c) => c.role === "owed_to_me" && c.coins === 5), "债主的债权转到继承人身上");
  ok(strangerView.some((c) => c.role === "i_owe" && c.kind === "promise"), "死者生前是债主的，债权也归继承人");
}

console.log("\n[21] 大陆大纲：形貌预定，渐进显现，走到头为止");
{
  const { regionTheme, continentMap, CONTINENT, THEMES } = await import("../src/outline.mjs");

  // 大纲确定性：同 seed 同图，与查询顺序无关
  const m1 = continentMap(42), m2 = continentMap(42);
  ok(JSON.stringify(m1) === JSON.stringify(m2), "同种子两次查询，大陆全图一致");
  ok(regionTheme(5, 0, 42) === regionTheme(5, 0, 42), "单区域主题稳定");
  // 大陆形状：最东是海，最南是山脊
  ok(m1[0][CONTINENT.cols - 1] === "sea" && m1[CONTINENT.rows - 1][4] === "mountain", "东海与南山脊位置正确");
  // 新手村周边平缓（cx<=5 不出湖；南脊行除外）
  ok(m1.slice(0, CONTINENT.rows - 1).every((row) => row.slice(0, 6).every((t) => t === "plain" || t === "forest")), "新手村周边只有平原/密林");

  // 扩张：东到海为止。世界宽 128 → 每次 +32，384 是极限
  const w2 = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 42 });
  let grows = 0, lastTheme = null, edgeSeen = false;
  while (grows < 20) {
    const r = w2.mutate({ kind: "grow", side: "e" });
    if (!r.ok) break;
    grows++;
    lastTheme = r.theme;
    if (r.edge) edgeSeen = true;
  }
  ok(w2.map.width === 384, "东扩到大陆尽头 384 宽（实际 " + w2.map.width + "，长了 " + grows + " 块）");
  ok(edgeSeen && lastTheme === "sea", "最后一块是海岸条带");
  ok(w2.mutate({ kind: "grow", side: "e" }).reason === "continent_edge", "到尽头后再 grow 被拒");

  // 南扩：64 → 128，南山脊封边
  let sgrows = 0, sEdge = false;
  while (sgrows < 5) {
    const r = w2.mutate({ kind: "grow", side: "s" });
    if (!r.ok) break;
    sgrows++;
    if (r.edge) sEdge = true;
  }
  ok(w2.map.height === 128 && sEdge && sgrows === 2, "南扩两块到 128 高，南山脊封边（" + sgrows + " 块）");

  // 边缘条带真的过不去：东部末列是水
  const lastCol = w2.map.width - 2;
  let waterAtEdge = 0;
  for (let y = 0; y < w2.map.height; y++) {
    const t = w2.map.tile(lastCol, y);
    if (t && t.kind === "water") waterAtEdge++;
  }
  ok(waterAtEdge > w2.map.height * 0.5, "东缘末列大半是水，居民看得见海但过不去");

  // 扩张顺序确定性：同 seed 另一个世界逐块长，尺寸与主题序列一致
  const w3 = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 42 });
  const themes2 = [];
  for (let i = 0; i < grows; i++) themes2.push(w3.mutate({ kind: "grow", side: "e" }).theme);
  ok(w3.map.width === 384, "同种子重放：一样到 384");

  // 主题真的影响地貌：forest 区树明显多于 plain 区（用主题统计代替逐格断言）
  ok(THEMES.forest.treeChance > THEMES.plain.treeChance * 3, "密林树密度是平原的三倍以上");
}

console.log("\n[22] 聚落：第 3 张床落地，镇子自己长出来");
{
  const wb = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 9 });
  const a = wb.spawn({ name: "开拓者", ageDays: 30 });
  a.inventory.plank = 2000; a.inventory.wood = 1000;  // 备足建材（扫描要跨区域试错）
  // 找一块够大的空地（同一 16×16 区域内三栋房）
  let placed = 0;
  outer:
  for (let ry = 0; ry < 4; ry++) {
    for (let rx = 0; rx < 8; rx++) {
      // 在一个 16×16 区域内尽量盖满三栋；盖不满（空地被占）就换下一个区域重来
      // 注意：换区域后之前盖的房还留着（世界是真实的），但凑数的床必须同区
      placed = 0;
      for (let by = ry * 16 + 1; by <= ry * 16 + 11 && placed < 3; by += 5) {
        for (let bx = rx * 16 + 1; bx <= rx * 16 + 11 && placed < 3; bx += 6) {
          let clear = true;
          for (let y = by; y <= by + 3 && clear; y++) {
            for (let x = bx; x <= bx + 4; x++) {
              const t = wb.map.tile(x, y);
              if (!t || !["grass", "path", "flower"].includes(t.kind)) { clear = false; break; }
            }
          }
          if (!clear) continue;
          a.x = bx + 2.5; a.y = by + 2.5;
          const r = wb.applyAction(a, { type: "buildHouse", x: bx, y: by });
          if (r.ok) {
            placed++;
            for (let i = 0; i < 620; i++) wb.step();   // 过建造冷却
          }
        }
      }
      if (placed >= 3) break outer;
    }
  }
  ok(placed === 3, "三栋房盖起来了（本区 " + placed + " 栋）");
  ok(wb.settlements.size === 1, "第三张床落地：聚落登记");
  const s = [...wb.settlements.values()][0];
  ok(s.name === "开拓者落", "聚落以首位建房者命名（" + s.name + "）");
  // 事件已发给全体（非 dead）
  ok(a.inbox.some((e) => e.type === "settlement_founded"), "settlement_founded 事件已发");
  // 存档往返
  const { serializeWorld, loadSave } = await import("../src/persist.mjs");
  const data = serializeWorld(wb);
  const wr = new World(GameMap.load(new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), { seed: 9 });
  loadSave(wr, data, { quiet: true });
  ok(wr.settlements.size === 1 && [...wr.settlements.values()][0].name === "开拓者落", "聚落随档走");
}


console.log("\n[23] 居民自主：自己定目标，且仍然可复现");
{
  const { attachBrains } = await import("../agents/brain.mjs");
  const { spawnCast } = await import("../src/cast.mjs");
  const { worldHash } = await import("../src/fingerprint.mjs");
  const VILLAGE = new URL("../data/village.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const mk = (seed) => {
    const w = new World(GameMap.load(VILLAGE), { seed, hearth: true });
    spawnCast(w, w.map, 4);
    return { w, b: attachBrains(w, { timer: false }) };
  };
  const a = mk(55), c = mk(55);
  const kinds = new Set();
  for (let t = 0; t < 4000; t++) {
    a.w.step(); a.b.tick();
    c.w.step(); c.b.tick();
    for (const m of a.b.minds.values()) if (m.bb.goals.length) kinds.add(m.bb.goals[0].kind);
  }
  ok(kinds.size >= 3, "目标随处境变化（出现 " + kinds.size + " 种）");
  ok([...a.b.minds.values()].every((m) => Object.values(m.bb.traits).every((x) => x >= 0 && x <= 10)), "性格漂移有上下界");
  ok([...a.b.minds.values()].some((m) => m.bb.mem.places && Object.keys(m.bb.mem.places).length > 0), "记忆里攒下了见过的地方");
  // 自主决策也必须是确定的：同种子、同 tick 驱动，两个世界应完全一致
  ok(worldHash(a.w) === worldHash(c.w), "两台同种子的世界，村民做出同样的选择");
  // 心境（目标/记忆/性格）能装回去
  const d = mk(66);
  for (let t = 0; t < 1500; t++) { d.w.step(); d.b.tick(); }
  const snap = d.b.serialize();
  const { restoreBlackboard } = await import("../agents/autonomy.mjs");
  const back = restoreBlackboard(snap.minds[0][1]);
  ok(back && back.traits && typeof back.traits.optimism === "number" && Array.isArray(back.mem.notes), "心境能从存档还原（性格/记忆/目标）");
}

console.log("\n结果: " + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
