// 外部 AI 客户端模板
// 用法：
//   node examples/agent-client.mjs [服务器地址]
//   接本地模型：LLM_BASE_URL=http://127.0.0.1:11434/v1 LLM_MODEL=qwen2.5vl:7b node examples/agent-client.mjs
//   带人设：   PERSONA="你是个嘴硬心软的渔夫" node examples/agent-client.mjs
//
// 两种脑子：
//   1. 有 LLM_* 环境变量 → 用模型想（本地模型、自建服务、任何 OpenAI 兼容端点）
//   2. 没有 → 内置探索策略（不花钱，用来验证链路）
// 记忆永远在本地：memory 存盘即可，换模型不受影响。
import fs from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:8090";
const LLM_URL = process.env.LLM_BASE_URL || "";
const LLM_MODEL = process.env.LLM_MODEL || "";
const LLM_KEY = process.env.LLM_API_KEY || "local";
const PERSONA = process.env.PERSONA || "";
const MEMORY_FILE = process.env.MEMORY_FILE || "./agent-memory.json";

const reg = await (await fetch(BASE + "/api/agents/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: process.env.NAME || "我的AI", persona: PERSONA })
})).json();

if (!reg.token) {
  console.error("注册失败:", JSON.stringify(reg));
  process.exit(1);
}
console.log("接到一条鱼:", reg.villager.name, "(" + reg.villager.id + ")", LLM_MODEL ? "脑=" + LLM_MODEL : "脑=内置策略");

let memory = { visited: {}, lastPos: null };
try { memory = { ...memory, ...JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")) }; } catch {}
setInterval(() => {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory)); } catch {}
}, 5000);

const DIRS = [["n", 0, -1], ["s", 0, 1], ["w", -1, 0], ["e", 1, 0]];
const key = (x, y) => Math.round(x) + "," + Math.round(y);
const tileAt = (obs, dx, dy) => {
  const r = obs.view.tileRadius;
  const row = obs.view.tiles[r + dy];
  return row ? row[r + dx] : "?";
};

const SYS = [
  PERSONA || "你是一个刚搬进像素小镇的居民。",
  "",
  "你能做的动作（一次最多 3 个）：",
  "- {type:'move',dir:'n|s|e|w',tiles:1..32} 朝一个方向连续走几格（前面挡住就停，不算错）",
  "- {type:'build',x:整数,y:整数,kind:'flower|bench|fence|lamp'} 在身边的空地放东西",
  "- {type:'remove',x:整数,y:整数} 拆掉别人造的",
  "- {type:'say',text:'...',to:'实体id?'} 说话",
  "- {type:'face',dir:弧度} 转身",
  "- {type:'interact',x:整数,y:整数} 开门/灶台",
  "- {type:'eat'} / {type:'rest'}",
  "- {type:'shareMap',targetId:'实体id'} 把你知道的地方告诉别人",
  "",
  "地形：. 可走 # 挡路 D 门(关) d 门(开) ~ 水 ? 看不见 @ 你",
  "只输出 JSON：{\"actions\":[...]}"
].join("\n");

async function askModel(obs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(LLM_URL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + LLM_KEY },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.9,
        max_tokens: 160,
        messages: [
          { role: "system", content: SYS },
          {
            role: "user",
            content: JSON.stringify({
              me: { name: obs.self.name, x: obs.self.x, y: obs.self.y, needs: obs.self.needs },
              seen: obs.view.entities.map((e) => ({ id: e.id, name: e.name, x: e.x, y: e.y })),
              tiles: obs.view.tiles,
              explored: obs.exploredCount
            })
          }
        ]
      }),
      signal: ctrl.signal
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    const obj = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(obj.actions) ? obj.actions : null;
  } catch (err) {
    console.error("模型失败:", err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function heuristic(obs) {
  const me = obs.self;
  const other = obs.view.entities[0];

  if (me.needs.hunger < 35) return [{ type: "eat" }];
  if (me.needs.energy < 25) return [{ type: "rest" }];

  if (other) {
    const d = Math.hypot(other.x - me.x, other.y - me.y);
    if (d < 3) {
      const acts = [{ type: "face", dir: Math.atan2(other.y - me.y, other.x - me.x) }];
      if (Math.random() < 0.4) acts.push({ type: "say", text: "你那边有什么？", to: other.id });
      return acts;
    }
  }

  const here = key(me.x, me.y);
  memory.visited[here] = (memory.visited[here] || 0) + 1;
  memory.lastPos = here;

  const options = DIRS.filter(([, dx, dy]) => {
    const c = tileAt(obs, dx, dy);
    return c === "." || c === "d";
  });
  if (!options.length) return [{ type: "rest" }];
  options.sort((p, q) => {
    const a = memory.visited[key(me.x + p[1], me.y + p[2])] || 0;
    const b2 = memory.visited[key(me.x + q[1], me.y + q[2])] || 0;
    return a - b2;
  });
  // 一次走 3 格；撞上了下次换方向（blocked 会在下一轮被避开）
  return [{ type: "move", dir: options[0][0], tiles: 3 }];
}

while (true) {
  try {
    const obs = await (await fetch(BASE + "/api/agents/" + reg.token + "/observation")).json();
    if (obs.error) { console.error("观察失败:", obs.error); break; }

    let actions = LLM_MODEL ? await askModel(obs) : null;
    if (!actions || !actions.length) actions = heuristic(obs);

    const r = await (await fetch(BASE + "/api/agents/" + reg.token + "/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions: actions.slice(0, 3) })
    })).json();
    if (r.error) console.error("行动被拒:", JSON.stringify(r));
  } catch (err) {
    console.error("网络错误:", err.message);
  }
  await new Promise((r) => setTimeout(r, LLM_MODEL ? 900 : 420));
}