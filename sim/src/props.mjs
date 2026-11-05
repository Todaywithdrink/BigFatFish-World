// L3：可开关实体（门 / 储物箱）与上锁
//
// 用户给的设计预想是「输入、判断、开关功能相结合」，所以这里不做成散落的
// if (locked) return，而是所有动作都过同一条三段管线：
//
//   输入 input   → 解析出凭证 / 物品 / 数量（缺什么就在这一段明确报出来）
//   判断 judge   → 校验凭证、额度、距离、开合状态（引擎只判断"对不对"，不判断"谁配不配"）
//   开关 switch  → 真正改状态（开门 / 上锁 / 存取），并把结果和三段轨迹一起返回
//
// 引擎中立（蓝图第 11 条）：锁只认凭证本身，不判定所有权、不记录"这箱子是谁的"、
// 不替居民决定给谁钥匙。钥匙/密码怎么到手上是玩法层的事，NPC 那一侧待后续开发，
// 这里只把 canAccess / propControl 公开出去，不接管任何自主决策。

import { createHash } from "node:crypto";
import {
  ITEMS, BAG_RULES, CHEST_RULES,
  bagFits, bagUsage, emptyInventory, hasItems
} from "./economy.mjs";

export const PROP_KINDS = { door: "门", chest: "储物箱" };
export const LOCK_MODES = { none: "无锁", code: "密码", key: "钥匙" };
export const OPENABLE = ["door", "chest"];

export function propId(kind, x, y) { return `${kind}:${x},${y}`; }

function defaultLabel(kind, x, y) {
  return `${PROP_KINDS[kind] || "物件"} ${x},${y}`;
}

export function makeProp(kind, x, y, opts = {}) {
  const p = {
    id: propId(kind, x, y),
    kind,
    x: Math.floor(Number(x)) || 0,
    y: Math.floor(Number(y)) || 0,
    label: String(opts.label || defaultLabel(kind, x, y)).slice(0, 24),
    open: !!opts.open,
    // secret 永不对外输出；publicProp 只给 mode / locked / hint / hasSecret
    lock: {
      mode: opts.lock?.mode || "none",
      locked: !!opts.lock?.locked,
      secret: opts.lock?.secret ?? null,
      hint: String(opts.lock?.hint || "").slice(0, 40)
    },
    public: !!opts.public,
    createdTick: Number(opts.createdTick) || 0
  };
  if (kind === "chest") {
    p.items = { ...emptyInventory(), ...(opts.items || {}) };
  }
  return p;
}

/** 纯函数、无随机：同一个 prop + 同一个密码，在任何机器上都是同一个摘要。 */
export function hashCredential(id, value) {
  return createHash("sha256").update(`${id}|${String(value)}`).digest("hex");
}

/** 对外视图：绝密字段、锁的提示之外一律不外露。 */
export function publicProp(p) {
  if (!p) return null;
  const usage = p.kind === "chest" ? bagUsage(p.items, CHEST_RULES) : null;
  return {
    id: p.id, kind: p.kind, kindName: PROP_KINDS[p.kind] || p.kind,
    x: p.x, y: p.y, label: p.label, open: !!p.open, public: !!p.public,
    lock: {
      mode: p.lock.mode, modeName: LOCK_MODES[p.lock.mode] || p.lock.mode,
      locked: !!p.lock.locked, hint: p.lock.hint, hasSecret: !!p.lock.secret
    },
    usage,
    items: usage ? usage.items : undefined
  };
}

export function publicProps(world) {
  return [...world.props.values()].map(publicProp);
}

// ---------- 三段管线的第一段：输入 ----------
/** 凭证支持多种写法：{credential:{type,value}} / code= / keyId= / credential="..." */
function readCredential(input) {
  const c = input?.credential;
  if (c && typeof c === "object") {
    const type = c.type === "key" ? "key" : "code";
    const value = String(c.value ?? c.code ?? c.keyId ?? "");
    return value ? { type, value } : null;
  }
  if (typeof c === "string" && c) return { type: "code", value: c };
  if (typeof input?.code === "string" && input.code) return { type: "code", value: input.code };
  if (typeof input?.keyId === "string" && input.keyId) return { type: "key", value: input.keyId };
  return null;
}

// ---------- 三段管线的第二段：判断 ----------
/**
 * judge 只回答"凭证能不能通过"，不碰任何状态。
 * 返回值带 stage，界面能把失败点精确画在「输入 / 判断 / 开关」的哪一段上。
 */
export function judge(prop, cred) {
  const mode = prop.lock.mode;
  if (mode === "none" || !prop.lock.secret) {
    return { ok: true, stage: "judge", verdict: "no_lock", detail: "没有上锁，无需凭证" };
  }
  if (!cred) {
    return { ok: false, stage: "input", reason: "credential_required",
      hint: mode === "code" ? "请输入密码" : "请提供钥匙编号" };
  }
  if (mode === "code") {
    const ok = hashCredential(prop.id, cred.value) === prop.lock.secret;
    return ok
      ? { ok: true, stage: "judge", verdict: "matched", detail: "密码正确" }
      : { ok: false, stage: "judge", reason: "wrong_credential", hint: "密码不对" };
  }
  if (mode === "key") {
    const ok = cred.type === "key" && cred.value === prop.lock.secret;
    return ok
      ? { ok: true, stage: "judge", verdict: "matched", detail: "钥匙对得上" }
      : { ok: false, stage: "judge", reason: "wrong_credential", hint: "钥匙对不上" };
  }
  return { ok: false, stage: "judge", reason: "bad_lock_mode", hint: "未知的锁类型" };
}

/** 给 NPC / 玩法层预留的只读查询：不改状态，只回答"此刻能不能过这道锁"。 */
export function canAccess(prop, credential) {
  if (!prop) return false;
  if (!prop.lock.locked) return true;
  return judge(prop, readCredential(credential)).ok;
}

function trace(inputStage, judgeStage, switchStage) {
  return [inputStage, judgeStage, switchStage].filter(Boolean);
}

function done(world, prop, result, stages, extra = {}) {
  return {
    ok: true, prop: publicProp(prop), trace: stages,
    view: publicProp(prop), ...extra, ...result
  };
}

function fail(reason, hint, stages, extra = {}) {
  return { ok: false, reason, hint: hint || reason, trace: stages || [], ...extra };
}

// ---------- 三段管线的第三段：开关（世界唯一的物件控制入口） ----------
/**
 * cmd:
 *   op       inspect | open | close | lock | unlock | setLock | deposit | withdraw
 *   id / x,y 定位（x,y 时可用 kind 指定门或箱）
 *   credential / code / keyId   输入
 *   mode / newSecret / hint     setLock 用
 *   item / count                deposit / withdraw 用
 *   actorId                     以某个居民的身份操作（会校验距离与背包）；不传则按控制台语义
 *
 * 返回永远带 trace（三段各发生了什么），前端可以照着画步骤条。
 */
export function propControl(world, cmd = {}) {
  const op = String(cmd.op || "");
  let prop = null;
  if (cmd.id) prop = world.props.get(String(cmd.id));
  if (!prop && Number.isFinite(Number(cmd.x)) && Number.isFinite(Number(cmd.y))) {
    const x = Math.floor(Number(cmd.x)), y = Math.floor(Number(cmd.y));
    prop = world.props.get(propId(cmd.kind || "chest", x, y))
      || world.props.get(propId(cmd.kind === "chest" ? "door" : "chest", x, y));
  }
  if (!prop) return fail("no_prop", "找不到这个门或箱子");

  const actor = cmd.actorId ? world.entities.get(String(cmd.actorId)) : null;
  if (cmd.actorId && !actor) return fail("no_actor", "操作者已不在世界里");
  if (actor) {
    const reach = prop.kind === "door" ? 1.8 : 2.2;
    if (Math.hypot(prop.x + 0.5 - actor.x, prop.y + 0.5 - actor.y) > reach) {
      return fail("too_far", `离得太远（${prop.kind === "door" ? "门" : "箱子"}要走到 ${reach} 格内）`);
    }
  }

  const cred = readCredential(cmd);
  const inStage = (text, ok = true) => ({ stage: "输入", ok, detail: text });
  const jdStage = (j) => ({ stage: "判断", ok: j.ok, detail: j.detail || j.hint || j.reason });
  const swStage = (text, ok = true) => ({ stage: "开关", ok, detail: text });
  const emit = (type, extra = {}) => {
    world.emit(actor || null, { type, propId: prop.id, kind: prop.kind, x: prop.x, y: prop.y, ...extra });
  };
  // 门与地图物理状态必须同步：walkable / opaque / soundproof 全靠 setDoor
  const syncDoor = (open) => {
    if (prop.kind === "door") world.map.setDoor(`${prop.x},${prop.y}`, open);
  };

  if (op === "inspect") {
    return done(world, prop, {}, [
      inStage("只读查看"),
      jdStage({ ok: true, detail: prop.lock.locked ? "锁着" : "没锁" }),
      swStage("未改动")
    ], { inspect: true });
  }

  if (op === "open" || op === "unlock") {
    // 锁着的门/箱：一步完成"输入密码 → 判断 → 解锁"，open 再顺手把开关推过去。
    let j = { ok: true, stage: "judge", detail: "没锁，直接可开" };
    if (prop.lock.locked) j = judge(prop, cred);
    const stages = [
      inStage(
        prop.lock.locked
          ? (cred ? `${cred.type === "key" ? "钥匙" : "密码"}已输入` : "未提供凭证")
          : "无需凭证",
        !prop.lock.locked || !!cred
      ),
      jdStage(j)
    ];
    if (!j.ok) return fail(j.reason, j.hint, stages, { prop: publicProp(prop) });
    if (prop.lock.locked) {
      prop.lock.locked = false;
      emit("prop_unlocked", { byId: actor?.id || "console" });
    }
    if (op === "unlock") {
      stages.push(swStage("已解锁"));
      return done(world, prop, { unlocked: true }, stages);
    }
    if (prop.open) {
      stages.push(swStage("本来就是开着的", true));
      return done(world, prop, { opened: true, already: true }, stages);
    }
    prop.open = true;
    syncDoor(true);
    emit("prop_opened", { byId: actor?.id || "console" });
    stages.push(swStage(prop.kind === "door" ? "门已打开" : "箱盖已掀开"));
    return done(world, prop, { opened: true }, stages);
  }

  if (op === "close") {
    if (!prop.open) return done(world, prop, { closed: true, already: true }, [
      inStage("关闭指令"), jdStage({ ok: true, detail: "本来就是关着的" }), swStage("无需改动")
    ]);
    prop.open = false;
    syncDoor(false);
    emit("prop_closed", { byId: actor?.id || "console" });
    return done(world, prop, { closed: true }, [
      inStage("关闭指令"),
      jdStage({ ok: true, detail: "关门不受锁限制" }),
      swStage(prop.kind === "door" ? "门已关上" : "箱盖已合上")
    ]);
  }

  if (op === "lock") {
    if (prop.lock.mode === "none" || !prop.lock.secret) {
      return fail("no_lock_configured", "这物件还没配锁，请先用「设置锁」指定密码或钥匙", [
        inStage("上锁指令"), jdStage({ ok: false, detail: "无锁具" })
      ], { prop: publicProp(prop) });
    }
    if (prop.lock.locked) {
      return fail("already_locked", "已经锁上了", [
        inStage("上锁指令"), jdStage({ ok: false, detail: "已经是锁定状态" })
      ], { prop: publicProp(prop) });
    }
    const j = judge(prop, cred);
    const stages = [inStage(cred ? "凭证已输入" : "未提供凭证", !!cred), jdStage(j)];
    if (!j.ok) return fail(j.reason, j.hint, stages, { prop: publicProp(prop) });
    if (prop.open) { prop.open = false; syncDoor(false); }
    prop.lock.locked = true;
    emit("prop_locked", { byId: actor?.id || "console" });
    stages.push(swStage("已上锁" + (prop.kind === "door" ? "，门同时关上" : "，箱盖同时合上")));
    return done(world, prop, { locked: true }, stages);
  }

  if (op === "setLock") {
    if (prop.lock.locked) {
      return fail("locked", "先解锁才能改锁具", [inStage("配置锁具"), jdStage({ ok: false, detail: "当前是锁着的" })], { prop: publicProp(prop) });
    }
    const mode = String(cmd.mode || "none");
    if (!LOCK_MODES[mode]) return fail("bad_mode", "锁类型只能是 none / code / key", [inStage("配置锁具")], { prop: publicProp(prop) });
    // 已有锁具时改配，必须交出旧凭证——不然任何人路过就能换掉别人的锁。
    let j = { ok: true, stage: "judge", detail: "原本无锁，可直接配置" };
    if (prop.lock.secret) j = judge(prop, cred);
    const stages = [inStage(mode === "none" ? "拆除锁具" : "新锁具参数"), jdStage(j)];
    if (!j.ok) return fail(j.reason, j.hint, stages, { prop: publicProp(prop) });

    if (mode === "none") {
      prop.lock = { mode: "none", locked: false, secret: null, hint: "" };
      stages.push(swStage("锁具已拆除"));
    } else {
      const secret = String(cmd.newSecret ?? cmd.secret ?? cmd.value ?? "").trim();
      if (!secret) return fail("secret_required", mode === "code" ? "请设置密码" : "请设置钥匙编号", stages, { prop: publicProp(prop) });
      if (secret.length > 64) return fail("secret_too_long", "凭证最长 64 字符", stages, { prop: publicProp(prop) });
      prop.lock = {
        mode, locked: false,
        secret: mode === "code" ? hashCredential(prop.id, secret) : secret,
        hint: String(cmd.hint || "").slice(0, 40)
      };
      stages.push(swStage(mode === "code" ? "密码锁已装好（只存摘要）" : "钥匙锁已装好"));
    }
    emit("prop_lock_configured", { mode, byId: actor?.id || "console" });
    return done(world, prop, { configured: true, lockMode: mode }, stages);
  }

  if (op === "deposit" || op === "withdraw") {
    if (prop.kind !== "chest") return fail("not_a_chest", "只有储物箱能存东西", [inStage("物品操作")], { prop: publicProp(prop) });
    if (!actor) return fail("actor_required", "存取要以某个居民的身份进行（在角色页选中他）", [inStage("物品操作")], { prop: publicProp(prop) });
    if (prop.lock.locked || !prop.open) {
      return fail("not_open", prop.lock.locked ? "箱子锁着，先解锁" : "箱盖没开，先打开", [
        inStage("物品操作"), jdStage({ ok: false, detail: "锁 / 开合状态不允许" })
      ], { prop: publicProp(prop) });
    }
    const item = String(cmd.item || "");
    const count = Math.max(1, Math.floor(Number(cmd.count) || 1));
    if (!ITEMS[item]) return fail("unknown_item", "没有这种物品", [inStage("物品操作")], { prop: publicProp(prop) });
    const stages = [inStage(`${ITEMS[item].name} × ${count}`)];

    if (op === "deposit") {
      if (!hasItems(actor, { [item]: count })) {
        return fail("not_enough", `${actor.name} 身上没有这么多 ${ITEMS[item].name}`, stages, { prop: publicProp(prop) });
      }
      const fit = bagFits(prop.items, { [item]: count }, CHEST_RULES);
      stages.push(jdStage({ ok: fit.ok, detail: fit.ok ? `箱子还装得下（${fit.usage.slots}/${CHEST_RULES.slots} 格）` : fit.hint }));
      if (!fit.ok) return fail(fit.rule, fit.hint, stages, { prop: publicProp(prop) });
      actor.inventory[item] -= count;
      prop.items[item] = (prop.items[item] || 0) + count;
      emit("prop_deposited", { byId: actor.id, item, count });
      stages.push(swStage(`已放入 ${ITEMS[item].name} × ${count}`));
      return done(world, prop, { deposited: { item, count } }, stages, { bag: bagUsage(actor.inventory, BAG_RULES) });
    }

    if ((prop.items[item] || 0) < count) {
      return fail("chest_empty", "箱子里没有这么多", stages, { prop: publicProp(prop) });
    }
    const fit = bagFits(actor.inventory, { [item]: count }, BAG_RULES);
    stages.push(jdStage({ ok: fit.ok, detail: fit.ok ? `${actor.name} 的背包装得下` : fit.hint }));
    if (!fit.ok) return fail(fit.reason, fit.hint, stages, { prop: publicProp(prop) });
    prop.items[item] -= count;
    actor.inventory[item] = (actor.inventory[item] || 0) + count;
    emit("prop_withdrawn", { byId: actor.id, item, count });
    stages.push(swStage(`已取出 ${ITEMS[item].name} × ${count}`));
    return done(world, prop, { withdrawn: { item, count } }, stages, { bag: bagUsage(actor.inventory, BAG_RULES) });
  }

  return fail("unknown_op", "未知操作", [inStage(String(op || "(空)"), false)], { prop: publicProp(prop) });
}

/**
 * 幂等地把地图上的门与 crate 登记成 prop。不掷骰、不消耗 world.rng，
 * 因此存档往返 / 同种子双跑都能得到完全一样的世界指纹。
 */
export function ensureProps(world) {
  if (!world.props) world.props = new Map();
  for (const d of world.map.doors.values()) {
    const id = propId("door", d.x, d.y);
    if (!world.props.has(id)) {
      world.props.set(id, makeProp("door", d.x, d.y, { open: !!d.open, createdTick: world.tickCount }));
    }
  }
  for (let y = 0; y < world.map.height; y++) {
    for (let x = 0; x < world.map.width; x++) {
      const t = world.map.tile(x, y);
      if (!t || t.kind !== "crate") continue;
      const id = propId("chest", x, y);
      if (!world.props.has(id)) {
        world.props.set(id, makeProp("chest", x, y, { public: true, label: "公共储物箱", createdTick: world.tickCount }));
      }
    }
  }
  return world.props.size;
}

/** 广场旁保证有一口箱子：没有箱子，存取这条链从第一天就是断的（和 hearth 同理）。 */
export function ensureChest(world) {
  for (let y = 0; y < world.map.height; y++) {
    for (let x = 0; x < world.map.width; x++) {
      const t = world.map.tile(x, y);
      if (t && t.kind === "crate") return null;
    }
  }
  const sp = world.map.spawn || { x: 32, y: 36 };
  for (let r = 2; r <= 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = sp.x + dx, y = sp.y + dy;
        const t = world.map.tile(x, y);
        if (!t || t.kind !== "grass") continue;
        const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([ox, oy]) => {
          const n = world.map.tile(x + ox, y + oy);
          return n && n.walkable;
        }).length;
        if (near < 2) continue;
        world.map.setKind(x, y, "crate");
        return { x, y };
      }
    }
  }
  return null;
}
