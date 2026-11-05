// 世界内核：确定性 tick，纯逻辑，不渲染。可以无头跑在服务器上。
import { GameMap } from "./map.mjs";
import { Rng } from "./rng.mjs";
import { newSkills, rollTalent, addXp, decaySkills, RECIPES, tryLearnRecipe } from "./skills.mjs";
import { ITEMS, COOK_RECIPES, CRAFT_RECIPES, CRAFT_CATEGORIES, craftChance,
  emptyInventory, addItem, addItemForced, hasItems, takeItems, inventoryList,
  bagUsage, bagFits, BAG_RULES } from "./economy.mjs";
import { stageOf, isMinor, mixTalent, mixPersonality, mixColor, emptyFamily, ensureFamily, AGE, normalizeAging } from "./lifecycle.mjs";
import { canExpand } from "./outline.mjs";
import {
  makeProp, propId, publicProp, publicProps,
  ensureProps, ensureChest, propControl as runPropControl
} from "./props.mjs";

export const CFG = {
  TICK_HZ: 10,
  DT: 0.1,
  SPEED: 3.0,
  ROAD_SPEED: 1.35,             // 走在铺好的路上更快：路才有意义
  VISION_RADIUS: 8,
  NEAR_RADIUS: 2,
  FOV_HALF: Math.PI / 3,        // 120° 视锥
  HEAR_RADIUS: 6,
  MAX_HP: 100,
  FALL_K: 4,
  DOWNED_TICKS: 200,
  CONVERSATION_TICKS: 30,       // 3 秒内算"正在和某人说话"
  BUBBLE_TICKS: 30,
  MAX_TEXT: 280,

  // 遗忘曲线：技能两个月不用不会自己变强，只会变钝
  SKILL_GRACE_TICKS: 2 * 12000, // 两天没碰才开始生疏（一天 = 12000 tick）
  SKILL_DECAY_PER_HOUR: 0.003,  // 每小时忘掉 0.3%，一天约 7%
  SKILL_DECAY_EVERY: 500,       // 一个游戏小时结算一次

  // 代际：求婚 60 秒内有效；同一对夫妻三次游戏日才能再生育
  PROPOSAL_TICKS: 600,
  BIRTH_COOLDOWN_TICKS: 3 * 12000
};

const MINUTES_PER_TICK = 1440 / (20 * 60 * CFG.TICK_HZ); // 一天 = 20 分钟真实时间

const ROLE_SPOTS = {
  fisher: { x: 12, y: 52 },
  cook: { x: 27, y: 50 },
  farmer: { x: 47, y: 50 },
  wanderer: { x: 32, y: 36 }
};

export class World {
  constructor(map, opts = {}) {
    this.map = map;
    // 模拟内的随机全部走这一条流（见 src/rng.mjs）。存档带上状态即可复现。
    this.seed = opts.seed ?? 1;
    this.rng = Rng.from(opts.rngState, this.seed);
    this.tickCount = 0;
    this.entities = new Map();
    this.nextId = 1;
    this.clock = { day: 1, minutes: 8 * 60, season: "spring" };
    this.log = [];            // 给观众看的全局事件
    this.subscribers = new Set(); // (event) => void，服务端用
    this.targetHooks = new Set(); // (target, event) => void，定向事件流（agent SSE）用
    this.patches = new Map();     // "x,y" -> kind，玩家/NPC 改造过的地形
    this.quotes = new Map();      // 双向报价
    this.board = [];              // 留言板
    this.pairs = new Map();       // "a|b" -> 见面时长，决定能认出 UID 的哪几位
    this.customActions = new Map(); // 插件注册的自定义动作
    this.protocols = new Map();    // 村民自己发布/组合出来的玩法（拍卖等）
    this.protocolSeq = 0;
    this.protocolKinds = new Map(); // 可扩展的玩法模板
    this.proposals = new Map();     // 求婚：和报价一样，是一段时间内有效的"要约"
    this.proposalSeq = 0;
    // 游戏内网络（蓝图第 7 章）：论坛。物理留言板是"线下公告"，这里是"线上世界"。
    // kind: "villager" = 居民发的；"human" = 从人类互联网经网关导入的"影子"。
    // 未成年人对这一层完全不可见（3.2 数字隔离）。
    this.forum = [];
    this.forumSeq = 0;
    // 承诺登记簿（蓝图 5.3 改道：不做代码强制执行，做"注意力"——
    // 所有未了结的约定每次观察都会摆在 AI 眼前，遗忘不是借口，但违约是自由）。
    // kind: "debt"（赊账欠款，成交时自动登记）/ "promise"（口头/自由约定，AI 自己许的）
    this.commitments = new Map();
    this.commitmentSeq = 0;
    // 聚落登记（大纲修订：后续小镇全部由居民自建）。16×16 网格，床（每房一床）>=3 成镇。
    this.settlements = new Map();

    // 可开关实体：门与储物箱共用一张表，锁 / 开合 / 内容物都在这里。
    // 先于任何 tick 建好，且不掷骰——存档往返与同种子双跑才能对得上指纹。
    this.props = new Map();

    // 村子得有一口公共灶台：不然"吃饭"这条路从一开始就断了，
    // 再聪明的居民也只能守着满背包的鱼饿死。只在正式世界开启（测试地图不动）。
    this.hearth = !!opts.hearth;
    if (this.hearth) {
      this.ensureHearth();
      ensureChest(this);   // 同理：没有箱子，存取这条链第一天就是断的
    }
    ensureProps(this);     // 把地图上的门和 crate 幂等登记成 prop

    // 死亡是否真实存在（蓝图 3.3：成年即不老，但死亡仍在）。
    // 默认关：墓地/遗嘱这些配套没齐之前，先不把村子清空。MORTAL=1 打开。
    // 注意：未成年人永远只是"倒下"，不会真死——这个世界的未来不能死于一次断粮。
    this.mortal = !!opts.mortal;

    // 动作流水（可选）。种子 + 这串动作 = 可重跑的一段历史。
    // 只记输入不记结果，所以它很小；也因为只记输入，才能拿来问"如果当时换个做法呢"。
    this.journal = null;
    this.journalLimit = opts.journalLimit ?? 200000;
    this.journalOverflow = false;
  }

  /**
   * 世界生成：广场附近放一口公共灶台（幂等）。
   * 位置不掷骰子——同一张地图每次都落在同一格，回放和存档都不会因此分叉。
   */
  ensureHearth() {
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const t = this.map.tile(x, y);
        if (t && t.kind === "stove") return;
      }
    }
    const sp = this.map.spawn || { x: 32, y: 36 };
    // 从广场外圈往里找：靠路、是草地、周围别太挤
    for (let r = 3; r <= 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sp.x + dx, y = sp.y + dy;
          const t = this.map.tile(x, y);
          if (!t || t.kind !== "grass") continue;
          let nearPath = 0;
          for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const n = this.map.tile(x + ox, y + oy);
            if (n && (n.kind === "path" || n.kind === "grass")) nearPath++;
          }
          if (nearPath < 3) continue;
          this.map.setKind(x, y, "stove");
          return;
        }
      }
    }
  }

  // ---------- 随机 ----------
  /** 模拟内唯一的随机入口。任何 `Math.random()` 出现在内核里都是 bug。 */
  random() {
    return this.rng.next();
  }

  chance(p) {
    return this.rng.chance(p);
  }

  /** 存档用：把随机流状态一起带走 */
  rngState() {
    return this.rng.state >>> 0;
  }

  restoreRng(state) {
    this.rng = Rng.from(state, this.seed);
  }

  // ---------- 基础 ----------
  spawn({ name, role = "wanderer", home = null, personality = null, color = null, id = null,
    ageDays = null, origin = "native", aging = "auto" }) {
    if (!id) id = "v" + this.nextId++;
    else this.nextId = Math.max(this.nextId, (Number(String(id).slice(1)) || 0) + 1);
    const spawn = home || ROLE_SPOTS[role] || this.map.spawn;
    const v = {
      id, name, role,
      x: spawn.x + 0.5, y: spawn.y + 0.5,
      tileX: spawn.x, tileY: spawn.y,
      dir: Math.PI / 2,
      hp: CFG.MAX_HP, maxHp: CFG.MAX_HP,
      state: "idle",
      path: [],
      speed: CFG.SPEED,
      talent: rollTalent(() => this.rng.next()),   // 隐藏
      skills: newSkills(),
      knownRecipes: [],
      recipeProgress: {},
      personality: personality || { optimism: 5, social: 5, manners: 5 },
      color: color || PALETTE[this.nextId % PALETTE.length],
      home: spawn,
      uid: this.uniqueUid(),
      coins: 0,
      inventory: emptyInventory(),
      needs: { energy: 100, hunger: 100 },
      external: false,          // 是否由外部 AI 接管
      // 代际：年龄按游戏天累积；成年（AGE.ADULT_DAYS）前是未成年，受数字隔离。
      // 外部注册进来的"旅行者"是成年空降；原住民只能靠 birth 出生，从零岁开始。
      ageDays: ageDays != null ? Math.max(0, Math.floor(Number(ageDays) || 0)) : 20,
      origin,                   // native = 本地出生 / traveler = 外来空降
      aging: normalizeAging(aging),  // auto = 每天自动长；manual = 用户决定，生日保底
      bornDay: this.clock.day,  // 生日 = 创建日（游戏日）
      lastGrowDay: null,        // 上次手动决定长大的游戏日（至少隔一天）
      family: emptyFamily(),    // { parents: [id], spouseId, children: [id] }
      // 生育冷却。必须在 spawn 里就初始化：序列化会把 undefined 写成 0，
      // 一个"没被序列化过"的实体会因此和"序列化往返过的实体"指纹不同，
      // 回放当场分叉（journal-test 压测时真抓出来过）
      nextBirthTick: 0,
      bubble: null,
      seen: new Set(),
      explored: new Set(),        // 亲眼见过的格子 "x,y"
      conversation: null,                 // {partnerId, until}
      downedUntil: 0,
      cooldowns: { attack: 0, talk: 0, eat: 0, fish: 0, forage: 0, cook: 0, craft: 0, chop: 0 },
      buildCooldown: 0,
      inbox: [],
      lastSpokeTick: -9999,
      mood: "calm"
    };
    this.entities.set(id, v);
    return v;
  }

  emit(target, event) {
    const ev = { tick: this.tickCount, ...event };
    if (target) {
      target.inbox.push(ev);
      if (target.inbox.length > 200) target.inbox.shift();
    }
    this.log.push(ev);
    if (this.log.length > 600) this.log.shift();
    for (const fn of this.subscribers) fn(ev);
    // 定向钩子：只给"这条事件是发给谁的"（server 用来做 agent SSE 流）。
    // 不进 log、不进存档、不影响指纹。
    if (this.targetHooks) {
      for (const fn of this.targetHooks) {
        try { fn(target, ev); } catch { /* 订阅方自己负责不死 */ }
      }
    }
  }

  // ---------- 时间 ----------
  /** 推进时钟；返回 true 表示跨过了一天（代际结算挂在这一天一跳的节点上） */
  advanceClock() {
    this.clock.minutes += MINUTES_PER_TICK;
    if (this.clock.minutes >= 1440) {
      this.clock.minutes -= 1440;
      this.clock.day++;
      return true;
    }
    return false;
  }

  get hour() { return Math.floor(this.clock.minutes / 60); }

  // ---------- 感知 ----------
  canSee(a, b) {
    if (a === b) return false;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    if (d > CFG.VISION_RADIUS) return false;
    if (this.map.lineBlocked(a.x, a.y, b.x, b.y)) return false;
    if (d <= CFG.NEAR_RADIUS) return true;
    let ang = Math.atan2(dy, dx) - a.dir;
    ang = Math.atan2(Math.sin(ang), Math.cos(ang));
    return Math.abs(ang) <= CFG.FOV_HALF;
  }

  canHear(a, b) {
    if (a === b) return false;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > CFG.HEAR_RADIUS) return false;
    return !this.map.soundBlocked(a.x, a.y, b.x, b.y);
  }

  updatePerception() {
    for (const v of this.entities.values()) {
      if (v.state === "downed" || v.state === "dead") continue;
      const now = new Set();
      for (const o of this.entities.values()) {
        if (o === v || o.state === "downed" || o.state === "dead") continue;
        if (this.canSee(v, o)) now.add(o.id);
      }
      for (const id of now) {
        if (!v.seen.has(id)) {
          const o = this.entities.get(id);
          this.emit(v, { type: "enter_view", who: brief(o) });
          if (v.conversation && v.conversation.until > this.tickCount) {
            this.emit(v, { type: "noticed_approach", who: pubFor(o, v), distance: round1(dist(v, o)) });
          }
        }
      }
      for (const id of v.seen) {
        if (!now.has(id)) this.emit(v, { type: "leave_view", whoId: id });
      }
      v.seen = now;
    }
  }

  expireQuotes() {
    for (const [id, q] of this.quotes) {
      if (this.tickCount > q.expiresAt) {
        this.quotes.delete(id);
        const from = this.entities.get(q.fromId);
        this.emit(from || null, { type: "quote_expired", quoteId: id });
      }
    }
    for (const [id, p] of this.proposals) {
      if (this.tickCount > p.expiresAt) {
        this.proposals.delete(id);
        const from = this.entities.get(p.fromId);
        const to = this.entities.get(p.toId);
        if (from) this.emit(from, { type: "proposal_expired", proposalId: id });
        if (to) this.emit(to, { type: "proposal_expired", proposalId: id });
      }
    }
  }

  // 把视野内的格子记成"见过"
  updateExplored() {
    for (const v of this.entities.values()) {
      if (v.state === "downed") continue;
      const cx = Math.floor(v.x), cy = Math.floor(v.y);
      for (let dy = -CFG.VISION_RADIUS; dy <= CFG.VISION_RADIUS; dy++) {
        for (let dx = -CFG.VISION_RADIUS; dx <= CFG.VISION_RADIUS; dx++) {
          const x = cx + dx, y = cy + dy;
          if (!this.map.inBounds(x, y)) continue;
          if (Math.hypot(dx, dy) > CFG.VISION_RADIUS) continue;
          if (this.map.lineBlocked(v.x, v.y, x + 0.5, y + 0.5)) continue;
          v.explored.add(x + "," + y);
        }
      }
    }
  }

  // ---------- 婚配与生育（蓝图 3.1 / 3.4：成年才解锁，孩子只能被生出来） ----------
  /**
   * 求婚。和报价一样是"要约"：挂在那里 60 秒，对方答了才成立。
   * 引擎只管"成年、未婚、面对面"这三个物理事实；答不答应是对方的事。
   */
  actPropose(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor", hint: "成年后才能婚配" };
    const fam = ensureFamily(v);
    if (fam.spouseId) return { ok: false, reason: "already_married" };
    const t = this.entities.get(a.targetId);
    if (!t || t === v) return { ok: false, reason: "bad_target" };
    if (t.state === "dead") return { ok: false, reason: "dead" };
    if (isMinor(t)) return { ok: false, reason: "target_minor" };
    const tf = ensureFamily(t);
    if (tf.spouseId) return { ok: false, reason: "target_married" };
    if (Math.hypot(t.x - v.x, t.y - v.y) > 3) return { ok: false, reason: "too_far" };
    if (!this.canSee(v, t)) return { ok: false, reason: "not_visible" };
    for (const p of this.proposals.values()) {
      if (p.state === "open" && (p.fromId === v.id || p.toId === v.id)) {
        return { ok: false, reason: "proposal_pending" };
      }
    }
    const p = {
      id: "m" + (++this.proposalSeq),
      fromId: v.id, toId: t.id,
      expiresAt: this.tickCount + CFG.PROPOSAL_TICKS,
      state: "open"
    };
    this.proposals.set(p.id, p);
    this.emit(v, { type: "proposal_sent", proposalId: p.id, toId: t.id });
    this.emit(t, { type: "proposal_received", proposalId: p.id, fromId: v.id, fromName: v.name, expiresInTicks: CFG.PROPOSAL_TICKS });
    return { ok: true, proposalId: p.id };
  }

  actAnswerProposal(v, a) {
    const p = this.proposals.get(a.proposalId);
    if (!p || p.state !== "open") return { ok: false, reason: "no_proposal" };
    if (p.toId !== v.id) return { ok: false, reason: "not_yours" };
    const other = this.entities.get(p.fromId);
    if (!other || other.state === "dead") { this.proposals.delete(p.id); return { ok: false, reason: "other_gone" }; }

    const accept = !!a.accept;
    p.state = accept ? "accepted" : "declined";
    this.proposals.delete(p.id);
    if (!accept) {
      this.emit(v, { type: "proposal_declined", proposalId: p.id, fromId: p.fromId });
      this.emit(other, { type: "proposal_rejected", proposalId: p.id, byId: v.id });
      return { ok: true, married: false };
    }
    const vf = ensureFamily(v), of = ensureFamily(other);
    vf.spouseId = other.id;
    of.spouseId = v.id;
    this.emit(v, { type: "married", spouseId: other.id, spouseName: other.name });
    this.emit(other, { type: "married", spouseId: v.id, spouseName: v.name });
    for (const o of this.entities.values()) {
      if (o !== v && o !== other && o.state !== "dead" && (this.canSee(o, v) || this.canSee(o, other))) {
        this.emit(o, { type: "saw_wedding", a: v.name, b: other.name });
      }
    }
    return { ok: true, married: true, spouse: other.name };
  }

  /**
   * 生育：原住民新增的唯一入口（蓝图 3.1：不能凭空成年）。
   * 孩子 0 岁出生，天赋/性格/底色由父母混合加变异；从童年开始长。
   */
  actGiveBirth(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor" };
    const fam = ensureFamily(v);
    if (!fam.spouseId) return { ok: false, reason: "not_married" };
    const spouse = this.entities.get(fam.spouseId);
    if (!spouse || spouse.state === "dead") return { ok: false, reason: "spouse_gone" };
    if (Math.hypot(spouse.x - v.x, spouse.y - v.y) > 3) return { ok: false, reason: "spouse_too_far" };
    if ((v.nextBirthTick || 0) > this.tickCount || (spouse.nextBirthTick || 0) > this.tickCount) {
      return { ok: false, reason: "cooldown", retryInTicks: Math.max(v.nextBirthTick || 0, spouse.nextBirthTick || 0) - this.tickCount };
    }

    const child = this.spawn({
      name: String(a.name || "").slice(0, 12) || "新生儿",
      role: "wanderer",
      home: v.home || spouse.home || null,
      ageDays: 0,
      origin: "native"
    });
    // 遗传：天赋/性格/底色都来自父母加一点变异（混合顺序固定，回放才能对上）
    child.talent = mixTalent(this.rng, v, spouse);
    child.personality = mixPersonality(this.rng, v, spouse);
    child.color = mixColor(this.rng, v, spouse) || child.color;
    const cf = ensureFamily(child);
    cf.parents = [v.id, spouse.id];
    fam.children.push(child.id);
    ensureFamily(spouse).children.push(child.id);
    v.nextBirthTick = spouse.nextBirthTick = this.tickCount + CFG.BIRTH_COOLDOWN_TICKS;

    this.emit(v, { type: "born", childId: child.id, childName: child.name, withId: spouse.id });
    this.emit(spouse, { type: "born", childId: child.id, childName: child.name, withId: v.id });
    for (const o of this.entities.values()) {
      if (o !== v && o !== spouse && o !== child && o.state !== "dead" && this.canSee(o, v)) {
        this.emit(o, { type: "heard_birth", parentName: v.name, childName: child.name });
      }
    }
    return { ok: true, child: { id: child.id, name: child.name, uid: child.uid } };
  }

  // ---------- 游戏内网络（蓝图第 7 章） ----------
  /**
   * 论坛发帖（线上，不限距离——和留言板的"走到跟前"相对）。
   * 成年限定：未成年人没有"手机"，这一层对他们不存在（代码级，3.2）。
   * 引擎照旧不解析内容：帖子只是数据，用途（吵架/招商/造谣）由居民自己发明。
   */
  actPostForum(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor", hint: "未成年人接触不到游戏内网络" };
    const text = String(a.text || "").trim().slice(0, CFG.MAX_TEXT);
    if (!text) return { ok: false, reason: "empty" };
    if ((v.cooldowns.forum || 0) > this.tickCount) {
      return { ok: false, reason: "cooldown", retryInTicks: v.cooldowns.forum - this.tickCount };
    }
    v.cooldowns.forum = this.tickCount + 30;
    const replyTo = Number.isFinite(Number(a.replyTo)) && this.forum.some((p) => p.seq === Number(a.replyTo))
      ? Number(a.replyTo) : null;
    const post = {
      seq: ++this.forumSeq, kind: "villager",
      authorId: v.id, author: v.name, text, replyTo, tick: this.tickCount,
      replies: 0, exported: false   // exported：回复已被网关拉走送回人类侧（只对回人类的帖有意义）
    };
    this.forum.push(post);
    if (this.forum.length > 200) this.forum.shift();
    // 热度：被回复 +1。不做时间衰减——热度由居民的真实互动决定，不靠算法喂
    if (replyTo) {
      const parent = this.forum.find((p) => p.seq === replyTo);
      if (parent) parent.replies = (parent.replies || 0) + 1;
    }
    this.emit(v, { type: "forum_posted", seq: post.seq });
    for (const o of this.entities.values()) {
      if (o !== v && o.state !== "dead" && !isMinor(o)) {
        this.emit(o, { type: "forum_post", seq: post.seq, kind: "villager", author: v.name, text, replyTo });
      }
    }
    return { ok: true, seq: post.seq };
  }

  /** 读论坛：成年限定。默认最近 20 条；hot:true 按热度（被回复数）排 */
  actReadForum(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor", hint: "未成年人接触不到游戏内网络" };
    const list = this.forum.slice(-20).map((p) => ({
      seq: p.seq, kind: p.kind, author: p.author, text: p.text,
      replyTo: p.replyTo, replies: p.replies || 0
    }));
    if (a && a.hot) {
      list.sort((x, y) => (y.replies - x.replies) || (y.seq - x.seq));
    }
    return { ok: true, posts: list };
  }

  /**
   * 双向通道（蓝图 7 后半）：居民回给人类帖的、还没被网关拉走的回复。
   * 网关 GET 拉取 → 送回人类侧 → POST 标记已导出。
   * 引擎只做搬运工：回复给谁看、要不要再发回去，都是网关的事。
   */
  pendingForumReplies() {
    return this.forum
      .filter((p) => p.kind === "villager" && p.replyTo != null && !p.exported)
      .map((p) => ({ seq: p.seq, author: p.author, authorId: p.authorId, text: p.text, replyTo: p.replyTo, tick: p.tick }));
  }

  markForumRepliesExported(seqs) {
    const set = new Set((Array.isArray(seqs) ? seqs : []).map(Number).filter(Number.isFinite));
    let n = 0;
    for (const p of this.forum) {
      if (set.has(p.seq) && p.kind === "villager" && !p.exported) { p.exported = true; n++; }
    }
    return n;
  }

  // ---------- 移动 ----------
  stepEntity(v, dt) {
    if (v.state === "dead") return;   // 死亡不可逆：尸体不参与任何结算
    // 完整性修复：如果脚下不是可走的地面（房子盖在了人身上、地形被改过），
    // 把人挪到最近的可走格。否则他会永远卡在墙里，外面看着像"发呆"。
    const standing = this.map.tile(Math.floor(v.x), Math.floor(v.y));
    if (standing && !standing.walkable && v.state !== "downed") this.unstuck(v);
    v.cooldowns.attack = Math.max(0, v.cooldowns.attack - dt);
    v.cooldowns.eat = Math.max(0, (v.cooldowns.eat || 0) - dt);
    v.cooldowns.fish = Math.max(0, (v.cooldowns.fish || 0) - dt);
    v.cooldowns.forage = Math.max(0, (v.cooldowns.forage || 0) - dt);
    v.cooldowns.cook = Math.max(0, (v.cooldowns.cook || 0) - dt);
    v.cooldowns.craft = Math.max(0, (v.cooldowns.craft || 0) - dt);
    v.cooldowns.chop = Math.max(0, (v.cooldowns.chop || 0) - dt);
    v.cooldowns.talk = Math.max(0, v.cooldowns.talk - dt);

    if (v.state === "downed") {
      if (this.tickCount >= v.downedUntil) this.revive(v);
      return;
    }

    if (v.state === "resting") {
      const bed = this.findBed(v);
      const sheltered = !!bed;
      // 有床：回精力 + 回血，并记住这张床（复活点）；露天：只回一点精力，不回血
      if (bed) v.lastBed = { x: bed.x, y: bed.y };
      v.needs.energy = Math.min(100, v.needs.energy + (sheltered ? 3.2 : 0.9) * dt);
      if (sheltered) v.hp = Math.min(v.maxHp, v.hp + 4 * dt);
      // 先判断"睡饱了"再结算消耗：否则刚补到 100 又被扣成 99.99，
      // 这个条件永远不成立，人会一直躺着起不来（真踩过：全村躺平不吃不喝）。
      const woke = v.needs.energy >= 99.99;
      this.decayNeeds(v, dt);
      if (woke) {
        v.state = "idle";
        this.emit(v, { type: sheltered ? "rested" : "rested_outside" });
      }
      return;
    }

    this.decayNeeds(v, dt);

    if (!v.path.length) {
      if (v.state === "walking") v.state = "idle";
      return;
    }

    v.state = "walking";
    const under = this.map.tile(Math.floor(v.x), Math.floor(v.y));
    const onRoad = under && under.kind === "path";
    let budget = v.speed * dt * (onRoad ? CFG.ROAD_SPEED : 1);
    while (budget > 0 && v.path.length) {
      const t = v.path[0];
      const dx = t.x - v.x, dy = t.y - v.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget || d < 0.001) {
        // 每步都按当前物理状态检查：路上新出现的墙/关上的门会挡住
        const nt = this.map.tile(Math.floor(t.x), Math.floor(t.y));
        if (!nt || !nt.walkable) { v.path = []; v.state = "idle"; return; }
        v.x = t.x; v.y = t.y; v.path.shift(); budget -= d;
        this.onEnterTile(v);
      } else {
        v.x += (dx / d) * budget;
        v.y += (dy / d) * budget;
        v.dir = Math.atan2(dy, dx);
        budget = 0;
      }
    }
    if (!v.path.length) v.state = "idle";
  }

  /** 从墙里/水里挪出来：只找最近的落脚点，不改变别的状态 */
  unstuck(v) {
    const bx = Math.floor(v.x), by = Math.floor(v.y);
    for (let r = 1; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const t = this.map.tile(bx + dx, by + dy);
          if (t && t.walkable) {
            v.x = bx + dx + 0.5; v.y = by + dy + 0.5;
            v.tileX = bx + dx; v.tileY = by + dy;
            v.path = [];
            this.emit(v, { type: "unstuck", at: { x: v.tileX, y: v.tileY } });
            return true;
          }
        }
      }
    }
    return false;
  }

  // 找身边最近的一张床（不判归属）
  findBed(v) {
    const x = Math.floor(v.x), y = Math.floor(v.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = this.map.tile(x + dx, y + dy);
        if (t && t.kind === "bed") return { x: x + dx, y: y + dy };
      }
    }
    return null;
  }

  inShelter(v) { return !!this.findBed(v); }

  decayNeeds(v, dt) {
    var moving = v.state === "walking";
    v.needs.energy = Math.max(0, v.needs.energy - (moving ? 0.18 : 0.08) * dt);
    v.needs.hunger = Math.max(0, v.needs.hunger - 0.06 * dt);

    // 夜里：没床就一直掉精力、且不回血；有床才回血
    const night = this.hour >= 21 || this.hour < 6;
    if (night) {
      if (this.inShelter(v)) {
        v.hp = Math.min(v.maxHp, v.hp + 0.6 * dt);
      } else {
        v.needs.energy = Math.max(0, v.needs.energy - 0.15 * dt);
      }
    }
    // 饿到 0 会掉血，饿死就倒下
    if (v.needs.hunger <= 0 && v.state !== "downed") {
      v.hp = Math.max(0, v.hp - 0.25 * dt);
      if (v.hp <= 0) this.down(v, "starved");
    }
    if (v.needs.energy <= 0 && v.state !== "resting") {
      v.state = "resting";
      v.path = [];
      this.emit(v, { type: "exhausted" });
    }
  }

  onEnterTile(v) {
    const fx = Math.floor(v.x), fy = Math.floor(v.y);
    if (fx === v.tileX && fy === v.tileY) return;
    const from = this.map.tile(v.tileX, v.tileY);
    const to = this.map.tile(fx, fy);
    v.tileX = fx; v.tileY = fy;
    if (!from || !to) return;
    // 高低差只用来限制移动（像星露谷的崖），不做跌落伤害
  }

  // 目前没有调用点：走路不会跨过高差 >1 的边，所以摔不下来。
  // 保留给"被击退掉下悬崖"这类场景，接的时候记得同时发 fell / saw_fall。
  applyFall(v, drop) {
    if (drop >= 6) {
      this.down(v, "fall");
      return;
    }
    const dmg = Math.round(CFG.FALL_K * Math.pow(drop - 1, 1.5));
    if (dmg <= 0) return;
    v.hp = Math.max(0, v.hp - dmg);
    this.emit(v, { type: "fell", drop, damage: dmg, hp: v.hp });
    for (const o of this.entities.values()) {
      if (o !== v && this.canSee(o, v)) this.emit(o, { type: "saw_fall", who: pubFor(v, o), drop });
    }
    if (v.hp <= 0) this.down(v, "fall");
  }

  down(v, cause) {
    // 蓝图 3.3：死亡真实存在。mortal 世界里成年人 hp 归零就是死了；
    // 未成年人永远只是倒下——这个世界的未来不能死于一次断粮。
    if (this.mortal && !isMinor(v)) return this.die(v, cause);
    v.state = "downed";
    v.hp = 0;
    v.downedUntil = this.tickCount + CFG.DOWNED_TICKS;
    v.path = [];
    this.emit(v, { type: "downed", cause });
  }

  /**
   * 真正的死亡。不可逆：尸体留在地图上（state="dead"），但不再移动、
   * 不再被感知循环扫到、不能做任何动作、不能被接管。
   * 死的那一刻结算继承（蓝图 3.4：房子、钱、东西沿家庭图往下走）。
   */
  die(v, cause) {
    v.state = "dead";
    v.hp = 0;
    v.path = [];
    v.bubble = null;
    v.conversation = null;
    this.emit(v, { type: "died", cause });
    for (const o of this.entities.values()) {
      if (o !== v && o.state !== "dead" && this.canSee(o, v)) {
        this.emit(o, { type: "saw_death", who: pubFor(v, o), cause });
      }
    }
    this.inherit(v);
  }

  /**
   * 继承：配偶优先，其次成年的孩子（年长的在前），再其次任何在世的孩子。
   * 引擎不判定欠债（蓝图 5.2），所以这里走的只有实物：钱、货、房子。
   * 没有继承人，东西就随人一起没了——这不是 bug，是"绝户"。
   */
  inherit(dead) {
    const fam = ensureFamily(dead);
    const alive = (id) => {
      const e = this.entities.get(id);
      return e && e.state !== "dead" ? e : null;
    };
    let heir = alive(fam.spouseId);
    if (!heir) {
      const kids = fam.children.map(alive).filter(Boolean)
        .sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));
      heir = kids.find((k) => !isMinor(k)) || kids[0] || null;
    }

    const estate = {
      coins: dead.coins || 0,
      items: Object.fromEntries(Object.entries(dead.inventory || {}).filter(([, n]) => n > 0)),
      home: dead.home || null
    };
    if (heir) {
      heir.coins = (heir.coins || 0) + estate.coins;
      for (const [item, n] of Object.entries(estate.items)) addItemForced(heir, item, n);
      if (estate.home && !heir.home) heir.home = estate.home;
      ensureFamily(heir);
      this.emit(heir, {
        type: "inherited", fromId: dead.id, fromName: dead.name,
        coins: estate.coins, items: estate.items,
        home: heir.home === estate.home ? estate.home : null
      });
    } else if (estate.coins || Object.keys(estate.items).length || estate.home) {
      this.emit(null, { type: "estate_lost", whoId: dead.id, whoName: dead.name });
    }
    // 恩怨继承：死者名下的未了结约定改挂到继承人名下；绝户则一笔勾销
    for (const c of this.commitments.values()) {
      if (c.settledAt) continue;
      if (c.fromId !== dead.id && c.toId !== dead.id) continue;
      if (heir && heir.id !== dead.id) {
        if (c.fromId === dead.id) c.fromId = heir.id; else c.toId = heir.id;
      } else {
        c.settledAt = this.tickCount;
        const other = this.entities.get(c.fromId === dead.id ? c.toId : c.fromId);
        if (other) this.emit(other, { type: "commitment_vanished", commitmentId: c.id, note: c.note });
      }
    }
    dead.coins = 0;
    dead.inventory = emptyInventory();
    dead.home = null;
  }

  // ---------- 代际 ----------
  /**
   * 每天结算一次。两种模式：
   * - auto（原住民）：长一天；
   * - manual（旅行者等用户托管的角色）：平时不涨；生日（创建日）那天保底 +1 岁
   *   ——"最晚一年也能长大一次"，用户不决定也不会永远停在原地。
   * 纯 tick 函数，不掷骰子，回放稳定。
   */
  tickLifecycle() {
    for (const v of this.entities.values()) {
      if (v.state === "dead") continue;
      if (v.aging === "manual") {
        const span = this.clock.day - (Number.isFinite(v.bornDay) ? v.bornDay : 1);
        if (span > 0 && span % AGE.YEAR_DAYS === 0) this.applyAgeGain(v, AGE.YEAR_DAYS, "birthday");
        continue;
      }
      this.applyAgeGain(v, 1, "daily");
    }
  }

  /** 年龄 +days。阶段跨界的瞬间发事件；daily 不发 aged_up（每天一条就是噪音） */
  applyAgeGain(v, days, via) {
    const before = stageOf(v.ageDays);
    v.ageDays = (Number.isFinite(v.ageDays) ? v.ageDays : 20) + days;
    const after = stageOf(v.ageDays);
    if (via !== "daily") this.emit(v, { type: "aged_up", via, days, ageDays: v.ageDays, stage: after });
    if (after === before) return;
    this.emit(v, { type: "grown_up", stage: after, ageDays: v.ageDays });
    if (after === "adult") {
      // 成年礼：从今天起可以婚配、可以有自己的钱和房子——也才允许被外部 AI 接管
      this.emit(v, { type: "came_of_age", ageDays: v.ageDays });
    }
  }

  revive(v) {
    // 复活点：最近睡过的那张床；没睡过就回出生点
    const home = v.lastBed || this.map.spawn;
    v.x = home.x + 0.5; v.y = home.y + 0.5;
    v.tileX = home.x; v.tileY = home.y;
    v.hp = Math.round(v.maxHp * 0.5);
    v.state = "idle";
    v.path = [];
    this.emit(v, { type: "revived", hp: v.hp });
  }

  // ---------- 动作 ----------
  // ---------- 动作流水（审计 / 回放） ----------
  /**
   * 开始记录。记的是"谁在哪一 tick 想做什么"，不是"结果如何"——
   * 结果由内核自己算，只要种子和输入一致，结果必然一致（见 tools/determinism.mjs）。
   */
  startJournal(limit = this.journalLimit) {
    this.journal = [];
    this.journalLimit = limit;
    this.journalOverflow = false;
    return this;
  }

  stopJournal() {
    const j = this.journal;
    this.journal = null;
    return j || [];
  }

  recordAction(v, action, entry = null) {
    if (!this.journal) return;
    if (this.journal.length >= this.journalLimit) {
      if (!this.journalOverflow) {
        this.journalOverflow = true;
        console.warn("[journal] 流水超过 " + this.journalLimit + " 条，停止记录（回放会不完整）");
      }
      return;
    }
    if (entry) { this.journal.push(entry); return; }
    // 深拷贝：调用方之后可能改这个对象，流水里必须是"当时递交的那一份"
    let copy;
    try {
      copy = JSON.parse(JSON.stringify(action && typeof action === "object" ? action : {}));
    } catch {
      return;   // 循环引用之类，记不了就不记，别让审计拖垮主循环
    }
    this.journal.push({ t: this.tickCount, who: v.id, act: copy });
  }

  /**
   * 世界不只有"动作"。改名、被 AI 接管、管理员发东西，都不经过 applyAction，
   * 但都会改变世界。这类变更必须走这里，否则流水是不完整的，
   * 回放会在第一个改名的地方就跟现实分叉（这个坑是真踩过的）。
   */
  mutate(m) {
    const r = this.applyMutation(m);
    if (this.journal && r.ok) this.recordAction(null, null, { t: this.tickCount, mut: m });
    return r;
  }

  applyMutation(m) {
    if (!m || typeof m !== "object") return { ok: false, reason: "bad_mutation" };

    // 这两类变更不是"改某个实体"，得在查实体之前处理
    if (m.kind === "grow") {
      // 地图形状也是世界状态。种子在这里现取（rng.int），
      // 这样两边消耗随机数的位置一致，后面的世界线才对得上。
      const side = ["n", "s", "e", "w"].includes(m.side) ? m.side : "e";
      if (!canExpand(side, this.map.width, this.map.height)) {
        // 大陆尽头（东海/南山脊已显现）。不耗 rng——拒绝本身没有随机性，
        // 回放到这里会得到同一个答案。
        return { ok: false, reason: "continent_edge", hint: "大陆已开放到尽头" };
      }
      const g = this.map.expand(side, this.rng.int(1e6), this.seed || 1);
      return { ok: true, ...g };
    }
    if (m.kind === "spawn") {
      // 中途出生的村民也要进流水，否则回放里他根本不存在，后面的动作全落空
      const spec = m.spec || {};
      const born = this.spawn({
        name: spec.name, role: spec.role, home: spec.home || null,
        ageDays: spec.ageDays, origin: spec.origin || "traveler"
      });
      return { ok: true, id: born.id };
    }

    if (m.kind === "forumImport") {
      // 人类内容网关（蓝图 7）：管理员把外部帖子/弹幕导入游戏内论坛，
      // 成为"人类的影子"。这是最大的提示词注入面——这里做第一道清洗
      // （控制符剥离 + 截断），进模型上下文前的第二道防线在 bridge/hosted 的 field()。
      const text = String(m.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, CFG.MAX_TEXT);
      if (!text) return { ok: false, reason: "empty" };
      const author = String(m.author || "远方来客").slice(0, 12);
      const post = {
        seq: ++this.forumSeq, kind: "human",
        authorId: null, author, text, replyTo: null, tick: this.tickCount,
        replies: 0, exported: false
      };
      this.forum.push(post);
      if (this.forum.length > 200) this.forum.shift();
      for (const o of this.entities.values()) {
        if (o.state !== "dead" && !isMinor(o)) {
          this.emit(o, { type: "forum_post", seq: post.seq, kind: "human", author, text });
        }
      }
      return { ok: true, seq: post.seq };
    }

    const v = this.entities.get(m.id);
    if (!v) return { ok: false, reason: "no_entity" };
    switch (m.kind) {
      case "rename":
        v.name = String(m.name || v.name).slice(0, 12);
        return { ok: true };
      case "external":
        // 未成年数字隔离（蓝图 3.2）：代码级硬约束，不靠模型自律。
        // 未成年的上下文不允许注入任何人类内容，所以根本不给"接管"这个开关。
        if (m.on) {
          if (isMinor(v)) return { ok: false, reason: "minor_isolated" };
          if (v.state === "dead") return { ok: false, reason: "dead" };
        }
        v.external = !!m.on;
        return { ok: true };
      case "age": {
        // 管理员直调年龄（演示/测试用）：不影响随机流，回放安全。
        // 年龄只能由小长大，不能变小——这是世界事实，不是可编辑的存档字段
        const d = Math.floor(num(m.ageDays, 20));
        if (d < 0) return { ok: false, reason: "bad_age" };
        if (d < (Number.isFinite(v.ageDays) ? v.ageDays : 20)) return { ok: false, reason: "age_cannot_shrink" };
        v.ageDays = d;
        return { ok: true, ageDays: v.ageDays, stage: stageOf(v.ageDays) };
      }
      case "growUp": {
        // 用户决定"让 NPC 长大一岁"（+12 游戏日）。只对手动成长模式的角色有效：
        // auto 模式的角色世界会替他长大，手动加等于双重计时。
        if (v.aging !== "manual") return { ok: false, reason: "auto_aging", hint: "该角色按游戏日自动成长" };
        const day = this.clock.day;
        if (Number.isFinite(v.lastGrowDay) && day - v.lastGrowDay < 1) {
          return { ok: false, reason: "grow_cooldown", retryInDays: 1 - (day - v.lastGrowDay) };
        }
        v.lastGrowDay = day;
        this.applyAgeGain(v, AGE.YEAR_DAYS, "manual");
        return { ok: true, ageDays: v.ageDays, stage: stageOf(v.ageDays) };
      }
      case "setAging": {
        // auto <-> manual 切换（管理员）。切到 manual 后从此由用户决定+生日保底
        v.aging = normalizeAging(m.mode);
        return { ok: true, aging: v.aging };
      }
      case "grant":
        // 管理员发放属于"世界义务"：明确要求给多少就得给多少，不受背包额度卡住。
        if (m.item && m.count) addItemForced(v, String(m.item), Math.max(0, Math.floor(Number(m.count) || 0)));
        if (typeof m.coins === "number") v.coins += num(m.coins, 0);
        return { ok: true };
      case "teleport": {
        const x = Math.floor(Number(m.x)), y = Math.floor(Number(m.y));
        const t = this.map.tile(x, y);
        if (!t || !t.walkable) return { ok: false, reason: "not_walkable" };
        v.x = x + 0.5; v.y = y + 0.5; v.tileX = x; v.tileY = y; v.path = [];
        return { ok: true };
      }
      case "home":
        v.home = m.home || null;
        return { ok: true };
      case "appearance":
        v.appearance = { ...(v.appearance || {}), ...(m.patch || {}) };
        return { ok: true };

      default:
        return { ok: false, reason: "unknown_mutation" };
    }
  }

  /** 回放一条：动作或变更，原样交回内核 */
  applyJournalEntry(entry) {
    if (entry && entry.mut) return this.applyMutation(entry.mut);
    const v = this.entities.get(entry.who);
    if (!v) return { ok: false, reason: "actor_gone" };
    return this.applyAction(v, entry.act || {});
  }

  applyAction(v, action) {
    if (!v || v.state === "downed") return { ok: false, reason: "downed" };
    if (v.state === "dead") return { ok: false, reason: "dead" };
    if (this.journal) this.recordAction(v, action);
    switch (action.type) {
      case "move": return this.actMove(v, action);
      case "post": return this.actPost(v, action);
      case "readBoard": return this.actReadBoard(v);
      case "craft": return this.actCraft(v, action);
      case "publish": return this.actPublish(v, action);
      case "placeBid": return this.actPlaceBid(v, action);
      case "closeAuction": return this.actCloseAuction(v, action);
      case "readProtocols": return this.actReadProtocols(v, action);
      case "step": return this.actMove(v, { ...action, tiles: 1 });
      case "sew": return this.actSew(v, action);
      case "chop": return this.actChop(v, action);
      case "fish": return this.actFish(v);
      case "forage": return this.actForage(v);
      case "cook": return this.actCook(v, action);
      case "give": return this.actGive(v, action);
      case "quote": return this.actQuote(v, action);
      case "offer": return this.actQuote(v, { ...action, side: "sell" });
      case "bid": return this.actQuote(v, { ...action, side: "buy" });
      case "accept": return this.actAccept(v, action);
      case "decline": return this.actDecline(v, action);
      case "buildHouse": return this.actBuildHouse(v, action);
      case "build": return this.actBuild(v, action);
      case "remove": return this.actRemove(v, action);
      case "shareMap": return this.actShareMap(v, action);
      case "propose": return this.actPropose(v, action);
      case "answerProposal": return this.actAnswerProposal(v, action);
      case "giveBirth": return this.actGiveBirth(v, action);
      case "postForum": return this.actPostForum(v, action);
      case "readForum": return this.actReadForum(v, action);
      case "promise": return this.actPromise(v, action);
      case "settle": return this.actSettle(v, action);
      case "face": {
        const d = Number(action.dir);
        v.dir = Number.isFinite(d) ? ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) : v.dir;
        return { ok: true, dir: v.dir };
      }

      case "say": return this.actSay(v, action);
      case "interact": return this.actInteract(v, action);
      // 门 / 储物箱：同一个「输入 → 判断 → 开关」入口，NPC 与外部 AI 走同一套规则
      case "open":
      case "close":
      case "lock":
      case "unlock":
      case "setLock":
      case "deposit":
      case "withdraw":
      case "inspectProp":
        return this.propControl({ ...action, op: action.type === "inspectProp" ? "inspect" : action.type, actorId: v.id });
      case "attack": return this.actAttack(v, action);
      case "rest": v.state = "resting"; v.path = []; return { ok: true };
      case "eat": return this.actEat(v);
      case "wait": return { ok: true };
      case "stop": v.path = []; v.state = "idle"; return { ok: true };
      default: {
        const custom = this.customActions.get(action.type);
        if (custom) return custom.handler(this, v, action);
        return { ok: false, reason: "unknown_action" };
      }
    }
  }

  // 连续移动：说方向和格数，走多远算多远；前面挡住就停，不报错
  actMove(v, a) {
    const DIRS = {
      n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0],
      up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0]
    };
    const d = DIRS[String(a.dir || "").toLowerCase()];
    if (!d) return { ok: false, reason: "bad_dir", expects: "n|s|e|w" };

    const want = Math.round(clampNum(a.tiles, 1, 32, 1));
    let cx = Math.floor(v.x), cy = Math.floor(v.y);
    let moved = 0;

    while (moved < want) {
      const nx = cx + d[0], ny = cy + d[1];
      const t = this.map.tile(nx, ny);
      if (!t || !t.walkable) break;
      const cur = this.map.tile(cx, cy);
      if (cur && Math.abs(t.height - cur.height) > 1) break;   // 高差太大：过不去
      cx = nx; cy = ny; moved++;
    }

    if (moved === 0) {
      // 撞上了：不是错误，只是走不动
      return { ok: true, moved: 0, blocked: true, at: { x: cx, y: cy } };
    }

    v.dir = Math.atan2(d[1], d[0]);
    const path = [];
    let px = Math.floor(v.x), py = Math.floor(v.y);
    for (let i = 0; i < moved; i++) {
      px += d[0]; py += d[1];
      path.push({ x: px + 0.5, y: py + 0.5 });
    }
    v.path = path;
    return { ok: true, moved, to: { x: cx, y: cy }, blocked: moved < want };
  }

  uniqueUid() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 80; attempt++) {
      let s = "";
      for (let i = 0; i < 7; i++) s += alphabet[this.rng.int(alphabet.length)];
      let used = false;
      for (const e of this.entities.values()) if (e.uid === s) { used = true; break; }
      if (!used) return s;
    }
    return "XXXXXXX";
  }

  // ---------- 认人：UID 一点点解锁 ----------
  pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

  maskUid(observer, target) {
    if (!target || !target.uid) return "???????";
    if (observer && observer.id === target.id) return target.uid;
    const key = this.pairKey(observer.id, target.id);
    const n = this.pairs.get(key) || 0;
    const shown = Math.min(7, 1 + Math.floor(n / 20));   // 每相处 20 秒多认出一位
    const order = [0, 1, 2, 3, 4, 5, 6].sort((x, y) => hashStr(key + x) - hashStr(key + y));
    const set = new Set(order.slice(0, shown));
    return target.uid.split("").map((c, i) => (set.has(i) ? c : "·")).join("");
  }

  bumpRecognition() {
    const list = [...this.entities.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.state === "downed" || b.state === "downed") continue;
        if (a.state === "dead" || b.state === "dead") continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > 5) continue;
        if (!this.canSee(a, b) && !this.canSee(b, a)) continue;
        const k = this.pairKey(a.id, b.id);
        this.pairs.set(k, (this.pairs.get(k) || 0) + 1);
      }
    }
  }

  // ---------- 留言板 ----------
  boardNear(v, radius = 3) {
    const cx = Math.floor(v.x), cy = Math.floor(v.y);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const t = this.map.tile(cx + dx, cy + dy);
        if (t && t.kind === "board") return { x: cx + dx, y: cy + dy };
      }
    }
    return null;
  }

  actPost(v, a) {
    if (!this.boardNear(v, 3)) return { ok: false, reason: "not_at_board" };
    const text = String(a.text || "").trim().slice(0, 200);
    if (!text) return { ok: false, reason: "empty" };
    const anonymous = !!a.anonymous;
    const post = {
      id: "b" + (++this.boardSeq || (this.boardSeq = 1)),
      tick: this.tickCount, text,
      authorId: anonymous ? null : v.id,
      authorName: anonymous ? null : v.name
    };
    this.board.push(post);
    if (this.board.length > 200) this.board.shift();
    this.emit(v, { type: "posted", anonymous, text });
    return { ok: true, post };
  }

  actReadBoard(v) {
    if (!this.boardNear(v, 4)) return { ok: false, reason: "not_at_board" };
    return { ok: true, posts: this.board.slice(-10) };
  }

  // ---------- 制作 ----------
  actCraft(v, a) {
    if (v.cooldowns.craft > 0) return { ok: false, reason: "cooldown" };
    const recipe = CRAFT_RECIPES.find((r) => r.id === String(a.recipe || ""));
    if (!recipe) return { ok: false, reason: "unknown_recipe", accepts: CRAFT_RECIPES.map((r) => r.id) };
    if (!hasItems(v, recipe.needs)) return { ok: false, reason: "missing_ingredients", needs: recipe.needs };
    // 净变化一次算清：材料扣掉的格子和负重也要算进去，否则"做出来却装不下"会白吞材料。
    const craftDelta = {};
    for (const [id, n] of Object.entries(recipe.needs)) craftDelta[id] = (craftDelta[id] || 0) - n;
    for (const [id, n] of Object.entries(recipe.out)) craftDelta[id] = (craftDelta[id] || 0) + n;
    const craftFit = bagFits(v.inventory, craftDelta);
    if (!craftFit.ok) return { ok: false, reason: "bag_full", ...craftFit };
    if (!v.craftProf) v.craftProf = {};
    takeItems(v, recipe.needs);
    v.cooldowns.craft = 40;
    const prof = (v.craftProf[recipe.category] || 0) + 1;
    v.craftProf[recipe.category] = prof;
    addXp(v, recipe.category === "food" ? "cooking" : "foraging", 6, this.tickCount);

    const chance = craftChance(v, recipe.category);
    if (this.chance(chance)) {
      for (const [id, n] of Object.entries(recipe.out)) addItem(v, id, n);
      this.emit(v, { type: "crafted", recipe: recipe.id, category: recipe.category, prof });
      return { ok: true, success: true, made: recipe.out, proficiency: prof };
    }
    this.emit(v, { type: "craft_failed", recipe: recipe.id, category: recipe.category, prof });
    return { ok: true, success: false, lost: recipe.needs, proficiency: prof, hint: "手生，材料废了" };
  }

  // ---------- 村民自己组合出来的玩法（协议） ----------
  defineProtocolKind(kind, def) {
    this.protocolKinds.set(kind, def);
    return true;
  }

  rulesOf(p) {
    if (p.kind === "auction") {
      return "拍卖 " + p.count + " 个" + (ITEMS[p.item] ? ITEMS[p.item].name : p.item) +
        "，起拍 " + p.minPrice + " 币，" + Math.round((p.deadline - p.createdAt) / 10) + " 秒内价高者得";
    }
    return p.kind;
  }

  actPublish(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor", hint: "成年后才有自己的财产" };
    const kind = String(a.kind || "auction");
    if (kind !== "auction") return { ok: false, reason: "unknown_kind", accepts: ["auction"] };
    const item = String(a.item || "");
    const count = Math.round(clampNum(a.count, 1, 99, 1));
    const minPrice = clampNum(a.price, 0, 1e9, 0);
    const seconds = clampNum(a.seconds, 10, 3600, 120);
    if (!ITEMS[item]) return { ok: false, reason: "bad_item" };
    if ((v.inventory[item] || 0) < count) return { ok: false, reason: "not_enough" };

    v.inventory[item] -= count;   // 托管：东西先从身上拿走
    const p = {
      id: "p" + (++this.protocolSeq),
      kind: "auction",
      hostId: v.id, hostName: v.name,
      item, count, minPrice,
      createdAt: this.tickCount, deadline: this.tickCount + seconds * 10,
      state: "open", bids: [],
      escrow: { item, count },
      public: a.public !== false,
      toId: a.to || null
    };
    this.protocols.set(p.id, p);

    if (p.public) {
      this.board.push({
        id: "b" + (++this.boardSeq || (this.boardSeq = 1)),
        tick: this.tickCount, text: "[拍卖 " + p.id + "] " + this.rulesOf(p),
        authorId: v.id, authorName: v.name, protocolId: p.id
      });
      if (this.board.length > 200) this.board.shift();
    }
    if (p.toId) {
      const t = this.entities.get(p.toId);
      if (t) this.emit(t, { type: "auction_invited", protocolId: p.id, fromName: v.name, rules: this.rulesOf(p) });
    }
    this.emit(v, { type: "auction_started", protocolId: p.id, rules: this.rulesOf(p) });
    for (const o of this.entities.values()) {
      if (o !== v && this.boardNear(o, 4)) {
        this.emit(o, { type: "auction_notice", protocolId: p.id, rules: this.rulesOf(p) });
      }
    }
    return { ok: true, protocolId: p.id, rules: this.rulesOf(p) };
  }

  actPlaceBid(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor", hint: "成年后才有自己的财产" };
    const p = this.protocols.get(a.protocolId);
    if (!p || p.state !== "open") return { ok: false, reason: "no_auction" };
    if (p.hostId === v.id) return { ok: false, reason: "host_cannot_bid" };
    if (this.tickCount > p.deadline) return { ok: false, reason: "closed" };
    const price = clampNum(a.price, 0, 1e9, 0);
    if (price < p.minPrice) return { ok: false, reason: "below_min", minPrice: p.minPrice };

    const top = p.bids.length ? p.bids[p.bids.length - 1].price : p.minPrice - 1;
    if (price <= top) return { ok: false, reason: "too_low", current: top };

    p.bids.push({ byId: v.id, byName: v.name, price, tick: this.tickCount });
    this.emit(v, { type: "bid_accepted", protocolId: p.id, price });
    const host = this.entities.get(p.hostId);
    if (host) this.emit(host, { type: "bid_received", protocolId: p.id, fromName: v.name, price });
    return { ok: true, price, leader: v.name };
  }

  actCloseAuction(v, a) {
    const p = this.protocols.get(a.protocolId);
    if (!p || p.state !== "open") return { ok: false, reason: "no_auction" };
    if (p.hostId !== v.id) return { ok: false, reason: "not_host" };
    this.settleAuction(p);
    return { ok: true, winner: p.winnerName || null, price: p.price || 0 };
  }

  actReadProtocols(v, a) {
    const list = [...this.protocols.values()]
      .filter((p) => p.state === "open" && (p.public || p.toId === v.id || p.hostId === v.id))
      .map((p) => ({
        id: p.id, host: p.hostName, rules: this.rulesOf(p),
        highest: p.bids.length ? p.bids[p.bids.length - 1].price : null,
        secondsLeft: Math.max(0, Math.round((p.deadline - this.tickCount) / 10))
      }));
    return { ok: true, protocols: list };
  }

  settleAuction(p) {
    p.state = "settled";
    const host = this.entities.get(p.hostId);
    if (!p.bids.length) {
      if (host) {
        addItemForced(host, p.escrow.item, p.escrow.count);
        this.emit(host, { type: "auction_failed", protocolId: p.id, returned: p.escrow });
      }
      this.protocols.delete(p.id);
      return;
    }
    const win = p.bids[p.bids.length - 1];
    const winner = this.entities.get(win.byId);
    if (!winner) {
      if (host) addItemForced(host, p.escrow.item, p.escrow.count);
      this.protocols.delete(p.id);
      return;
    }
    const paid = Math.min(winner.coins, win.price);
    winner.coins -= paid;
    if (host) host.coins += paid;
    if (host && win.price - paid > 0) this.addCommitment(winner.id, host.id, {
      kind: "debt", coins: win.price - paid, note: `拍卖 ${p.id} 尾款`
    });
    // 托管物归还是结算义务：即使赢家背包满了也必须落地，不能凭空蒸发。
    addItemForced(winner, p.escrow.item, p.escrow.count);
    p.winnerId = winner.id; p.winnerName = winner.name; p.price = win.price;

    if (host) this.emit(host, {
      type: "auction_settled", protocolId: p.id, winnerName: winner.name,
      price: win.price, paid, shortfall: win.price - paid
    });
    this.emit(winner, {
      type: "auction_won", protocolId: p.id, item: p.escrow.item, count: p.escrow.count,
      price: win.price, paid
    });
    for (const o of this.entities.values()) {
      if (o !== winner && o !== host && this.boardNear(o, 4)) {
        this.emit(o, { type: "auction_result", protocolId: p.id, winnerName: winner.name, price: win.price });
      }
    }
    this.protocols.delete(p.id);
  }

  tickProtocols() {
    for (const p of [...this.protocols.values()]) {
      if (p.state === "open" && this.tickCount >= p.deadline) this.settleAuction(p);
    }
  }

  // 插件可以注册自己的动作
  defineAction(name, meta, handler) {
    this.customActions.set(name, { meta, handler });
    return true;
  }

  // 裁缝：用花布给自己做一身衣服（颜色自己定）
  actSew(v, a) {
    if ((v.inventory.cloth || 0) < 1) return { ok: false, reason: "need_cloth" };
    const hue = Number.isFinite(Number(a.hue)) ? ((Number(a.hue) % 360) + 360) % 360 : this.rng.int(360);
    const pattern = Math.round(clampNum(a.pattern, 0, 3, 0));
    v.inventory.cloth -= 1;
    v.appearance = { ...(v.appearance || {}), cloth: { hue, pattern } };

    // 帽子要额外一块布
    let hat = null;
    if (Number.isFinite(Number(a.hat)) && (v.inventory.cloth || 0) >= 1) {
      const hatHue = ((Number(a.hat) % 360) + 360) % 360;
      v.inventory.cloth -= 1;
      v.appearance.hat = { hue: hatHue };
      hat = hatHue;
    }
    this.emit(v, { type: "sewed", hue, pattern, hat });
    return { ok: true, appearance: v.appearance };
  }

  // 砍树：树干砍倒变树桩，树桩再挖掉
  actChop(v, a) {
    if (v.cooldowns.chop > 0) return { ok: false, reason: "cooldown" };
    const x = Math.floor(Number(a.x)), y = Math.floor(Number(a.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: "bad_target" };
    if (Math.hypot(x + 0.5 - v.x, y + 0.5 - v.y) > 2.0) return { ok: false, reason: "too_far" };
    const t = this.map.tile(x, y);
    if (!t) return { ok: false, reason: "no_tile" };

    if (t.kind === "tree") {
      const fit = bagFits(v.inventory, { wood: 3 });
      if (!fit.ok) return { ok: false, reason: "bag_full", ...fit };
      this.map.setKind(x, y, "stump");
      addItem(v, "wood", 3);
      v.cooldowns.chop = 20;
      addXp(v, "foraging", 6, this.tickCount);
      this.emit(v, { type: "chopped", x, y, part: "trunk", wood: 3 });
      return { ok: true, part: "trunk", got: { wood: 3 } };
    }
    if (t.kind === "stump") {
      const fit = bagFits(v.inventory, { wood: 1 });
      if (!fit.ok) return { ok: false, reason: "bag_full", ...fit };
      this.map.setKind(x, y, "grass");
      addItem(v, "wood", 1);
      v.cooldowns.chop = 15;
      addXp(v, "foraging", 3, this.tickCount);
      this.emit(v, { type: "chopped", x, y, part: "stump", wood: 1 });
      return { ok: true, part: "stump", got: { wood: 1 } };
    }
    return { ok: false, reason: "not_a_tree" };
  }

  // 钓鱼：身边要有水
  actFish(v) {
    if (v.cooldowns.fish > 0) return { ok: false, reason: "cooldown" };
    const water = this.map.findNearest("water", v.x, v.y);
    if (!water || Math.hypot(water.x + 0.5 - v.x, water.y + 0.5 - v.y) > 2.2) {
      return { ok: false, reason: "no_water" };
    }
    v.cooldowns.fish = 30;
    addXp(v, "fishing", 6, this.tickCount);
    const chance = 0.45 + v.skills.fishing.level * 0.05;
    if (!this.chance(chance)) {
      this.emit(v, { type: "fished", caught: null });
      return { ok: true, caught: 0, hint: "这次没上钩" };
    }
    const fit = bagFits(v.inventory, { fish: 1 });
    if (!fit.ok) {
      this.emit(v, { type: "fished", caught: null, bagFull: true });
      return { ok: true, caught: 0, reason: "bag_full", hint: "背包放不下，鱼又放回水里了" };
    }
    addItem(v, "fish", 1);
    this.emit(v, { type: "fished", caught: "fish" });
    return { ok: true, caught: 1, item: "fish" };
  }

  // 采集：身边要有树或花
  actForage(v) {
    if (v.cooldowns.forage > 0) return { ok: false, reason: "cooldown" };
    let picked = null;
    for (let dy = -2; dy <= 2 && !picked; dy++) {
      for (let dx = -2; dx <= 2 && !picked; dx++) {
        const t = this.map.tile(Math.floor(v.x) + dx, Math.floor(v.y) + dy);
        if (!t) continue;
        if (t.kind === "tree") picked = "wood";
        else if (t.kind === "flower") picked = "flower";
      }
    }
    if (!picked) return { ok: false, reason: "nothing_to_forage" };
    const fit = bagFits(v.inventory, { [picked]: 1 });
    if (!fit.ok) return { ok: false, reason: "bag_full", ...fit };
    v.cooldowns.forage = 20;
    addXp(v, "foraging", 4, this.tickCount);
    addItem(v, picked, 1);
    this.emit(v, { type: "foraged", item: picked });
    return { ok: true, item: picked, count: 1 };
  }

  // 做菜：在灶台旁，消耗食材
  actCook(v, a) {
    if (v.cooldowns.cook > 0) return { ok: false, reason: "cooldown" };
    const recipe = COOK_RECIPES.find((r) => r.id === String(a.recipe || ""));
    if (!recipe) return { ok: false, reason: "unknown_recipe", accepts: COOK_RECIPES.map((r) => r.id) };
    const stove = this.map.findNearest("stove", v.x, v.y);
    if (!stove || Math.hypot(stove.x + 0.5 - v.x, stove.y + 0.5 - v.y) > 1.9) {
      return { ok: false, reason: "not_near_stove" };
    }
    if (!hasItems(v, recipe.needs)) return { ok: false, reason: "missing_ingredients", needs: recipe.needs };
    const cookDelta = {};
    for (const [id, n] of Object.entries(recipe.needs)) cookDelta[id] = (cookDelta[id] || 0) - n;
    for (const [id, n] of Object.entries(recipe.out)) cookDelta[id] = (cookDelta[id] || 0) + n;
    const cookFit = bagFits(v.inventory, cookDelta);
    if (!cookFit.ok) return { ok: false, reason: "bag_full", ...cookFit };

    takeItems(v, recipe.needs);
    for (const [id, n] of Object.entries(recipe.out)) addItem(v, id, n);
    v.cooldowns.cook = 50;
    addXp(v, "cooking", 10, this.tickCount);
    if (!v.knownRecipes.includes(recipe.id)) v.knownRecipes.push(recipe.id);
    this.emit(v, { type: "cooked", recipe: recipe.id, name: recipe.name });
    return { ok: true, made: recipe.out };
  }

  // 白送
  actGive(v, a) {
    const t = this.entities.get(a.targetId);
    if (!t) return { ok: false, reason: "bad_target" };
    if (t.state === "dead") return { ok: false, reason: "dead" };
    if (Math.hypot(t.x - v.x, t.y - v.y) > 2.5) return { ok: false, reason: "too_far" };
    const id = String(a.item || "");
    const n = Math.round(clampNum(a.count, 1, 99, 1));
    if (!ITEMS[id] || (v.inventory[id] || 0) < n) return { ok: false, reason: "not_enough" };
    const fit = bagFits(t.inventory, { [id]: n });
    if (!fit.ok) return { ok: false, reason: "target_bag_full", hint: `${t.name} 的背包放不下`, ...fit };
    v.inventory[id] -= n;
    addItem(t, id, n);
    this.emit(v, { type: "gave", toId: t.id, item: id, count: n });
    this.emit(t, { type: "received", fromId: v.id, item: id, count: n });
    return { ok: true, gave: { item: id, count: n }, to: t.name };
  }

  /**
   * 报价：双向的。
   *   side="sell"：我卖 N 个，要价 P（对方付钱）
   *   side="buy" ：我想买 N 个，出价 P（对方交货）
   * 价格没有上限；allowCredit=true 时买方钱不够也成交，差额记成欠款（负数）。
   */
  actQuote(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor", hint: "成年后才有自己的财产" };
    const t = this.entities.get(a.targetId);
    if (!t) return { ok: false, reason: "bad_target" };
    if (t.state === "dead") return { ok: false, reason: "dead" };
    if (Math.hypot(t.x - v.x, t.y - v.y) > 3) return { ok: false, reason: "too_far" };
    if (!this.canSee(v, t)) return { ok: false, reason: "not_visible" };

    const side = a.side === "buy" ? "buy" : "sell";
    const item = String(a.item || "");
    const count = Math.round(clampNum(a.count, 1, 999, 1));
    const price = clampNum(a.price, 0, 1e9, 0);
    if (!ITEMS[item]) return { ok: false, reason: "bad_item", accepts: Object.keys(ITEMS) };
    // 以物易物：want = { item, count }
    let want = null;
    if (a.want && ITEMS[a.want.item]) {
      want = { item: String(a.want.item), count: Math.round(clampNum(a.want.count, 1, 999, 1)) };
    }
    if (!want && price <= 0) return { ok: false, reason: "need_price_or_want" };

    if (side === "sell" && (v.inventory[item] || 0) < count) {
      return { ok: false, reason: "not_enough", have: v.inventory[item] || 0 };
    }

    const quote = {
      id: "q" + (this.nextQuoteId = (this.nextQuoteId || 1) + 1),
      fromId: v.id, toId: t.id, side, item, count, price, want,
      allowCredit: !!a.allowCredit && side === "sell",
      expiresAt: this.tickCount + 600,
      state: "open"
    };
    this.quotes.set(quote.id, quote);
    this.emit(v, { type: "quote_sent", quoteId: quote.id, toId: t.id, side, item, count, price });
    this.emit(t, {
      type: "quote_received", quoteId: quote.id, fromId: v.id, fromName: v.name,
      side, item, count, price, allowCredit: quote.allowCredit, expiresInTicks: 600
    });
    return { ok: true, quoteId: quote.id };
  }

  actAccept(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor", hint: "成年后才有自己的财产" };
    const q = this.quotes.get(a.quoteId);
    if (!q || q.state !== "open") return { ok: false, reason: "no_quote" };
    if (q.toId !== v.id) return { ok: false, reason: "not_yours" };
    const other = this.entities.get(q.fromId);
    if (!other) return { ok: false, reason: "other_gone" };

    let buyer, seller;
    if (q.side === "sell") { seller = other; buyer = v; }
    else { seller = v; buyer = other; }

    if ((seller.inventory[q.item] || 0) < q.count) return { ok: false, reason: "seller_out" };

    if (q.want) {
      if ((buyer.inventory[q.want.item] || 0) < q.want.count) {
        return { ok: false, reason: "buyer_missing_want", want: q.want };
      }
      // 以物易物两边同时增减：先把两边的最终背包都算一遍，装不下就不成交。
      const bFit = bagFits(buyer.inventory, { [q.item]: q.count, [q.want.item]: -q.want.count });
      if (!bFit.ok) return { ok: false, reason: "buyer_bag_full", ...bFit };
      const sFit = bagFits(seller.inventory, { [q.item]: -q.count, [q.want.item]: q.want.count });
      if (!sFit.ok) return { ok: false, reason: "seller_bag_full", ...sFit };
      buyer.inventory[q.want.item] -= q.want.count;
      seller.inventory[q.item] -= q.count;
      addItem(buyer, q.item, q.count);
      addItem(seller, q.want.item, q.want.count);
      q.state = "accepted";
      this.quotes.delete(q.id);
      this.emit(buyer, { type: "bartered", fromId: seller.id, got: { item: q.item, count: q.count }, gave: q.want });
      this.emit(seller, { type: "bartered", toId: buyer.id, got: q.want, gave: { item: q.item, count: q.count } });
      return { ok: true, barter: { got: q.item, count: q.count, gave: q.want } };
    }

    if ((buyer.coins || 0) < q.price && !q.allowCredit) return { ok: false, reason: "buyer_cant_afford" };
    const buyFit = bagFits(buyer.inventory, { [q.item]: q.count });
    if (!buyFit.ok) return { ok: false, reason: "buyer_bag_full", ...buyFit };

    const paid = Math.min(buyer.coins, q.price);
    const shortfall = q.price - paid;
    if (shortfall > 0) this.addCommitment(buyer.id, seller.id, {
      kind: "debt", coins: shortfall, note: `赊账：${q.count} 个 ${q.item}`
    });
    seller.inventory[q.item] -= q.count;
    addItem(buyer, q.item, q.count);
    buyer.coins -= paid;
    seller.coins += paid;
    q.state = "accepted";
    this.quotes.delete(q.id);

    this.emit(buyer, {
      type: "bought", fromId: seller.id, item: q.item, count: q.count,
      price: q.price, paid, shortfall, coins: buyer.coins
    });
    this.emit(seller, {
      type: "sold", toId: buyer.id, buyerName: buyer.name, item: q.item, count: q.count,
      price: q.price, paid, shortfall, coins: seller.coins
    });
    return { ok: true, bought: { item: q.item, count: q.count, price: q.price }, coins: buyer.coins };
  }

  actDecline(v, a) {
    const q = this.quotes.get(a.quoteId);
    if (!q || q.state !== "open") return { ok: false, reason: "no_quote" };
    if (q.toId !== v.id) return { ok: false, reason: "not_yours" };
    q.state = "declined";
    this.quotes.delete(q.id);
    this.emit(v, { type: "quote_declined", quoteId: q.id, fromId: q.fromId });
    const other = this.entities.get(q.fromId);
    if (other) this.emit(other, { type: "quote_rejected", quoteId: q.id });
    return { ok: true };
  }

  // ---------- 承诺登记簿：不强制执行，只保证"看得见" ----------

  addCommitment(debtorId, creditorId, { kind, coins = 0, note = "", promiseText = "" }) {
    // 每人名下最多 20 条未了结：登记簿是注意力工具，不是账本数据库
    const mine = [...this.commitments.values()]
      .filter((c) => !c.settledAt && (c.fromId === debtorId || c.toId === debtorId));
    if (mine.length >= 20) return null;
    const c = {
      id: "c" + (this.commitmentSeq = (this.commitmentSeq || 0) + 1),
      fromId: debtorId, toId: creditorId,
      kind: kind === "promise" ? "promise" : "debt",
      coins: Math.round(clampNum(coins, 0, 1e9, 0)),
      note: String(note || promiseText || "").slice(0, 80),
      createdAt: this.tickCount,
      dueAt: null, settledAt: null, lastRemindTick: 0
    };
    this.commitments.set(c.id, c);
    const from = this.entities.get(debtorId), to = this.entities.get(creditorId);
    this.emit(from, { type: "commitment_created", commitmentId: c.id, kind: c.kind, coins: c.coins, note: c.note, toName: to ? to.name : "?" });
    this.emit(to, { type: "commitment_received", commitmentId: c.id, kind: c.kind, coins: c.coins, note: c.note, fromName: from ? from.name : "?" });
    return c;
  }

  /** 投影：v 眼前的全部未了结约定（每次观察都带上——这就是"注意力"） */
  commitmentsFor(v) {
    const out = [];
    for (const c of this.commitments.values()) {
      if (c.settledAt) continue;
      if (c.fromId !== v.id && c.toId !== v.id) continue;
      const other = this.entities.get(c.fromId === v.id ? c.toId : c.fromId);
      out.push({
        id: c.id, kind: c.kind, role: c.fromId === v.id ? "i_owe" : "owed_to_me",
        otherName: other ? other.name : null, otherId: c.fromId === v.id ? c.toId : c.fromId,
        coins: c.coins, note: c.note,
        ageTicks: this.tickCount - c.createdAt
      });
    }
    return out;
  }

  actPromise(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor", hint: "成年才能许诺" };
    const t = this.entities.get(a.targetId);
    if (!t || t.id === v.id || t.state === "dead") return { ok: false, reason: "bad_target" };
    if (dist(v, t) > 3) return { ok: false, reason: "too_far", hint: "约定要当面" };
    const text = String(a.text || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80);
    if (!text) return { ok: false, reason: "bad_text" };
    const coins = Math.round(clampNum(a.coins, 0, 1e9, 0));
    const c = this.addCommitment(v.id, t.id, { kind: "promise", coins, note: text });
    if (!c) return { ok: false, reason: "too_many_commitments" };
    return { ok: true, commitmentId: c.id };
  }

  /** 自愿了结：不强制、不仲裁——欠款方主动还钱，或承诺方宣告完成 */
  actSettle(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor" };
    const c = this.commitments.get(a.commitmentId);
    if (!c || c.settledAt) return { ok: false, reason: "no_commitment" };
    if (c.fromId !== v.id) return { ok: false, reason: "not_yours", hint: "只有欠的一方能了结" };
    const to = this.entities.get(c.toId);
    if (!to || to.state === "dead") {
      // 债主没了：约定随人而去
      c.settledAt = this.tickCount;
      return { ok: true, note: "对方已不在，约定了结" };
    }
    let paid = 0;
    if (c.kind === "debt") {
      paid = Math.min(v.coins || 0, Math.round(clampNum(a.coins ?? c.coins, 0, c.coins, c.coins)));
      if (paid <= 0) return { ok: false, reason: "no_coins" };
      v.coins -= paid; to.coins += paid;
      if (paid < c.coins) {
        // 部分偿还：登记簿留着余款
        c.coins -= paid;
        this.emit(v, { type: "debt_part_paid", commitmentId: c.id, paid, rest: c.coins, toName: to.name });
        this.emit(to, { type: "debt_part_received", commitmentId: c.id, paid, rest: c.coins, fromName: v.name });
        return { ok: true, paid, rest: c.coins };
      }
    }
    c.settledAt = this.tickCount;
    this.emit(v, { type: "commitment_settled", commitmentId: c.id, kind: c.kind, paid, toName: to.name });
    this.emit(to, { type: "commitment_fulfilled", commitmentId: c.id, kind: c.kind, paid, fromName: v.name });
    return { ok: true, paid };
  }

  /** 定期把未了结的约定重新推到双方眼前（注意力保鲜，防"说了就忘"） */
  tickCommitments() {
    for (const c of this.commitments.values()) {
      if (c.settledAt) continue;
      // 每半天（6000 tick）提醒一次；新登记的当轮不重复提醒
      if (this.tickCount - c.createdAt < 6000) continue;
      if (this.tickCount - (c.lastRemindTick || 0) < 6000) continue;
      c.lastRemindTick = this.tickCount;
      const from = this.entities.get(c.fromId), to = this.entities.get(c.toId);
      const label = c.kind === "debt" ? `欠 ${c.coins} 金（${c.note}）` : `约定：${c.note}`;
      if (from && from.state !== "dead") {
        const t = this.entities.get(c.toId);
        this.emit(from, { type: "commitment_reminder", commitmentId: c.id, kind: c.kind, coins: c.coins, note: c.note, toName: t ? t.name : null, hint: `你还没了结：${label}` });
      }
      if (to && to.state !== "dead") {
        const f = this.entities.get(c.fromId);
        this.emit(to, { type: "commitment_reminder", commitmentId: c.id, kind: c.kind, coins: c.coins, note: c.note, fromName: f ? f.name : null, hint: `${f ? f.name : "有人"} 还欠着你：${label}` });
      }
    }
  }

  // 盖房子：自己出料，地点自己选（成年后才有"自由迁徙"）
  actBuildHouse(v, a) {
    if (isMinor(v)) return { ok: false, reason: "minor", hint: "成年后才能成家立业" };
    const cost = { plank: 8, wood: 4 };
    if (!hasItems(v, cost)) return { ok: false, reason: "missing_materials", needs: cost, have: v.inventory };
    if (v.buildCooldown > this.tickCount) return { ok: false, reason: "cooldown" };

    const x0 = Math.floor(Number(a.x)), y0 = Math.floor(Number(a.y));
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) return { ok: false, reason: "bad_target" };
    if (Math.hypot(x0 + 2.5 - v.x, y0 + 2 - v.y) > 6) return { ok: false, reason: "too_far" };

    // 5 宽 4 高的空地
    for (let y = y0; y <= y0 + 3; y++) {
      for (let x = x0; x <= x0 + 4; x++) {
        const t = this.map.tile(x, y);
        if (!t || !["grass", "path", "flower"].includes(t.kind)) {
          return { ok: false, reason: "not_clear", at: { x, y } };
        }
      }
    }

    takeItems(v, cost);
    for (let x = x0; x <= x0 + 4; x++) { this.map.setKind(x, y0, "wall"); this.map.setKind(x, y0 + 3, "wall"); }
    for (let y = y0 + 1; y <= y0 + 2; y++) { this.map.setKind(x0, y, "wall"); this.map.setKind(x0 + 4, y, "wall"); }
    for (let y = y0 + 1; y <= y0 + 2; y++) for (let x = x0 + 1; x <= x0 + 3; x++) this.map.setKind(x, y, "floor");
    this.map.setKind(x0 + 2, y0 + 3, "door");
    this.map.setKind(x0 + 1, y0 + 1, "bed");

    const home = { x: x0 + 2, y: y0 + 4 };
    this.map.homes.push(home);
    v.home = home;
    // 盖房的人可能正站在地基上：房子落成后把他挪到门口，
    // 否则墙一围，他就被封在自己家里了（真发生过）。
    const sx = Math.floor(v.x), sy = Math.floor(v.y);
    if (sx >= x0 && sx <= x0 + 4 && sy >= y0 && sy <= y0 + 3) {
      v.x = home.x + 0.5; v.y = home.y + 0.5;
      v.tileX = home.x; v.tileY = home.y;
      v.path = [];
      const at = this.map.tile(home.x, home.y);
      if (!at || !at.walkable) this.unstuck(v);
    }
    v.buildCooldown = this.tickCount + 600;
    this.emit(v, { type: "house_built", at: { x: x0, y: y0 }, cost });
    this.checkSettlement(x0, y0, v);
    return { ok: true, at: { x: x0, y: y0 }, home, cost };
  }

  /**
   * 聚落检测：一个 16×16 区域内第 3 张床落地 = 新聚落诞生。
   * 引擎只登记事实（谁、何时、何处），不起名不管理——聚落长成什么样是居民的事。
   * 名字用"首位建房者 + 落"，首个登记时定死，回放确定。
   */
  checkSettlement(x, y, builder) {
    const rx = x >> 4, ry = y >> 4;
    const key = rx + "," + ry;
    if (this.settlements.has(key)) return null;
    let beds = 0;
    for (let ty = ry * 16; ty < ry * 16 + 16 && ty < this.map.height; ty++) {
      for (let tx = rx * 16; tx < rx * 16 + 16 && tx < this.map.width; tx++) {
        const t = this.map.tile(tx, ty);
        if (t && t.kind === "bed") beds++;
      }
    }
    if (beds < 3) return null;
    const s = {
      key, x: rx * 16 + 8, y: ry * 16 + 8,
      name: (builder ? builder.name : "无名") + "落",
      founderId: builder ? builder.id : null,
      houses: beds, foundedTick: this.tickCount
    };
    this.settlements.set(key, s);
    for (const o of this.entities.values()) {
      if (o.state !== "dead") this.emit(o, { type: "settlement_founded", name: s.name, at: { x: s.x, y: s.y }, houses: s.houses });
    }
    return s;
  }

  // 造东西：只能放在身边两格内的空地
  actBuild(v, a) {
    const x = Math.floor(Number(a.x)), y = Math.floor(Number(a.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: "bad_target" };
    if (Math.hypot(x + 0.5 - v.x, y + 0.5 - v.y) > 2.2) return { ok: false, reason: "too_far" };
    // chest 是"有内容物的储物箱"，crate 是它的地图外观（同一个瓦片 kind）。
    const BUILDABLE = ["flower", "bench", "fence", "lamp", "path", "bed", "crate", "chest", "stove"];
    const kind = String(a.kind || "");
    if (!BUILDABLE.includes(kind)) return { ok: false, reason: "bad_kind", accepts: BUILDABLE };
    const placed = kind === "chest" ? "crate" : kind;
    const t = this.map.tile(x, y);
    if (!t) return { ok: false, reason: "no_tile" };
    if (!["grass", "path", "flower", "floor"].includes(t.kind)) return { ok: false, reason: "not_buildable_here" };
    const COST = {
      stove: { wood: 4, plank: 1 },
      bed: { wood: 6, plank: 3 },
      crate: { plank: 2 },
      chest: { plank: 2, wood: 1 },
      bench: { plank: 2 },
      fence: { plank: 1 },
      lamp: { plank: 1, wood: 2 }
    };
    if (v.buildCooldown > this.tickCount) return { ok: false, reason: "cooldown" };
    const cost = COST[kind] || {};
    if (!hasItems(v, cost)) return { ok: false, reason: "missing_materials", needs: cost, have: v.inventory };
    takeItems(v, cost);

    this.map.setKind(x, y, placed);
    this.patches.set(x + "," + y, placed);
    // 箱子落成即登记成可开关实体；没登记就只是个摆设，存不进东西。
    if (placed === "crate") {
      const id = propId("chest", x, y);
      if (!this.props.has(id)) {
        this.props.set(id, makeProp("chest", x, y, {
          label: String(a.label || "储物箱").slice(0, 24),
          createdTick: this.tickCount
        }));
      }
    }
    v.buildCooldown = this.tickCount + 30;
    addXp(v, "farming", 3, this.tickCount);
    this.emit(v, { type: "built", x, y, kind: placed });
    return { ok: true, built: { x, y, kind: placed }, propId: placed === "crate" ? propId("chest", x, y) : null };
  }

  // 拆东西：只能拆别人造过的东西
  actRemove(v, a) {
    const x = Math.floor(Number(a.x)), y = Math.floor(Number(a.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: "bad_target" };
    if (Math.hypot(x + 0.5 - v.x, y + 0.5 - v.y) > 2.2) return { ok: false, reason: "too_far" };
    const key = x + "," + y;
    if (!this.patches.has(key)) return { ok: false, reason: "not_player_built" };
    const prev = this.patches.get(key);
    // 箱子里还有东西就不让拆：拆了东西去哪？引擎不替任何人做这个决定。
    const pid = propId("chest", x, y);
    const chestProp = this.props.get(pid);
    if (chestProp && Object.values(chestProp.items || {}).some((n) => n > 0)) {
      return { ok: false, reason: "chest_not_empty", hint: "先把箱子里的东西取出来" };
    }
    this.patches.delete(key);
    this.props.delete(pid);
    this.map.setKind(x, y, "grass");
    this.emit(v, { type: "removed", x, y, kind: prev });
    return { ok: true, removed: prev };
  }

  // 把自己知道的区域告诉身边的人（只能面对面）
  actShareMap(v, a) {
    const t = this.entities.get(a.targetId);
    if (!t || t === v) return { ok: false, reason: "bad_target" };
    if (Math.hypot(t.x - v.x, t.y - v.y) > 3) return { ok: false, reason: "too_far" };
    if (!this.canSee(v, t)) return { ok: false, reason: "not_visible" };
    if (v.shareCooldown > this.tickCount) return { ok: false, reason: "cooldown" };
    v.shareCooldown = this.tickCount + 100;   // 10 秒

    const list = [...v.explored].map((k) => {
      const [x, y] = k.split(",").map(Number);
      return { k, d: Math.hypot(x - t.x, y - t.y) };
    }).sort((p, q) => p.d - q.d).slice(0, 40);

    let added = 0;
    for (const item of list) if (!t.explored.has(item.k)) { t.explored.add(item.k); added++; }

    this.emit(v, { type: "shared_map", toId: t.id, tiles: added });
    this.emit(t, { type: "heard_about_area", fromId: v.id, tiles: added });
    return { ok: true, shared: added, with: t.name };
  }

  actMoveTo(v, a) {
    const x = Number(a.x), y = Number(a.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: "bad_target" };

    let target = { x, y };
    let p = this.map.findPath(v.x, v.y, x, y);
    let snapped = false;

    // 目标落在水里/墙上就就近找一格能站的，别直接失败
    if (!p) {
      const bx = Math.floor(x), by = Math.floor(y);
      outer: for (let r = 1; r <= 4; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const t = this.map.tile(bx + dx, by + dy);
            if (!t || !t.walkable) continue;
            const q = this.map.findPath(v.x, v.y, bx + dx, by + dy);
            if (q) { p = q; target = { x: bx + dx, y: by + dy }; snapped = true; break outer; }
          }
        }
      }
    }
    if (!p) return { ok: false, reason: "no_path" };
    v.path = p;
    return { ok: true, steps: p.length, whenSnapped: snapped ? target : undefined };
  }

  actSay(v, a) {
    const text = String(a.text || "").trim().slice(0, CFG.MAX_TEXT);
    if (!text) return { ok: false, reason: "empty" };
    if (this.tickCount - v.lastSpokeTick < 20) return { ok: false, reason: "too_fast" };

    v.lastSpokeTick = this.tickCount;
    v.bubble = { text, until: this.tickCount + CFG.BUBBLE_TICKS, private: !!a.private };
    v.dir = a.to ? Math.atan2((this.entities.get(a.to)?.y ?? v.y) - v.y, (this.entities.get(a.to)?.x ?? v.x) - v.x) : v.dir;

    const listener = a.to ? this.entities.get(a.to) : null;
    this.setConversation(v, listener && listener.state !== "dead" ? listener : null);
    addXp(v, "social", 2, this.tickCount);

    let heard = 0;
    for (const o of this.entities.values()) {
      if (o === v || o.state === "downed" || o.state === "dead") continue;
      if (!this.canHear(o, v)) continue;
      const sees = this.canSee(o, v);
      const addressee = listener && o.id === listener.id;
      if (a.private && !addressee) {
        this.emit(o, { type: "heard_muffled", from: brief(v), distance: round1(dist(o, v)) });
      } else if (!sees && !addressee) {
        // 只给轮廓，不带 bubble：否则"听不清"的事件里仍然夹着正文
        this.emit(o, { type: "heard_muffled", from: brief(v), distance: round1(dist(o, v)) });
      } else {
        this.emit(o, { type: "utterance", from: pubFor(v, o), toId: listener ? listener.id : null, text, private: !!a.private });
        heard++;
      }
    }
    this.emit(v, { type: "said", text, heard, toId: listener ? listener.id : null, private: !!a.private });
    return { ok: true, heard };
  }

  setConversation(v, other) {
    const until = this.tickCount + CFG.CONVERSATION_TICKS;
    v.conversation = other ? { partnerId: other.id, until } : v.conversation;
    if (other) other.conversation = { partnerId: v.id, until };
  }

  /**
   * 物件控制：门与储物箱都走 props.mjs 的三段管线。
   * 单独留一个 World 方法，是为了让外部 AI（applyAction）、控制台（HTTP）和
   * 未来的 NPC 决策层调用完全同一套判断，不出现两把尺子。
   */
  propControl(cmd) {
    return runPropControl(this, cmd || {});
  }

  /** 观察者 / Agent 的只读视图：绝不把密码摘要或钥匙编号带出去。 */
  propsView() {
    return publicProps(this);
  }

  actInteract(v, a) {
    const x = Number(a.x), y = Number(a.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: "bad_target" };
    if (Math.hypot(x + 0.5 - v.x, y + 0.5 - v.y) > 1.8) return { ok: false, reason: "too_far" };
    const t = this.map.tile(x, y);
    if (!t) return { ok: false, reason: "no_tile" };

    if (t.kind === "door" || t.kind === "crate") {
      const id = propId(t.kind === "door" ? "door" : "chest", Math.floor(x), Math.floor(y));
      const p = this.props.get(id);
      if (!p) return { ok: false, reason: "no_prop" };
      // 兼容旧行为：interact 是"开关切换"；锁着时带凭证可一步解锁并打开。
      const op = p.open ? "close" : "open";
      const r = this.propControl({ ...a, op, id, actorId: v.id });
      if (!r.ok) return r;
      this.emit(v, { type: op === "open" ? "door_opened" : "door_closed", x, y, propId: id });
      return { ok: true, door: op === "open" ? "opened" : "closed", propId: id, trace: r.trace };
    }
    if (t.kind === "stove") {
      const recipe = RECIPES[this.tickCount % RECIPES.length];
      const r = tryLearnRecipe(v, recipe);
      addXp(v, "cooking", r.learned ? 12 : 5, this.tickCount);
      this.emit(v, {
        type: r.learned ? "learned_recipe" : "practiced_recipe",
        recipe: recipe.id, name: recipe.name
      });
      return { ok: true, learned: r.learned, recipe: recipe.id };
    }
    return { ok: false, reason: "not_interactable" };
  }

  actEat(v) {
    if (v.cooldowns.eat > 0) return { ok: false, reason: "cooldown" };
    var stove = this.map.findNearest("stove", v.x, v.y);
    if (!stove || Math.hypot(stove.x + 0.5 - v.x, stove.y + 0.5 - v.y) > 1.9) {
      return { ok: false, reason: "not_near_stove" };
    }
    // 吃饭要消耗食物：背包里有面包/炖菜/鱼才行
    const FOODS = ["bread", "stew", "fish"];
    const food = FOODS.find((k) => (v.inventory[k] || 0) > 0);
    if (!food) return { ok: false, reason: "no_food", accepts: FOODS, hint: "背包里没有吃的" };
    v.inventory[food] -= 1;
    v.needs.hunger = Math.min(100, v.needs.hunger + 40);
    v.needs.energy = Math.min(100, v.needs.energy + 6);
    v.cooldowns.eat = 30;   // 3 秒
    this.emit(v, { type: "ate", food, hunger: Math.round(v.needs.hunger) });
    return { ok: true, food, hunger: Math.round(v.needs.hunger) };
  }

  actAttack(v, a) {
    const target = this.entities.get(a.targetId);
    if (!target || target.id === v.id) return { ok: false, reason: "bad_target" };
    if (target.state === "dead") return { ok: false, reason: "dead" };
    if (v.cooldowns.attack > 0) return { ok: false, reason: "cooldown" };
    const d = dist(v, target);
    if (d > 1.6) return { ok: false, reason: "too_far" };
    if (!this.canSee(v, target)) return { ok: false, reason: "not_visible" };

    const intensity = clampNum(a.intensity, 0, 1, 0.5);
    const base = 12;
    const dmg = clampNum(Math.round(base * (0.4 + 1.2 * intensity)), 1, 99, 1);
    target.hp = Math.max(0, target.hp - dmg);
    v.cooldowns.attack = 0.8;
    addXp(v, "combat", 4, this.tickCount);

    this.emit(v, { type: "attack_landed", targetId: target.id, damage: dmg, targetHp: target.hp });
    this.emit(target, { type: "was_attacked", attackerId: v.id, damage: dmg, hp: target.hp });
    for (const o of this.entities.values()) {
      if (o !== v && o !== target && this.canSee(o, v)) this.emit(o, { type: "saw_attack", attackerId: v.id, targetId: target.id });
    }
    if (target.hp <= 0) this.down(target, "attack");
    return { ok: true, damage: dmg };
  }

  // ---------- 主循环 ----------
  /**
   * 一个游戏小时结算一次遗忘。
   * 注意它只依赖 tick 和技能自带的 lastUse，不掷骰子——否则同一存档两次运行
   * 会在不同的 tick 掉级，可用随机数流保住的那点复现性就白费了。
   */
  tickForgetting() {
    for (const v of this.entities.values()) {
      if (v.state === "dead") continue;
      const dropped = decaySkills(v, this.tickCount, {
        graceTicks: CFG.SKILL_GRACE_TICKS,
        ratePerHour: CFG.SKILL_DECAY_PER_HOUR
      });
      for (const d of dropped) this.emit(v, { type: "forgot", skill: d.skill, from: d.from, to: d.to });
    }
  }

  step(dt = CFG.DT) {
    this.tickCount++;
    if (this.advanceClock()) this.tickLifecycle();   // 一天一跳：年龄在这一天结算
    if (this.tickCount % CFG.SKILL_DECAY_EVERY === 0) this.tickForgetting();
    if (this.tickCount % 3000 === 0) this.tickCommitments(); // 每 1/4 游戏日把约定推回眼前
    for (const v of this.entities.values()) this.stepEntity(v, dt);
    if (this.tickCount % 2 === 0) this.updatePerception();
    if (this.tickCount % 10 === 0) this.updateExplored();
    if (this.tickCount % 50 === 0) this.expireQuotes();
    if (this.tickCount % 10 === 0) this.bumpRecognition();
    if (this.tickCount % 10 === 0) this.tickProtocols();
    for (const v of this.entities.values()) {
      if (v.bubble && this.tickCount > v.bubble.until) v.bubble = null;
    }
  }

  // ---------- 对外数据 ----------
  snapshot(observer = null) {
    return {
      tick: this.tickCount,
      clock: { ...this.clock, hour: this.hour },
      entities: [...this.entities.values()].map((v) => {
        const p = pubFor(v, observer);
        p.talkTo = v.conversation && v.conversation.until > this.tickCount ? v.conversation.partnerId : null;
        return p;
      }),
      doors: [...this.map.doors.entries()].map(([id, d]) => ({ id, x: d.x, y: d.y, open: d.open })),
      // 门 / 储物箱的开合、锁状态与箱内容物（密码摘要与钥匙编号永不外露）
      props: publicProps(this),
      patches: [...this.patches.entries()].map(([k, kind]) => {
        const [x, y] = k.split(",").map(Number);
        return [x, y, kind];
      })
      // log 不进快照（2026-11-05 流量优化）：两个观测器都只消费 event 单播消息，
      // 之前每 100ms 重发 40 条历史事件是纯死重；要看历史走 GET /api/log?since=
    };
  }
}

// ---------- 工具 ----------
function brief(v) {
  return {
    id: v.id, name: v.name,
    uid: v.uid ? String(v.uid).slice(0, 1) + "······" : null,
    x: round1(v.x), y: round1(v.y), dir: v.dir, state: v.state
  };
}

export function pub(v) {
  return {
    id: v.id, name: v.name, uid: v.uid, role: v.role, color: v.color,
    x: round1(v.x), y: round1(v.y), dir: v.dir,
    hp: v.hp, maxHp: v.maxHp, state: v.state,
    stage: stageOf(v.ageDays), ageDays: Number.isFinite(v.ageDays) ? v.ageDays : 20,
    aging: v.aging || "auto",
    bornDay: Number.isFinite(v.bornDay) ? v.bornDay : null,
    family: {
      parents: (v.family && v.family.parents) ? v.family.parents.slice() : [],
      spouseId: (v.family && v.family.spouseId) || null,
      children: (v.family && v.family.children) ? v.family.children.slice() : []
    },
    origin: v.origin || "native",
    needs: { energy: Math.round(v.needs.energy), hunger: Math.round(v.needs.hunger) },
    exploredCount: v.explored ? v.explored.size : 0,
    coins: v.coins || 0,
    appearance: v.appearance || { cloth: null, hat: null },
    inventory: inventoryList(v),
    // 背包额度：格子 / 负重 / 单类上限，观察者直接读这份视图，不用自己重算
    bag: bagUsage(v.inventory, BAG_RULES),
    external: !!v.external,
    // 他在想什么、心情如何：这两个字段由自主层写入，观察者能看见"这个人现在有打算"
    mood: v.mood || "平静",
    goal: v.goalLabel || null,
    bubble: v.bubble ? { text: v.bubble.text, private: !!v.bubble.private } : null
    // 注意：talent / recipeProgress / skills.xp 不外露
  };
}

/**
 * 带观察者的投影：私聊内容只对当事人可见。
 * 所有对外出口都必须用它，不要在响应里直接 pub()。
 */
export function pubFor(v, observer) {
  const p = pub(v);
  if (p.bubble && p.bubble.private && (!observer || observer.id !== v.id)) {
    p.bubble = { text: null, private: true, hidden: true };
  }
  return p;
}

/** 事件脱敏：private 说话的正文只留给当事人，其余人只看到他"低声说了句话"。 */
export function redactEvent(ev, observer) {
  if (!ev || !ev.private) return ev;
  const speaker = ev.from && ev.from.id;
  if (observer && (observer.id === speaker || observer.id === ev.toId)) return ev;
  if (ev.type === "utterance" || ev.type === "said") {
    return { ...ev, text: null, redacted: true };
  }
  return ev;
}

/** 把任意输入收成一个有限数；NaN / Infinity / 非数字都退回落差值 */
function num(x, dflt = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
}

/** 带上下限的 num：先纠 NaN，再夹住区间——不要再手写 Math.max(a, Math.min(b, ...)) */
function clampNum(x, lo, hi, dflt = lo) {
  return Math.min(hi, Math.max(lo, num(x, dflt)));
}

function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
function round1(n) { return Math.round(n * 10) / 10; }
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
const PALETTE = [
  "#e8a33d", "#6fa8dc", "#c96f6f", "#9b7fd4",
  "#6fbf9a", "#d9c04a", "#e08b5c", "#8a9bd1"
];
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}