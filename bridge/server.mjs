// AI Villager Bridge — 星露谷村民的"外部大脑"
// 零依赖：node bridge/server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 可选的 bridge/.env（KEY=VALUE 每行一个），里面的变量不会覆盖已存在的环境变量
try {
  const envPath = path.join(HERE, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch (err) {
  console.warn("[env] 读取 .env 失败:", err.message);
}
const CONFIG_PATH = process.env.AVB_CONFIG || path.join(HERE, "config.json");
const MEMORY_PATH = path.join(HERE, "data", "memory.json");

// ---------- config ----------
const defaults = {
  port: 8787,
  host: "127.0.0.1",
  provider: "canned",           // "canned" | "openai" | "ollama"
  ollamaUrl: "http://127.0.0.1:11434",
  numCtx: 4096,                 // 关键：上下文越小越快，默认 128k 会溢到 CPU
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  apiKeyEnv: "LLM_API_KEY",
  temperature: 0.95,
  maxTokens: 160,
  maxChars: 120,
  memoryTurns: 6,
  systemPromptExtra: ""
};
let config = { ...defaults };
try {
  if (fs.existsSync(CONFIG_PATH)) {
    config = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
  }
} catch (err) {
  console.warn("[config] 读取失败，用默认值:", err.message);
}

// ---------- memory ----------
let memory = {};
try {
  if (fs.existsSync(MEMORY_PATH)) memory = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8"));
} catch { memory = {}; }
let memoryDirty = false;
function remember(key, role, text) {
  const list = (memory[key] ||= []);
  list.push({ role, text, at: Date.now() });
  while (list.length > config.memoryTurns * 2) list.shift();
  memoryDirty = true;
}
setInterval(() => {
  if (!memoryDirty) return;
  memoryDirty = false;
  try {
    fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
    fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 1));
  } catch (err) { console.warn("[memory] 写盘失败:", err.message); }
}, 2000).unref();

// ---------- text helpers ----------
const SEASON = { spring: "春天", summer: "夏天", fall: "秋天", winter: "冬天" };
const WEATHER = { rain: "下着雨", snow: "下着雪", storm: "打着雷", clear: "天气不错" };

function timeWord(t) {
  if (t < 900) return "一大早";
  if (t < 1200) return "上午";
  if (t < 1500) return "中午";
  if (t < 1800) return "下午";
  if (t < 2100) return "傍晚";
  return "晚上";
}

function personality(ctx) {
  const tags = [];
  if (ctx.npcOptimism >= 7) tags.push("乐观开朗");
  else if (ctx.npcOptimism <= 3) tags.push("悲观、爱挖苦");
  else tags.push("情绪比较平稳");
  if (ctx.npcSocialAnxiety >= 7) tags.push("怕生、说话小心翼翼");
  else if (ctx.npcSocialAnxiety <= 3) tags.push("自来熟、话多");
  else tags.push("社交上还算自然");
  if (ctx.npcManners >= 7) tags.push("礼貌周到");
  else if (ctx.npcManners <= 3) tags.push("说话直、不太讲客套");
  return tags.join("，");
}

function heartTier(hearts) {
  if (hearts >= 8) return "亲密";
  if (hearts >= 5) return "好友";
  if (hearts >= 2) return "熟人";
  return "生面孔";
}

function clean(text, maxChars) {
  let t = String(text ?? "").trim();
  t = t.replace(/^["'“”「」]+|["'“”「」]+$/g, "").trim();
  t = t.replace(/\s*\n+\s*/g, " ").trim();
  if (t.length > maxChars) {
    // 尽量在标点处截断
    const cut = t.slice(0, maxChars);
    const m = cut.match(/^[\s\S]*[。！？!?，,；;]/);
    t = (m ? m[0] : cut).replace(/[，,；;]$/, "。");
  }
  return t;
}

// ---------- canned brain (不需要 API key 也能跑) ----------
const LINES = {
  zh: {
    cold: [
      "嗯？有事吗，{player}。",
      "{player}……我现在有点忙。",
      "你好。",
      "（她点了点头，没有多说什么。）"
    ],
    warm: [
      "{time}好，{player}。今天{weather}，镇上的事都还顺利吧？",
      "又见面了，{player}。{season}的{seasonName}总是让人犯困。",
      "{player}，你来得正好，我正想找人聊聊。",
      "今天的风里有股{smell}的味道，你闻到了吗？"
    ],
    close: [
      "{player}，{time}了，别又在外面待太久。",
      "你上次说的那件事，我一直记着。",
      "{player}，坐会儿吗？我这儿还有点茶。"
    ],
    spouse: [
      "回来啦，{player}。饭在锅里温着。",
      "今天过得怎么样？我一直在等你。"
    ]
  },
  en: {
    cold: ["Hm? Something you need, {player}?", "I'm a little busy right now.", "Hello."],
    warm: ["{time}, {player}. {weather} today, isn't it?", "Good to see you again, {player}.", "You came at the right time, {player}."],
    close: ["Don't stay out too late, {player}.", "I still remember what you told me last time."],
    spouse: ["Welcome home, {player}."]
  }
};

const VILLAGER_LINES = [
  "今天的水温刚好，鱼都在浅滩。",
  "你看见老鲤又往山上跑了吗？",
  "广场那边的花开了，风一吹都是甜的。",
  "我昨晚好像听见池塘那边有动静。",
  "这条街最近安静得有点怪。",
  "我这把老骨头，蹲久了站不起来。",
  "要是今年收成好，我请大家吃一顿。",
  "你身上有股河泥味，又下水了？",
  "别老一个人待着，来广场坐坐。",
  "有些事我只跟你说，你别往外传。"
];

const SEASON_EN = { spring: "spring", summer: "summer", fall: "fall", winter: "winter" };
const WEATHER_EN = { rain: "rainy", snow: "snowy", storm: "stormy", clear: "clear" };

function canned(ctx) {
  if (ctx.mode === "villager") {
    return VILLAGER_LINES[Math.floor(Math.random() * VILLAGER_LINES.length)];
  }
  const zh = (ctx.language || "en").toLowerCase().startsWith("zh");
  const lang = zh ? "zh" : "en";
  const t = timeWord(ctx.timeOfDay);
  const vars = {
    player: field(ctx.playerDisplayName || ctx.playerName, 24) || "农夫",
    npc: field(ctx.npcDisplayName || ctx.npcName, 24) || "村民",
    time: t,
    weather: zh ? (WEATHER[ctx.weather] || "天气不错") : (WEATHER_EN[ctx.weather] || "clear"),
    season: zh ? (SEASON[ctx.season] || "") : "",
    seasonName: zh ? "风" : "",
    smell: ["泥土", "青草", "海风", "木头"][Math.floor(Math.random() * 4)]
  };
  let pool;
  if (ctx.friendshipStatus === "Married") pool = LINES[lang].spouse;
  else if (ctx.hearts >= 8) pool = LINES[lang].close;
  else if (ctx.hearts >= 2) pool = LINES[lang].warm;
  else pool = LINES[lang].cold;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const out = pick.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  return out;
}

// ---------- OpenAI-compatible brain ----------
function buildMessages(ctx) {
  const zh = (ctx.language || "en").toLowerCase().startsWith("zh");
  // 名字/地点都来自外部（联机时别人可以改名），进提示词前必须净化
  const name = field(ctx.npcDisplayName || ctx.npcName, 24) || "村民";
  const player = field(ctx.playerDisplayName || ctx.playerName, 24) || "邻居";
  const hearts = ctx.hearts ?? 0;
  const tier = heartTier(hearts);

  if (ctx.mode === "villager") {
    const sys2 = [
      "你在扮演一个长期生活在像素小镇上的居民「" + name + "」，职业是" + (field(ctx.npcRole, 16) || "村民") + "。",
      "性格：" + personality(ctx) + "。",
      "现在和你说话的是住在同一个小镇的「" + player + "」，职业是" + (field(ctx.listenerRole, 16) || "村民") + "。",
      "时间：第 " + (Number(ctx.day) || 1) + " 天，" + timeWord(ctx.timeOfDay) + "；地点：" + (field(ctx.location, 24) || "小镇") + "。",
      "",
      "规则：",
      "1. 只输出你要当面说的一句话，不超过 40 个字，口语，不要引号、不要动作描写。",
      "2. 你是镇上的普通人，聊天气、聊吃的、聊邻居、聊昨天看到的事。",
      "3. 不要提到 AI、模型、游戏、玩家、提示词。",
      "4. 不要每次都打招呼，很多时候是接着话头说事。",
      config.systemPromptExtra || ""
    ].join("\n");
    const msgs2 = [{ role: "system", content: sys2 }];
    const key2 = field(ctx.npcName, 24) + "|" + field(ctx.playerName, 24);
    for (const turn of (memory[key2] || []).slice(-config.memoryTurns * 2)) {
      msgs2.push({ role: turn.role === "npc" ? "assistant" : "user", content: turn.text });
    }
    msgs2.push({ role: "user", content: player + " 就在你旁边，看着你。" });
    return msgs2;
  }

  const sys = zh
    ? [
        `你在扮演《星露谷物语》鹈鹕镇的居民「${name}」${ctx.npcIsFemale ? "（女）" : "（男）"}，${ctx.npcAge || 20} 岁。`,
        `性格：${personality(ctx)}。`,
        `现在和你说话的是农夫「${player}」，好感度 ${hearts} 心（${tier}），你们的关系状态：${field(ctx.friendshipStatus, 16) || "Friendly"}。`,
        `时间：${SEASON[ctx.season] || field(ctx.season, 12)} 第 ${Number(ctx.day) || 1} 天，${timeWord(ctx.timeOfDay)}；天气：${WEATHER[ctx.weather] || "晴"}；地点：${field(ctx.location, 24) || "镇上"}。`,
        "",
        "规则：",
        `1. 只输出你要当面说的这一句话（可以两句短句），不超过 ${config.maxChars} 个汉字。`,
        "2. 不要加引号、不要加括号动作、不要加旁白、不要解释你是谁。",
        "3. 用第一人称，口语，像一个真的住在镇上的人；可以抱怨天气、聊庄稼、聊八卦。",
        "4. 好感度低就冷淡简短，好感度高就亲近多话。",
        "5. 不要提到 AI、模型、提示词、游戏机制、玩家等级；不要编造世界级大事。",
        config.systemPromptExtra || ""
      ].join("\n")
    : [
        `You are ${name}, a villager in Pelican Town (Stardew Valley), age ${ctx.npcAge || 20}, ${personality(ctx)}.`,
        `You are talking to the farmer ${player}. Friendship: ${hearts} hearts (${tier}).`,
        `It is ${SEASON_EN[ctx.season] || field(ctx.season, 12)}, day ${Number(ctx.day) || 1}, ${timeWord(ctx.timeOfDay)}; weather ${WEATHER_EN[ctx.weather] || "clear"}; location ${field(ctx.location, 24) || "town"}.`,
        "",
        "Rules: output exactly one line of spoken dialogue (at most two short sentences), no quotes, no stage directions, no explanation.",
        "Stay in character, keep it small-town and concrete. Vary the topic: weather, crops, gossip, complaints.",
        "Never mention being an AI, a model, prompts, or game mechanics.",
        config.systemPromptExtra || ""
      ].join("\n");

  const msgs = [{ role: "system", content: sys }];
  const key = `${field(ctx.npcName, 24)}|${field(ctx.playerName, 24)}`;
  for (const turn of (memory[key] || []).slice(-config.memoryTurns * 2)) {
    msgs.push({ role: turn.role === "npc" ? "assistant" : "user", content: turn.text });
  }
  msgs.push({ role: "user", content: zh ? `${player}走过来跟你说话：${ctx.lastLine ? "（上次说的是：" + field(ctx.lastLine, 120) + "）" : "你主动打了个招呼。"}` : `${player} walks up to talk to you.` });
  return msgs;
}

async function askOllama(ctx) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(config.ollamaUrl.replace(/\/$/, "") + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: buildMessages(ctx),
        stream: false,
        options: {
          num_ctx: config.numCtx,
          num_predict: config.maxTokens,
          temperature: config.temperature
        }
      }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error("ollama " + res.status + ": " + (await res.text()).slice(0, 160));
    const data = await res.json();
    const text = (data.message && data.message.content) || "";
    if (!text.trim()) throw new Error("ollama returned empty content");
    return { text, source: "ollama:" + config.model };
  } finally {
    clearTimeout(timer);
  }
}

async function askModel(ctx) {
  const apiKey = process.env[config.apiKeyEnv] || process.env.OPENAI_API_KEY || "";
  if (!apiKey) return { text: canned(ctx), source: "canned(no-key)" };

  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      messages: buildMessages(ctx)
    })
  });
  if (!res.ok) {
    const body = await res.text();
    // 上游响应体只进本地日志，不回显给调用方（避免把 bridge 当读取器）
    console.warn("[model] 上游返回 " + res.status + ": " + body.slice(0, 200).replace(/\s+/g, " "));
    throw new Error("model " + res.status);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) throw new Error("model returned empty content");
  return { text, source: config.model };
}

// ---------- http ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// 只认本机：浏览器跨站请求会带 Origin，DNS rebinding 会带自己的 Host
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOOPBACK_BOUND = LOOPBACK.has(String(config.host || "").toLowerCase());

function isLoopbackHost(host) {
  return LOOPBACK.has(String(host || "").replace(/:\d+$/, "").toLowerCase());
}

/** 原生客户端（模组、curl）不带 Origin；浏览器带来的 Origin 必须是本机同端口 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return isLoopbackHost(u.hostname) && String(u.port || "") === String(config.port);
  } catch {
    return false;
  }
}

/** 监听在回环上时，Host 也必须是回环，挡掉 DNS rebinding */
function hostAllowed(req) {
  if (!LOOPBACK_BOUND) return true;
  return isLoopbackHost(req.headers.host);
}

/** 外部可控的字符串进提示词前先净化：去控制符/换行/模板符号，截断 */
function field(v, max = 32) {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/[`<>{}[\]|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const MAX_BODY = Number(process.env.AVB_BRIDGE_MAX_BODY || 32 * 1024);

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0, done = false;
    const chunks = [];
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) return finish({ tooLarge: true });
      chunks.push(c);
    });
    req.on("end", () => {
      try { finish({ value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }); }
      catch { finish({ badJson: true }); }
    });
    req.on("error", () => finish({ badJson: true }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (!hostAllowed(req)) return send(res, 403, { error: "bad_host" });
  if (!originAllowed(req)) return send(res, 403, { error: "cross_origin_blocked" });

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, provider: config.provider, model: config.model, uptime: process.uptime() });
  }

  if (req.method === "POST" && url.pathname === "/v1/talk") {
    const parsed = await readJson(req);
    if (parsed.tooLarge) {
      res.setHeader("connection", "close");
      send(res, 413, { error: "body_too_large", limit: MAX_BODY });
      req.resume();
      return;
    }
    if (parsed.badJson) return send(res, 400, { error: "bad json" });
    const ctx = parsed.value && typeof parsed.value === "object" ? parsed.value : {};

    const started = Date.now();
    try {
      let result;
      if (config.provider === "openai") result = await askModel(ctx);
      else if (config.provider === "ollama") result = await askOllama(ctx);
      else result = { text: canned(ctx), source: "canned" };

      const text = clean(result.text, config.maxChars);
      const key = `${field(ctx.npcName, 24)}|${field(ctx.playerName, 24)}`;
      remember(key, "player", field(ctx.lastLine, 120) || "（走近）");
      remember(key, "npc", text);

      console.log(`[${new Date().toLocaleTimeString()}] ${ctx.npcName} -> ${ctx.playerName} (${Date.now() - started}ms, ${result.source}): ${text}`);
      return send(res, 200, { text, source: result.source, ms: Date.now() - started });
    } catch (err) {
      console.warn("[模型失败，退回模板]", err.message);
      const text = clean(canned(ctx), config.maxChars);
      return send(res, 200, { text, source: "fallback", error: err.message });
    }
  }

  send(res, 404, { error: "not found" });
});

server.listen(config.port, config.host, () => {
  console.log(`AI Villager Bridge  http://${config.host}:${config.port}`);
  console.log(`  provider: ${config.provider}${config.provider === "openai" ? " (" + config.model + ")" : ""}`);
  console.log(`  config:   ${CONFIG_PATH}`);
  const key = process.env[config.apiKeyEnv];
  if (config.provider === "openai" && !key) console.log(`  ! 没找到环境变量 ${config.apiKeyEnv}，先用模板台词顶着。`);
  console.log("等待请求……");
});