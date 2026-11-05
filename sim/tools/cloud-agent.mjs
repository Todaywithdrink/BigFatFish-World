// 外部模型 Agent 示例：用 OpenAI 兼容模型决定每一步，接进小镇里的一条鱼。
// 所有连接信息由环境变量提供，仓库不含任何真实地址、邀请码或密钥：
//   WORLD   世界服务地址（默认本机 127.0.0.1:8090）
//   INVITE  邀请码（用 `node tools/invite.mjs new 名字 次数 小时` 自行生成）
//   DS_KEY  模型 API Key；不填则只用 fallback 安全动作

const BASE = (process.env.WORLD || "http://127.0.0.1:8090").replace(/\/$/, "");
const INVITE = process.env.INVITE || "";
const NAME = process.env.NAME || "外部模型小鱼";
const PERSONA = process.env.PERSONA || "你是由外部模型接管的一位居民，好奇、话不多，喜欢在水边待着。";
const KEY = process.env.DS_KEY || "";
const MODEL = process.env.MODEL || "deepseek-chat";
const TICK_MS = Number(process.env.TICK_MS || 2500);

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!INVITE) {
  console.error("缺少 INVITE：请先用 node tools/invite.mjs 生成邀请码，再以环境变量传入。");
  process.exit(1);
}
if (!KEY) console.warn("未设置 DS_KEY：将只使用 fallback 安全动作，世界仍会正常推进。");

async function j(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let v = null;
  try { v = JSON.parse(t); } catch { v = t; }
  return { status: r.status, body: v };
}

const reg = await j(BASE + "/api/agents/register", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: NAME, mode: "client", persona: PERSONA, invite: INVITE })
});
if (!reg.body || !reg.body.token) {
  log("注册失败", reg.status, JSON.stringify(reg.body));
  process.exit(1);
}
const token = reg.body.token;
log("拿到鱼:", reg.body.villager.name, "token", token.slice(0, 8));

const SYS = [
  PERSONA,
  "",
  "你在一座像素小镇里过日子，只能看到视锥内、没被墙挡住的东西。",
  "可用动作（一次最多 3 个）：",
  "- {type:'move',dir:'n|s|e|w',tiles:1..6} 走几步（前面挡住会自己停下）",
  "- {type:'say',text:'...',to:'实体id?'} 说话（旁边的人听得见）",
  "- {type:'fish'} 在水边钓鱼 / {type:'forage'} 在树边捡东西 / {type:'eat'} 在灶台吃饭 / {type:'rest'} 休息",
  "- {type:'build',x:整数,y:整数,kind:'flower|bench|lamp'} 在空地上放东西",
  "- {type:'post',text:'...'} 在留言板写字（要站在板子旁边）",
  "地形：. 可走  # 挡路  D 关门  d 开门  ~ 水  ? 看不见  @ 你自己",
  "只输出 JSON：{\"actions\":[...]}，不要解释。"
].join("\n");

async function decide(obs) {
  if (!KEY) return null;
  const user = JSON.stringify({
    self: { name: obs.self.name, x: obs.self.x, y: obs.self.y, hp: obs.self.hp, coins: obs.self.coins, needs: obs.self.needs, bag: obs.self.inventory, known: obs.exploredCount },
    seen: obs.view.entities.map((e) => ({ id: e.id, name: e.name, uid: e.uid, x: e.x, y: e.y })),
    tiles: obs.view.tiles,
    atBoard: obs.view.atBoard,
    heard: (obs.events || []).filter((e) => e.type === "utterance").slice(-4).map((e) => e.from.name + ": " + e.text)
  });
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model: MODEL, temperature: 0.95, max_tokens: 200,
      messages: [{ role: "system", content: SYS }, { role: "user", content: user }]
    })
  });
  if (!r.ok) { log("模型错误", r.status, (await r.text()).slice(0, 160)); return null; }
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || "";
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const obj = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(obj.actions) ? obj.actions : null;
  } catch { return null; }
}

function fallback(obs) {
  const t = obs.view.tiles, r = obs.view.tileRadius;
  const at = (dx, dy) => (t[r + dy] && t[r + dy][r + dx]) || "?";
  const dirs = [["n", 0, -1], ["s", 0, 1], ["w", -1, 0], ["e", 1, 0]];
  const ok = dirs.filter(([, dx, dy]) => at(dx, dy) === "." || at(dx, dy) === "d");
  if (!ok.length) return [{ type: "rest" }];
  return [{ type: "move", dir: ok[Math.floor(Math.random() * ok.length)][0], tiles: 2 }];
}

let n = 0;
for (;;) {
  try {
    const o = await j(BASE + "/api/agents/" + token + "/observation");
    if (!o.body || o.body.error) { log("观察失败", o.status, JSON.stringify(o.body).slice(0, 120)); break; }
    const obs = o.body;
    let actions = await decide(obs);
    if (!actions || !actions.length) actions = fallback(obs);
    const res = await j(BASE + "/api/agents/" + token + "/act", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions: actions.slice(0, 3) })
    });
    if (res.status !== 200) log("行动被拒", res.status, JSON.stringify(res.body).slice(0, 120));
    else if (n % 5 === 0) log("第" + n + "轮", JSON.stringify(res.body.results).slice(0, 160));
    n++;
  } catch (err) {
    log("网络错误", err.message);
  }
  await new Promise((r) => setTimeout(r, TICK_MS));
}
