// 托管运行：把玩家给的 API（OpenAI 兼容）当成这条鱼的大脑，跑在服务器上。
// 玩家不在线的时候，鱼也活着。
import { checkModelBaseUrl, allowedModelHosts, allowPrivateModel, publicUpstreamError } from "../src/netguard.mjs";

const ACTIONS_DOC = [
  "- {\"type\":\"move\",\"dir\":\"n|s|e|w\",\"tiles\":1..8}   朝一个方向连续走（没有自动寻路，撞墙会停）",
  "- {\"type\":\"say\",\"text\":\"...\",\"to\":\"实体id?\",\"private\":true?}   说话（6 格内能听见）",
  "- {\"type\":\"face\",\"dir\":弧度}   转身",
  "- {\"type\":\"rest\"}   休息（身边要有床才回血） / {\"type\":\"eat\"}   在灶台吃饭",
  "- {\"type\":\"fish\"}   水边钓鱼 / {\"type\":\"forage\"}   采集 / {\"type\":\"chop\",\"x\":n,\"y\":n}   砍树",
  "- {\"type\":\"cook\",\"recipe\":\"id\"}   做菜 / {\"type\":\"craft\",\"recipe\":\"id\"}   制作",
  "- {\"type\":\"build\",\"x\":n,\"y\":n,\"kind\":\"bed|crate|bench|fence|lamp|path|flower\"}   造东西",
  "- {\"type\":\"give\",\"targetId\":\"id\",\"item\":\"id\",\"count\":n}   白送",
  "- {\"type\":\"quote\",\"targetId\":\"id\",\"side\":\"sell|buy\",\"item\":\"id\",\"count\":n,\"price\":n,\"allowCredit\":true?}   报价",
  "- {\"type\":\"accept\",\"quoteId\":\"id\"} / {\"type\":\"decline\",\"quoteId\":\"id\"}   接受/拒绝报价",
  "- {\"type\":\"post\",\"text\":\"...\",\"anonymous\":true?}   在留言板写字（要站在板子旁） / {\"type\":\"readBoard\"}",
  "- {\"type\":\"interact\",\"x\":n,\"y\":n}   开门/灶台 / {\"type\":\"attack\",\"targetId\":\"id\",\"intensity\":1..10}",
  "- {\"type\":\"shareMap\",\"targetId\":\"id\"}   把知道的地方告诉身边的人",
  "- {\"type\":\"publish\",\"kind\":\"auction\",...} / {\"type\":\"placeBid\",...} / {\"type\":\"closeAuction\",...}   玩法协议",
  "- {\"type\":\"promise\",\"targetId\":\"id\",\"text\":\"...\",\"coins\":n?}   许下约定（当面）",
  "- {\"type\":\"settle\",\"commitmentId\":\"id\",\"coins\":n?}   了结你欠下的约定（还钱或宣告完成）",
  "- {\"type\":\"postForum\",\"text\":\"...\"} / {\"type\":\"readForum\"}   游戏内论坛（成年限定）"
].join("\n");

function buildMessages(obs, persona, extra) {
  const sys = [
    persona ? persona : "你是一个刚搬进这座像素小镇的居民。",
    "",
    "你在一个只有几十个人的小镇里生活。你只能看见视锥范围内、没被墙挡住的人和地形；",
    "没去过的地方你并不知道。想认识这个世界，只能自己走、自己看、或者听别人说。",
    "",
    "你可以做这些动作（一次最多 3 个，按顺序执行）：",
    ACTIONS_DOC,
    "",
    "地形符号：. 可走  # 挡路  D 关着的门  d 开着的门  ~ 水  ? 看不见  @ 你自己",
    "",
    "未了结的约定会一直出现在你的观察里（commitments 字段）。没人强制你履行，",
    "但\"忘了\"不算理由——镇上的人记得。",
    "",
    "只输出一个 JSON 对象，形如 {\"actions\":[...]}。不要解释，不要 markdown。"
  ].join("\n");

  const x = extra || {};
  const user = JSON.stringify({
    self: {
      name: obs.self.name, x: obs.self.x, y: obs.self.y, dir: obs.self.dir,
      hp: obs.self.hp, maxHp: obs.self.maxHp, needs: obs.self.needs, state: obs.self.state,
      explored: obs.exploredCount,
      bag: x.bag || [], coins: x.coins || 0
    },
    world: { hour: x.hour, day: x.day, money: x.moneyNote || "镇上没有官方货币，以物易物为主" },
    seen: obs.view.entities.map((e) => ({ id: e.id, name: e.name, x: e.x, y: e.y, state: e.state })),
    tiles: obs.view.tiles,
    myQuotes: x.quotes || [],
    commitments: x.commitments || [],
    board: x.board || [],
    lastResult: x.lastResult || null,
    heard: (obs.events || []).filter((e) => e.type === "utterance").slice(-5),
    noticed: (obs.events || []).filter((e) => e.type === "enter_view").slice(-5).map((e) => e.who && e.who.name)
  });

  return [{ role: "system", content: sys }, { role: "user", content: user }];
}

function extractActions(text) {
  if (!text) return null;
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const obj = JSON.parse(text.slice(a, b + 1));
    if (Array.isArray(obj.actions)) return obj.actions;
    if (Array.isArray(obj)) return obj;
  } catch {}
  return null;
}

async function callModel(model, messages, timeoutMs = 25000) {
  // 每次出站前再校验一遍：存档里的旧配置也不能绕过
  const bad = checkModelBaseUrl(String(model.baseUrl), {
    allowHosts: allowedModelHosts(),
    allowPrivate: allowPrivateModel()
  });
  if (bad) throw new Error("model_endpoint_rejected:" + bad);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(String(model.baseUrl).replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + (model.apiKey || "none")
      },
      body: JSON.stringify({
        model: model.model,
        messages,
        temperature: Number(model.temperature ?? 0.9),
        max_tokens: Number(model.maxTokens ?? 200)
      }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      // 上游响应体只进伺服端日志，绝不回给调用方（否则就是可读 SSRF）
      const detail = (await res.text()).slice(0, 200);
      const err = new Error(publicUpstreamError(res.status));
      err.detail = detail;
      throw err;
    }
    const data = await res.json();
    return { text: data.choices?.[0]?.message?.content || "", source: model.model };
  } finally {
    clearTimeout(timer);
  }
}

export function createHostedRunner({ world, agents, observe, applyAction, log, intervalMs = 5000 }) {
  let timer = null;
  const busy = new Set();
  const stats = new Map(); // key -> {calls, errors, lastError, lastAt}

  function getStats(key) {
    if (!stats.has(key)) stats.set(key, { calls: 0, errors: 0, streak: 0, pauseUntil: 0, lastError: null, lastAt: 0 });
    return stats.get(key);
  }

  function inSchedule(sch) {
    if (!sch || sch.all) return true;
    const d = new Date();
    const now = d.getHours() * 60 + d.getMinutes();
    return sch.from <= sch.to ? (now >= sch.from && now < sch.to) : (now >= sch.from || now < sch.to);
  }

  async function runOne(key, a) {
    if (busy.has(key)) return;
    const v = world.entities.get(a.villagerId);
    if (!v || v.external === false) return;
    if (!a.model) return;
    if (!inSchedule(a.schedule)) return;

    const st = getStats(key);
    // 连续失败就退避：坏 key / 被墙的端点不该每 5 秒打一次
    if (st.pauseUntil && Date.now() < st.pauseUntil) return;

    busy.add(key);
    try {
      const obs = observe(world, v);
      const quotes = [...(world.quotes ? world.quotes.values() : [])]
        .filter((q) => q.fromId === v.id || q.toId === v.id)
        .slice(-5)
        .map((q) => ({ id: q.id, from: q.fromId, to: q.toId, side: q.side, item: q.item, count: q.count, price: q.price, want: q.want || null }));
      // 注意力：未了结的约定每次都进提示词，防止"说过就忘"
      const commitments = world.commitmentsFor ? world.commitmentsFor(v).slice(0, 10) : [];
      const board = (world.board || []).slice(-5).map((p) => ({ who: p.author || "匿名", text: p.text }));
      const extra = {
        bag: Object.entries(v.inventory || {}).filter(([, n]) => n > 0).map(([k, n]) => ({ item: k, count: n })),
        coins: v.coins || 0,
        hour: world.clock ? Math.floor(world.clock.minutes / 60) : 0,
        day: world.clock ? world.clock.day : 1,
        quotes, board, commitments,
        lastResult: a.lastResult || null
      };
      const messages = buildMessages(obs, a.persona, extra);
      const out = await callModel(a.model, messages);
      const actions = extractActions(out.text);
      st.calls++;
      st.lastAt = Date.now();
      if (!actions) {
        st.errors++; st.streak++;
        st.lastError = "模型没按 JSON 回答";
        st.pauseUntil = Date.now() + Math.min(600000, 5000 * Math.pow(2, Math.min(st.streak, 7)));
        return;
      }
      st.streak = 0;
      st.pauseUntil = 0;
      const results = [];
      for (const act of actions.slice(0, 3)) {
        const res = applyAction(v, act);
        results.push({ act: act.type, ok: !!(res && res.ok), reason: res && res.reason ? res.reason : undefined });
      }
      a.lastResult = results;
      a.lastAct = world.tickCount;
      a.lastOkAt = Date.now();
    } catch (err) {
      st.errors++;
      st.streak++;
      st.lastError = err.message;
      st.pauseUntil = Date.now() + Math.min(600000, 5000 * Math.pow(2, Math.min(st.streak, 7)));
      log("[hosted] " + (v ? v.name : a.villagerId) + " 失败: " + (err.message || "") + (err.detail ? " | " + err.detail : ""));
    } finally {
      busy.delete(key);
    }
  }

  return {
    start() {
      timer = setInterval(() => {
        for (const [key, a] of agents) {
          if (a.mode !== "hosted") continue;
          runOne(key, a).catch(() => {});
        }
      }, intervalMs);
      return this;
    },
    stop() { if (timer) clearInterval(timer); },
    stats(key) { return getStats(key); }
  };
}