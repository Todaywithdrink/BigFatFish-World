// 本地居民的执行层：感知 → 决策（autonomy.mjs）→ 动作。
//
// 它不再是"先判断饿、再判断累、再随机做点什么"的固定脚本：
// 决策权在 autonomy 里，这里只负责把选中的念头翻译成世界能懂的动作，
// 并把每个动作的成败写回经验。走不通就绕、材料不够就去找、被拒绝就换人。
//
// 和外部 AI 的关系：双方都只能用 world.applyAction 这一套原子动作，
// 没有全图、没有所有权、没有"脚本专用捷径"。

import { Rng, hashSeed } from "../src/rng.mjs";
import { ITEMS, personalValue } from "../src/economy.mjs";
import { isMinor } from "../src/lifecycle.mjs";
import {
  newBlackboard, restoreBlackboard, perceive, buildContext, drivesOf,
  refreshGoals, propose, feel, moodOf, rememberOutcome
} from "./autonomy.mjs";

const BRIDGE = process.env.BRIDGE_URL || "http://127.0.0.1:8787/v1/talk";

const FALLBACK = [
  "今天的水温刚好。",
  "你看见老鲤又去山上了吗？",
  "广场那边的花开得不错。",
  "我昨晚好像听见池塘那边有动静。",
  "这条街最近安静得有点怪。"
];

const CHILD_LINES = [
  "长大了我想去看看河那边。",
  "你今天去哪儿呀？",
  "我认识回来的路啦。",
  "那边的花开得好高！",
  "我有一块漂亮的小石头。"
];

const DIR_NAME = { "0,-1": "n", "0,1": "s", "-1,0": "w", "1,0": "e" };

// 这些失败是"时机不对"，不是"这条路走不通"，不该记成目标的错
const SOFT_FAIL = new Set(["cooldown", "too_fast", "not_near_stove", "too_far", "no_path"]);

export class Mind {
  constructor(world, v, opts = {}) {
    this.world = world;
    this.v = v;
    this.bb = opts.bb || newBlackboard(v);
    if (!this.bb.mem.stats.bornTick) this.bb.mem.stats.bornTick = world.tickCount;
    // 自己的随机流：不碰 world.rng，免得"每秒想一次"打乱内核的随机序列
    this.rng = new Rng(hashSeed(String(v.uid || v.id) + "#mind"));
    this.busy = false;
    this.stuck = 0;
    this.bumped = null;
    this.bumpedName = "";
    this.stagger = hashSeed(String(v.id)) % 7;
    this.nextThinkTick = 0;
    this.wanderCooldown = 2 + this.rng.int(5);
    this.lastGoalKind = null;
    this.emittedGoalTick = -9999;
    this.commit = null;      // 走到一半的承诺：别让两个差不多的念头一秒一换
    this.trail = [];         // 最近走过的格子，用来识别"原地打转"
    this.detourUntil = 0;
    this.detourDir = "n";
  }

  /** 想事情的间隔（tick）。加一点相位差，别让全村同一帧一起想。 */
  get thinkEvery() { return 10 + this.stagger; }

  async update() {
    const { world, v } = this;
    if (!v || v.state === "dead" || v.state === "downed") return;
    if (v.external) return;                    // 这条鱼有人类 AI 在开，脚本退场
    if (v.state === "walking" && v.path.length) return;   // 把这一段路走完再想

    perceive(world, v, this.bb);
    // 走过新地方就喂饱好奇心：不然"探索"会一直挂在最高优先级，把人钉在原地打转
    const seen = v.explored ? v.explored.size : 0;
    if (seen > (this.bb.mem.stats.exploredSeen || 0) + 8) {
      this.bb.mem.stats.exploredSeen = seen;
      this.bb.mem.stats.lastExplore = world.tickCount;
    }
    const ctx = buildContext(world, v, this.bb, this.rng);
    const drives = drivesOf(world, v, this.bb, ctx);

    this.readInbox(ctx);
    refreshGoals(world, v, this.bb, ctx, drives);
    this.dropCooledGoals();

    this.bb.mood = moodOf(v, this.bb, ctx);
    v.mood = this.bb.mood;
    v.goalLabel = this.bb.goals.length ? this.bb.goals[0].label : null;

    // 极端情况：先活下来，别的都放下
    if (v.state === "resting" && v.needs.energy < 99) return;
    if (v.needs.energy <= 2) { world.applyAction(v, { type: "rest" }); return; }
    if (v.needs.hunger <= 1 && ctx.food > 0 && ctx.stove) {
      if (Math.hypot(ctx.stove.x + 0.5 - v.x, ctx.stove.y + 0.5 - v.y) > 1.6) {
        this.stepToward(ctx.stove.x + 0.5, ctx.stove.y + 0.5);
      } else {
        world.applyAction(v, { type: "eat" });
      }
      return;
    }

    const cands = propose(world, v, this.bb, ctx, this.rng);
    this.lastCandidates = cands.slice(0, 5).map((c) => ({ label: c.intent.label, score: c.score, goal: c.goalKind }));
    let pick = cands[0];
    if (!pick) return this.idle(ctx);

    // 已经走在路上：只要原来的念头还有效、也没有明显更好的，就继续走。
    // 没有这一段，两个分数接近的念头会一秒一换，人在原地来回横跳。
    if (this.commit) {
      const alive = this.bb.goals.some((g) => g.kind === this.commit.goalKind);
      if (world.tickCount > this.commit.until || !alive) this.commit = null;
      else if (!this.emergency(ctx) && pick.score <= this.commit.score * 1.4) pick = this.commit;
      else this.commit = null;
    }

    // 目标切换会广播一条事件，观察者能看见"他决定去干什么"
    if (pick.goalKind !== this.lastGoalKind && world.tickCount - this.emittedGoalTick > 300) {
      this.emittedGoalTick = world.tickCount;
      this.lastGoalKind = pick.goalKind;
      world.emit(v, { type: "new_goal", goal: pick.goalKind, label: pick.goalLabel, why: pick.intent.label });
    }

    // 决定去远处就先走一段（急事除外），这是"承诺"而不是"每帧重算"
    if (pick.intent.kind === "goto") {
      const d = Math.hypot(pick.intent.x + 0.5 - v.x, pick.intent.y + 0.5 - v.y);
      if (d > 5 && !this.emergency(ctx)) this.commit = { ...pick, until: world.tickCount + 50 };
    }

    this.bb.thought = pick.intent.label;
    this.execute(pick, ctx);
  }

  // ---------- 执行 ----------

  execute(pick, ctx) {
    const it = pick.intent;
    const goal = this.bb.goals.find((g) => g.kind === pick.goalKind) || null;
    switch (it.kind) {
      case "goto": return this.doGoto(it, goal);
      case "talk": return this.doTalk(it, goal);
      case "act": return this.doAct(it, goal, ctx);
      case "build": return this.doBuild(it, goal);
      case "buildHouse": return this.doBuildHouse(it, goal);
      case "give": return this.doGive(it, goal);
      default: return;
    }
  }

  doGoto(it, goal) {
    const tx = it.x + 0.5, ty = it.y + 0.5;
    const d = Math.hypot(tx - this.v.x, ty - this.v.y);
    if (d <= (it.near == null ? 1.3 : it.near)) {
      if (this.commit && this.commit.intent === it) this.commit = null;
      return "arrived";
    }
    // 在屋里：先出门，再谈去哪
    if (this.tryExitRoom(tx, ty)) return "walking";
    const ok = this.stepToward(tx, ty);
    if (!ok) this.onBlocked(it);
    return ok ? "walking" : "blocked";
  }

  doTalk(it, goal) {
    const t = this.world.entities.get(it.targetId);
    if (!t || t.state === "dead") return this.fail(goal, "想说话的人不在了");
    this.maybeSpeak(it.targetId).catch(() => {});
  }

  doAct(it, goal, ctx) {
    const r = this.world.applyAction(this.v, it.action);
    if (!r || r.ok === false) return this.onActFail(r, it, goal, ctx);
    return this.onActOk(r, it, goal, ctx);
  }

  doBuild(it, goal) {
    const d = Math.hypot(it.x + 0.5 - this.v.x, it.y + 0.5 - this.v.y);
    if (d > 2.0) { this.stepToward(it.x + 0.5, it.y + 0.5); return "walking"; }
    const r = this.world.applyAction(this.v, { type: "build", x: it.x, y: it.y, kind: it.buildKind });
    if (!r || r.ok === false) return this.onActFail(r, it, goal);
    feel(this.v, this.bb, "built", 1);
    return "ok";
  }

  doGive(it, goal) {
    const r = this.world.applyAction(this.v, { type: "give", targetId: it.targetId, item: it.item, count: it.count || 1 });
    if (!r || r.ok === false) return this.onActFail(r, it, goal);
    feel(this.v, this.bb, "gave", 1);
    return "ok";
  }

  doBuildHouse(it, goal) {
    const cx = it.x + 2.5, cy = it.y + 2;
    const d = Math.hypot(cx - this.v.x, cy - this.v.y);
    if (d > 5.4) { this.stepToward(cx, cy); return "walking"; }
    const r = this.world.applyAction(this.v, { type: "buildHouse", x: it.x, y: it.y });
    if (!r || r.ok === false) return this.onActFail(r, it, goal);
    this.bb.mem.stats.myHouse = { x: it.x, y: it.y };
    this.bb.mem.stats.houses = (this.bb.mem.stats.houses || 0) + 1;
    feel(this.v, this.bb, "house", 1);
    this.done(goal, "房子盖好了");
    return "ok";
  }

  onActOk(r, it, goal, ctx) {
    const { v, bb } = this;
    const type = it.action && it.action.type;
    if (type === "fish") {
      rememberOutcome(bb, "fish", !!r.caught);
      if (r.caught) { bb.mem.stats.catches++; feel(v, bb, "caught", 1); }
      else feel(v, bb, "fish_miss", 1);
    } else if (type === "eat") {
      bb.mem.stats.meals++; feel(v, bb, "ate", 1); this.done(goal, "吃饱了");
    } else if (type === "chop") {
      bb.mem.stats.chops++; feel(v, bb, "chopped", 1);
    } else if (type === "cook") {
      rememberOutcome(bb, "cook", true);
      feel(v, bb, "ate", 0.6);
    } else if (type === "settle") {
      feel(v, bb, "debt_paid", 1); this.done(goal, "账了了");
    } else if (type === "craft") {
      if (r.success === false) rememberOutcome(bb, "craft", false);
    } else if (type === "quote") {
      feel(v, bb, "traded", 0.4);
    } else if (type === "readForum") {
      bb.mem.stats.lastForum = this.world.tickCount;
      this.done(goal, "看完告示了");
    }
    return "ok";
  }

  onActFail(r, it, goal, ctx) {
    const reason = (r && r.reason) || "failed";
    if (SOFT_FAIL.has(reason)) return reason;
    if (reason === "missing_materials" || reason === "not_clear" || reason === "not_buildable_here") {
      return this.fail(goal, reason === "missing_materials" ? "材料不够" : "那块地不能用");
    }
    if (reason === "no_food") {
      // 背包空了：把"吃"降级成"弄吃的"
      this.done(goal, "没吃的了");
      return reason;
    }
    return this.fail(goal, "做不成：" + reason);
  }

  /** 目标连续受挫就放弃，并冷静一阵子——免得一整天在原地撞同一堵墙 */
  fail(goal, why) {
    if (!goal) return "no_goal";
    goal.fails = (goal.fails || 0) + 1;
    if (goal.fails >= 3) {
      this.bb.goals = this.bb.goals.filter((g) => g !== goal);
      this.bb.mem.cool = this.bb.mem.cool || {};
      this.bb.mem.cool[goal.kind] = this.world.tickCount + 900;
      this.bb.mem.notes.push(String(why).slice(0, 30));
      if (this.bb.mem.notes.length > 6) this.bb.mem.notes.shift();
      feel(this.v, this.bb, "stuck", 1);
      this.lastGoalKind = null;
    }
    return why;
  }

  done(goal, why) {
    if (!goal) return;
    this.bb.goals = this.bb.goals.filter((g) => g !== goal);
    if (why) {
      this.bb.mem.notes.push(String(why).slice(0, 30));
      if (this.bb.mem.notes.length > 6) this.bb.mem.notes.shift();
    }
    this.lastGoalKind = null;
  }

  dropCooledGoals() {
    const cool = this.bb.mem.cool || {};
    const now = this.world.tickCount;
    this.bb.goals = this.bb.goals.filter((g) => !(cool[g.kind] > now));
  }

  /** 真正等不了的事：快饿死、快没力气、被打到重伤 */
  emergency(ctx) {
    return ctx.hunger <= 3 || this.v.needs.energy <= 5 || this.v.hp < 30;
  }

  idle(ctx) {
    // 什么念头都没有：在附近走走，顺便看看能不能踩出一条路
    if (--this.wanderCooldown > 0) return;
    this.wanderCooldown = 4 + this.rng.int(6);
    this.walkRandom();
  }

  // ---------- 消息：只做"当下的反应"，不改变长期目标 ----------

  readInbox(ctx) {
    const { v, world, bb } = this;
    const events = v.inbox.splice(0, v.inbox.length);
    for (const e of events) {
      switch (e.type) {
        case "quote_received": this.considerQuote(e, ctx); break;
        case "auction_notice":
        case "auction_invited": this.considerAuction(e, ctx); break;
        case "was_attacked": {
          feel(v, bb, "attacked", 1);
          const p = bb.mem.people[e.attackerId] || (bb.mem.people[e.attackerId] = { talks: 0, lastTalk: 0, attacks: 0, gave: 0, got: 0 });
          p.attacks++;
          break;
        }
        case "saw_attack": feel(v, bb, "attacked", 0.4); break;
        case "settlement_founded": {
          if (!bb.mem.seenSettlements.some((s) => s.name === e.name)) {
            bb.mem.seenSettlements.push({ name: e.name, x: e.at.x, y: e.at.y });
            if (bb.mem.seenSettlements.length > 8) bb.mem.seenSettlements.shift();
          }
          break;
        }
        case "gave": feel(v, bb, "gave", 0.5); break;
        case "received": feel(v, bb, "friend", 0.5); break;
        case "enter_view": {
          // 看见人走过来：外向的人会先开口；不是每次都说话，免得刷屏
          if (!this.busy && bb.traits.sociability > 6 && this.rng.chance(0.18)) {
            this.maybeSpeak(e.who.id).catch(() => {});
          }
          break;
        }
        case "heard_about_area": feel(v, bb, "friend", 0.3); break;
        default: break;
      }
    }
  }

  /** 报价来了：按"这东西对我值多少"判，不按官方价 */
  considerQuote(e, ctx) {
    const { v, bb, world } = this;
    const mine = personalValue(v, e.item) * e.count;
    const cautionBias = 1 + (bb.traits.caution - 5) * 0.02;       // 谨慎的人更会砍价
    const generous = 1 - (bb.traits.generosity - 5) * 0.02;       // 大方的人更愿意让对方赚
    let accept = false;
    if (e.want) {
      const give = personalValue(v, e.want.item) * e.want.count;
      const have = (v.inventory[e.want.item] || 0) >= e.want.count;
      if (e.side === "sell") accept = have && give * generous >= mine * 0.85 * cautionBias;
      else accept = (v.inventory[e.item] || 0) >= e.count && mine * e.count >= give * 0.85 * cautionBias;
    } else if (e.side === "sell") {
      accept = e.price <= mine * 1.15 * cautionBias && v.coins >= e.price;
    } else {
      const have = (v.inventory[e.item] || 0) >= e.count;
      accept = have && e.price >= mine * 0.9 * generous;
    }
    world.applyAction(v, { type: accept ? "accept" : "decline", quoteId: e.quoteId });
    if (accept) feel(v, bb, "traded", 1);
  }

  considerAuction(e, ctx) {
    const { v, bb, world } = this;
    const p = world.protocols.get(e.protocolId);
    if (!p || p.state !== "open" || p.hostId === v.id) return;
    const top = p.bids.length ? p.bids[p.bids.length - 1].price : p.minPrice - 1;
    const offer = Math.max(p.minPrice, top + 5);
    // 想要的程度 = 自己缺不缺 + 野心 - 谨慎
    const want = Math.min(1, (ITEMS[p.item] ? 6 / (1 + (v.inventory[p.item] || 0)) : 0.3) + bb.traits.ambition / 40);
    if (v.coins >= offer && this.rng.chance(0.35 + want * 0.4)) {
      world.applyAction(v, { type: "placeBid", protocolId: p.id, price: offer });
    }
  }

  // ---------- 走路：一格一格走，撞了就绕 ----------

  moveDir(dir, tiles) {
    const r = this.world.applyAction(this.v, { type: "move", dir, tiles });
    return !!(r && r.moved > 0);
  }

  stepToward(tx, ty, tilesOverride = 0) {
    const { v } = this;
    const dx = tx - v.x, dy = ty - v.y;
    const far = Math.hypot(dx, dy);
    if (far < 0.7) return true;

    // 绕路中：先按选定的方向硬走几步，避免在墙角来回磨
    if (this.detourUntil > this.world.tickCount) {
      if (this.moveDir(this.detourDir, 2)) { this.stuck = 0; return true; }
      this.detourUntil = 0;
    }

    const cand = [];
    const push = (ox, oy) => {
      if (!ox && !oy) return;
      if (cand.some(([x, y]) => x === ox && y === oy)) return;
      cand.push([ox, oy]);
    };
    if (Math.abs(dx) >= Math.abs(dy)) { push(Math.sign(dx), 0); push(0, Math.sign(dy)); }
    else { push(0, Math.sign(dy)); push(Math.sign(dx), 0); }
    push(0, -1); push(0, 1); push(-1, 0); push(1, 0);

    if (this.bumped) {
      const i = cand.findIndex(([x, y]) => x === this.bumped[0] && y === this.bumped[1]);
      if (i > 0) cand.push(cand.splice(i, 1)[0]);
    }

    const tiles = tilesOverride || (far > 3 ? 3 : 1);
    for (const [ox, oy] of cand) {
      if (this.moveDir(DIR_NAME[ox + "," + oy], tiles)) {
        this.bumped = null;
        this.stuck = 0;
        this.noteStep();
        this.maybePave();
        return true;
      }
      this.bumped = [ox, oy];
    }

    this.stuck = (this.stuck || 0) + 1;
    if (this.stuck >= 3) this.startDetour();
    return false;
  }

  /** 记下最近走过的格子；一直在三格以内打转 = 掉进局部死胡同 */
  noteStep() {
    const { v } = this;
    this.trail.push(Math.floor(v.x) + "," + Math.floor(v.y));
    if (this.trail.length > 14) this.trail.shift();
    if (this.trail.length === 14 && new Set(this.trail).size <= 3) {
      this.trail.length = 0;
      this.startDetour();
    }
  }

  startDetour() {
    const dirs = ["n", "s", "e", "w"].filter((d) => d !== (this.bumpedName || ""));
    this.detourDir = this.rng.pick(dirs) || "n";
    this.detourUntil = this.world.tickCount + 12;
    this.stuck = 0;
  }

  /**
   * 从屋里走出去：人在室内时，硬往目标走只会沿墙来回蹭。
   * 先找到门（3 格内看得见），开门、迈出去，再谈目的地。
   * 这不是寻路——只是"先出门"这个常识。
   */
  tryExitRoom(tx, ty) {
    const { v, world } = this;
    if (Math.hypot(tx - v.x, ty - v.y) < 3) return false;
    const here = world.map.tile(Math.floor(v.x), Math.floor(v.y));
    const indoors = (here && here.kind === "floor") || !!world.findBed(v);
    if (!indoors) return false;

    let door = null, bd = Infinity;
    const bx = Math.floor(v.x), by = Math.floor(v.y);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const t = world.map.tile(bx + dx, by + dy);
        if (!t || t.kind !== "door") continue;
        const d = Math.hypot(bx + dx + 0.5 - v.x, by + dy + 0.5 - v.y);
        if (d < bd) { bd = d; door = { x: bx + dx, y: by + dy, open: t.walkable }; }
      }
    }
    if (!door) return false;                 // 屋里没有门（露天地板）：照常走
    if (bd <= 1.6) {
      if (!door.open) {
        world.applyAction(v, { type: "interact", x: door.x, y: door.y });
        return true;
      }
      this.stepToward(door.x + 0.5, door.y + 0.5, 1);
      return true;
    }
    this.stepToward(door.x + 0.5, door.y + 0.5, 1);
    return true;
  }

  onBlocked(intent) {
    // 撞墙多半是门关着：手边有门就推一下
    const { v, world } = this;
    const x = Math.floor(v.x), y = Math.floor(v.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = world.map.tile(x + dx, y + dy);
        if (t && t.kind === "door" && !t.walkable) {
          world.applyAction(v, { type: "interact", x: x + dx, y: y + dy });
          return;
        }
      }
    }
  }

  walkRandom() {
    const dirs = ["n", "s", "e", "w"].filter((d) => d !== (this.bumpedName || ""));
    const d = this.rng.pick(dirs) || "n";
    this.bumpedName = this.moveDir(d, 3) ? "" : d;
  }

  /** 站在草地上就有机会踩成路；爱整齐的人更常铺 */
  maybePave() {
    const { world, v, bb } = this;
    if (bb.traits.order < 4.5) return;
    if (!this.rng.chance(0.18)) return;
    if ((v.buildCooldown || 0) > world.tickCount) return;
    const x = Math.floor(v.x), y = Math.floor(v.y);
    const t = world.map.tile(x, y);
    if (!t || t.kind !== "grass") return;
    world.applyAction(v, { type: "build", x, y, kind: "path" });
  }

  // ---------- 说话：桥接层挂了就用兜底台词 ----------

  nearestVillager(radius) {
    let best = null, bd = Infinity;
    for (const o of this.world.entities.values()) {
      if (o === this.v || o.state === "downed" || o.state === "dead") continue;
      const d = Math.hypot(o.x - this.v.x, o.y - this.v.y);
      if (d < radius && d < bd && this.world.canSee(this.v, o)) { bd = d; best = o; }
    }
    return best;
  }

  async maybeSpeak(targetId) {
    if (this.busy) return;
    const target = this.world.entities.get(targetId);
    if (!target) return;

    // 随机值必须在 await 之前取：几个会话同时在飞时，恢复顺序不稳定
    const child = isMinor(this.v);
    const fallbackLine = this.rng.pick(child ? CHILD_LINES : FALLBACK);
    const isPrivate = this.rng.chance(0.1);

    this.busy = true;
    let text = null;
    try {
      text = child ? null : await this.ask(target);
    } catch {
      text = null;
    } finally {
      this.busy = false;
    }
    if (!text) text = fallbackLine;

    this.v.dir = Math.atan2(target.y - this.v.y, target.x - this.v.x);
    const r = this.world.applyAction(this.v, { type: "say", text, to: target.id, private: isPrivate });
    if (r && r.ok) {
      const p = this.bb.mem.people[target.id] || (this.bb.mem.people[target.id] = { talks: 0, lastTalk: 0, attacks: 0, gave: 0, got: 0 });
      p.talks++;
      p.lastTalk = this.world.tickCount;
      if (p.talks >= 5) feel(this.v, this.bb, "friend", 0.3);
    }
  }

  async ask(target) {
    const { world, v, bb } = this;
    const payload = {
      mode: "villager",
      language: "zh",
      npcName: v.name,
      npcDisplayName: v.name,
      npcRole: v.role,
      npcOptimism: v.personality.optimism,
      npcSocialAnxiety: 10 - v.personality.social,
      npcManners: v.personality.manners,
      npcGoal: bb.goals.length ? bb.goals[0].label : "",
      npcMood: bb.mood,
      npcTraits: {
        curiosity: bb.traits.curiosity, industry: bb.traits.industry,
        caution: bb.traits.caution, generosity: bb.traits.generosity
      },
      playerName: target.name,
      playerDisplayName: target.name,
      listenerRole: target.role,
      season: "spring",
      day: world.clock.day,
      timeOfDay: Math.floor(world.clock.minutes),
      weather: "clear",
      location: "村子",
      hearts: 2,
      friendshipStatus: "Acquaintance",
      maxChars: 60
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(BRIDGE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.text || "").trim().slice(0, 80) || null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 给世界里所有居民装上"心"。新出生/新空降的人下一拍自动补上，
 * 不再需要重启服务（以前的 attachBrains 只认启动那一刻在场的人）。
 */
export function attachBrains(world, opts = {}) {
  const minds = new Map();

  const ensure = () => {
    for (const v of world.entities.values()) {
      if (v.state === "dead") continue;
      if (!minds.has(v.id)) minds.set(v.id, new Mind(world, v));
    }
    return minds;
  };

  const tick = () => {
    ensure();
    for (const [id, m] of minds) {
      const v = world.entities.get(id);
      if (!v) { minds.delete(id); continue; }
      if (v.state === "dead") continue;
      if (world.tickCount < m.nextThinkTick) continue;
      m.nextThinkTick = world.tickCount + m.thinkEvery;
      m.update().catch((err) => { if (process.env.BRAIN_DEBUG) console.warn('[mind] ' + v.name + ': ' + err.message); });
    }
  };

  const timer = opts.timer === false ? null : setInterval(tick, 250);
  ensure();   // 先把在场的人装上心，探针/测试能立刻读到状态
  return {
    minds,
    tick,
    stop: () => { if (timer) clearInterval(timer); },
    serialize: () => ({ version: 1, minds: [...minds].map(([id, m]) => [id, m.bb]) }),
    restore: (data) => {
      if (!data || !Array.isArray(data.minds)) return 0;
      let n = 0;
      for (const [id, raw] of data.minds) {
        const m = minds.get(id);
        const bb = restoreBlackboard(raw);
        if (!m || !bb) continue;
        m.bb = bb;
        m.v.personality.optimism = Math.round(bb.traits.optimism);
        m.v.personality.social = Math.round(bb.traits.sociability);
        m.v.personality.manners = Math.round(bb.traits.order);
        n++;
      }
      return n;
    }
  };
}
