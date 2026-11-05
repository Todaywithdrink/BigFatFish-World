// 世界的存档格式：序列化、反序列化、落盘。
//
// 从 server.mjs 里搬出来的原因很实际：回放工具也要能把"某个时刻的世界"
// 原样装回去，如果这段逻辑只活在服务端进程里，工具就只能复制一份，
// 然后两份实现慢慢漂移——存档格式是最不该有两份实现的东西。

import fs from "node:fs";
import { makeProp, ensureProps } from "./props.mjs";

// v4：门 / 储物箱的开合、锁具与箱内物品也是世界状态。
export const STATE_VERSION = 4;

const deepCopy = (obj) => JSON.parse(JSON.stringify(obj));

/**
 * 世界 → 纯数据。
 *
 * 出来的一定是深拷贝：`clock`、`needs`、`skills`、`inventory` 这些字段在 world 里
 * 是同一个对象，如果原样放进返回值，这份"快照"就会随着世界一起变。
 * 存盘时立刻 JSON.stringify 看不出来，但只要有人把快照留在内存里（比如黑匣子的
 * 开局状态），它就会悄悄变成"现在"——回放因此多跑了整整 49 个 tick 才被发现。
 */
export function serializeWorld(world) {
  return deepCopy({
    version: STATE_VERSION,
    savedAt: new Date().toISOString(),
    // 随机流状态：有它，同一份存档跑两遍才是同一个世界
    seed: world.seed,
    rngState: world.rngState(),
    tick: world.tickCount,
    clock: world.clock,
    doors: [...world.map.doors.entries()].map(([id, d]) => ({ id, open: d.open })),
    // 锁的 secret 只存在本地存档文件里；对外视图 publicProp 永远不会带它出去
    props: [...world.props.values()].map((p) => ({
      id: p.id, kind: p.kind, x: p.x, y: p.y, label: p.label,
      open: !!p.open, public: !!p.public, createdTick: p.createdTick || 0,
      lock: {
        mode: p.lock.mode, locked: !!p.lock.locked,
        secret: p.lock.secret ?? null, hint: p.lock.hint || ""
      },
      items: p.kind === "chest" ? { ...p.items } : undefined
    })),
    patches: [...world.patches.entries()],
    board: world.board.slice(-200),
    protocols: [...world.protocols.values()],
    protocolSeq: world.protocolSeq,
    boardSeq: world.boardSeq || 0,
    pairs: Object.fromEntries(world.pairs),
    forum: world.forum ? world.forum.slice(-200) : [],
    forumSeq: world.forumSeq || 0,
    commitments: world.commitments ? [...world.commitments.values()].slice(-200) : [],
    commitmentSeq: world.commitmentSeq || 0,
    settlements: world.settlements ? [...world.settlements.values()] : [],
    villagers: [...world.entities.values()].map((v) => ({
      id: v.id, name: v.name, role: v.role, color: v.color,
      x: v.x, y: v.y, dir: v.dir, hp: v.hp,
      needs: v.needs, skills: v.skills, knownRecipes: v.knownRecipes,
      explored: [...v.explored],
      coins: v.coins, inventory: v.inventory, uid: v.uid,
      craftProf: v.craftProf || {},
      recipeProgress: v.recipeProgress, home: v.home, personality: v.personality,
      talent: v.talent, appearance: v.appearance, lastBed: v.lastBed,
      downedUntil: v.downedUntil, cooldowns: v.cooldowns, buildCooldown: v.buildCooldown,
      state: v.state, mood: v.mood, lastSpokeTick: v.lastSpokeTick,
      // 走了一半的路也是世界状态：不存的话，读档瞬间"正在走"的人会凭空停下，
      // 位置差半格，后面的世界线就分叉了（determinism 的存档往返会抓到）
      path: (v.path || []).slice(0, 32).map((p) => ({ x: p.x, y: p.y })),
      external: !!v.external,
      ageDays: Number.isFinite(v.ageDays) ? v.ageDays : 20,
      origin: v.origin || "native",
      aging: v.aging || "auto",
      bornDay: Number.isFinite(v.bornDay) ? v.bornDay : null,
      lastGrowDay: Number.isFinite(v.lastGrowDay) ? v.lastGrowDay : null,
      family: v.family || { parents: [], spouseId: null, children: [] },
      // 生育冷却也是世界线的一部分：丢了它，读档后的世界会允许"提前再生一个"，
      // 和连续跑的世界对不上（determinism.mjs 会当场抓出来）
      nextBirthTick: Number.isFinite(v.nextBirthTick) ? v.nextBirthTick : 0,
      inbox: (v.inbox || []).slice(-30)
    }))
  });
}

/**
 * 把一份存档装进 world。返回 true / false，不抛异常——
 * 存档是外部输入，坏了应该是"拒绝加载"，不是让进程挂掉。
 */
export function loadSave(world, data, { quiet = false } = {}) {
  try {
    if (!data || ![1, 2, 3, STATE_VERSION].includes(data.version)) {
      if (!quiet) console.warn("[load] 未知存档版本，拒绝加载：" + (data && data.version));
      return false;
    }
    world.entities.clear();
    world.tickCount = data.tick || 0;
    if (data.clock) world.clock = data.clock;
    for (const d of data.doors || []) world.map.setDoor(d.id, d.open);
    if (Array.isArray(data.props)) {
      world.props.clear();
      for (const p of data.props) {
        if (!p || typeof p.id !== "string" || !["door", "chest"].includes(p.kind)) continue;
        world.props.set(p.id, makeProp(p.kind, p.x, p.y, {
          label: p.label, open: p.open, public: p.public, createdTick: p.createdTick,
          lock: p.lock, items: p.items
        }));
      }
    }
    // v3 及更早的存档没有 props：按地图现存的门 / crate 补登记，
    // 否则读档后门能开却不在物件表里，箱子里的东西也会凭空消失。
    ensureProps(world);
    for (const b of data.board || []) world.board.push(b);
    world.protocolSeq = data.protocolSeq || 0;
    world.boardSeq = data.boardSeq || 0;
    for (const p of data.protocols || []) world.protocols.set(p.id, p);
    for (const [k, n] of Object.entries(data.pairs || {})) world.pairs.set(k, n);
    if (Array.isArray(data.forum)) {
      for (const p of data.forum.slice(-200)) {
        if (p && typeof p.text === "string" && Number.isFinite(Number(p.seq))) world.forum.push(p);
      }
    }
    if (Number.isFinite(Number(data.forumSeq))) world.forumSeq = Number(data.forumSeq);
    if (Array.isArray(data.commitments)) {
      for (const c of data.commitments.slice(-200)) {
        if (c && typeof c.id === "string" && c.fromId && c.toId) {
          world.commitments.set(c.id, {
            id: c.id, fromId: c.fromId, toId: c.toId,
            kind: c.kind === "promise" ? "promise" : "debt",
            coins: Number.isFinite(Number(c.coins)) ? Number(c.coins) : 0,
            note: String(c.note || "").slice(0, 80),
            createdAt: Number.isFinite(Number(c.createdAt)) ? Number(c.createdAt) : 0,
            dueAt: Number.isFinite(Number(c.dueAt)) ? Number(c.dueAt) : null,
            settledAt: c.settledAt == null ? null : (Number.isFinite(Number(c.settledAt)) ? Number(c.settledAt) : null),
            lastRemindTick: Number.isFinite(Number(c.lastRemindTick)) ? Number(c.lastRemindTick) : 0
          });
        }
      }
    }
    if (Number.isFinite(Number(data.commitmentSeq))) world.commitmentSeq = Number(data.commitmentSeq);
    if (Array.isArray(data.settlements)) {
      for (const s of data.settlements) {
        if (s && typeof s.key === "string") {
          world.settlements.set(s.key, {
            key: s.key,
            x: Number.isFinite(Number(s.x)) ? Number(s.x) : 0,
            y: Number.isFinite(Number(s.y)) ? Number(s.y) : 0,
            name: String(s.name || "无名落").slice(0, 16),
            founderId: s.founderId || null,
            houses: Number.isFinite(Number(s.houses)) ? Number(s.houses) : 3,
            foundedTick: Number.isFinite(Number(s.foundedTick)) ? Number(s.foundedTick) : 0
          });
        }
      }
    }
    for (const [k, kind] of data.patches || []) {
      const [px, py] = k.split(",").map(Number);
      world.map.setKind(px, py, kind);
      world.patches.set(k, kind);
    }
    for (const v of data.villagers || []) {
      const e = world.spawn({ id: v.id, name: v.name, role: v.role, color: v.color, home: v.home, personality: v.personality });
      e.x = v.x; e.y = v.y; e.dir = v.dir; e.hp = v.hp;
      e.tileX = Math.floor(v.x); e.tileY = Math.floor(v.y);
      e.needs = v.needs || { energy: 100, hunger: 100 };
      e.skills = v.skills || e.skills;
      e.knownRecipes = v.knownRecipes || [];
      e.explored = new Set(v.explored || []);
      if (typeof v.coins === "number") e.coins = v.coins;
      if (v.inventory) e.inventory = { ...e.inventory, ...v.inventory };
      if (v.uid) e.uid = v.uid;
      if (v.craftProf) e.craftProf = { ...v.craftProf };
      if (v.appearance) e.appearance = v.appearance;
      if (v.lastBed) e.lastBed = v.lastBed;
      e.recipeProgress = v.recipeProgress || {};
      if (v.talent) e.talent = v.talent;
      if (typeof v.downedUntil === "number") e.downedUntil = v.downedUntil;
      if (v.cooldowns) e.cooldowns = { ...e.cooldowns, ...v.cooldowns };
      if (typeof v.buildCooldown === "number") e.buildCooldown = v.buildCooldown;
      if (Array.isArray(v.inbox)) e.inbox = v.inbox;
      if (typeof v.lastSpokeTick === "number") e.lastSpokeTick = v.lastSpokeTick;
      if (v.mood) e.mood = v.mood;
      if (v.state) e.state = v.state;
      if (Array.isArray(v.path)) {
        e.path = v.path
          .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
          .slice(0, 32)
          .map((p) => ({ x: Number(p.x), y: Number(p.y) }));
      }
      e.external = !!v.external;   // 谁在被人类 AI 开着，也是世界状态的一部分
      // 代际：老存档（v1/v2）没有这些字段——没有年龄一律按成年算，
      // 没有家庭就是没有家庭，不能替历史编故事
      if (Number.isFinite(Number(v.ageDays))) e.ageDays = Number(v.ageDays);
      if (v.origin) e.origin = String(v.origin).slice(0, 16);
      if (v.aging === "manual") e.aging = "manual";
      if (v.bornDay !== null && Number.isFinite(Number(v.bornDay))) e.bornDay = Number(v.bornDay);
      // 注意 null：Number(null) === 0，直接 Number.isFinite(Number(x)) 会把 null
      // 偷偷变成 0 ——序列化往返就改变了世界指纹，回放当场分叉。null 必须先排除。
      if (v.lastGrowDay !== null && Number.isFinite(Number(v.lastGrowDay))) e.lastGrowDay = Number(v.lastGrowDay);
      if (Number.isFinite(Number(v.nextBirthTick))) e.nextBirthTick = Number(v.nextBirthTick);
      if (v.family && typeof v.family === "object") {
        e.family = {
          parents: Array.isArray(v.family.parents) ? v.family.parents.filter((x) => typeof x === "string") : [],
          spouseId: typeof v.family.spouseId === "string" ? v.family.spouseId : null,
          children: Array.isArray(v.family.children) ? v.family.children.filter((x) => typeof x === "string") : []
        };
      }
    }
    // 随机流状态要在 spawn 之后恢复：spawn 会消耗随机数（uid、天赋），
    // 先恢复会被这些消耗推着往前走，读档后的世界线就和存档时对不上了。
    if (Number.isFinite(Number(data.seed))) world.seed = Number(data.seed);
    if (data.rngState != null) world.restoreRng(data.rngState);
    if (!quiet) console.log("[load] 读档成功：" + world.entities.size + " 条鱼，tick " + world.tickCount);
    return true;
  } catch (err) {
    if (!quiet) console.warn("[load] 失败:", err.message);
    return false;
  }
}

/** 原子落盘：先写 .tmp 再 rename，断电也不会留下半截 JSON */
export function writeSaveFile(world, file) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(serializeWorld(world)));
  fs.renameSync(tmp, file);
}

export function readSaveFile(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
