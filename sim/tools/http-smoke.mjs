// 冒烟：拉起真实服务，逐条验证边界（临时目录 + 临时端口，不碰正式存档）
import { spawn } from "node:child_process";
import http from "node:http";

const PORT = 8095;
const DIR = process.env.SIM_DIR || process.cwd();

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    INVITE_REQUIRED: "0",
    BRAINS: "0",
    AVB_ALLOWED_MODEL_HOSTS: "api.deepseek.com",
    http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "",
    ALL_PROXY: "", all_proxy: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));

const req = (method, path, { headers = {}, body = null } = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: j, raw: data });
      });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ok   " + msg); }
  else { fail++; console.log("  FAIL " + msg + (extra ? "  → " + JSON.stringify(extra).slice(0, 200) : "")); }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 等端口起来
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await req("GET", "/api/health"); if (r.status === 200) { up = true; break; } }
    catch { /* retry */ }
    await wait(250);
  }
  if (!up) { console.log("服务没起来：\n" + serverLog.slice(-1500)); child.kill(); process.exit(1); }

  console.log("\n[1] 健康检查");
  const h = await req("GET", "/api/health");
  ok(h.status === 200 && h.body && h.body.ok === true, "GET /api/health → 200");

  console.log("\n[2] CORS 只给同源");
  const evil = await req("GET", "/api/health", { headers: { Origin: "http://evil.example.com" } });
  ok(evil.headers["access-control-allow-origin"] === undefined || evil.headers["access-control-allow-origin"] === "http://127.0.0.1:8095",
    "外部 Origin 不拿 ACAO", evil.headers["access-control-allow-origin"]);
  const self = await req("GET", "/api/health", { headers: { Origin: "http://127.0.0.1:" + PORT } });
  ok(self.headers["access-control-allow-origin"] === "http://127.0.0.1:" + PORT, "同源回显 ACAO", self.headers["access-control-allow-origin"]);

  console.log("\n[3] 请求体上限");
  const big = JSON.stringify({ invite: "x", pad: "a".repeat(300000) });
  const bigRes = await req("POST", "/api/agents/register", {
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(big) },
    body: big
  });
  ok(bigRes.status === 413, "300KB body → 413（实际 " + bigRes.status + "）", bigRes.body);

  console.log("\n[4] 托管端点白名单");
  const meta = await req("POST", "/api/agents/register", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "hosted", model: { baseUrl: "https://169.254.169.254/latest", model: "x", apiKey: "k" } })
  });
  ok(meta.status === 400, "云元数据地址被拒（实际 " + meta.status + "）", meta.body);
  const lo = await req("POST", "/api/agents/register", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "hosted", model: { baseUrl: "http://127.0.0.1:11434/v1", model: "x", apiKey: "k" } })
  });
  ok(lo.status === 400, "本机端点被拒（实际 " + lo.status + "）", lo.body);
  const plain = await req("POST", "/api/agents/register", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "hosted", model: { baseUrl: "http://api.deepseek.com", model: "x", apiKey: "k" } })
  });
  ok(plain.status === 400, "http 明文端点被拒（实际 " + plain.status + "）", plain.body);

  console.log("\n[5] 客户端接入 + 动作限速");
  const reg = await req("POST", "/api/agents/register", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "冒烟鱼" })
  });
  ok(reg.status === 200 && reg.body && reg.body.token, "注册成功拿到 token");
  const token = reg.body && reg.body.token;
  if (token) {
    const obs = await req("GET", "/api/agents/" + token + "/observation");
    ok(obs.status === 200 && obs.body && obs.body.self, "GET observation → 200");
    ok(!JSON.stringify(obs.body || {}).includes("talent"), "observation 不含天赋");

    const act1 = await req("POST", "/api/agents/" + token + "/act", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions: [{ type: "wait" }] })
    });
    ok(act1.status === 200, "第一次 act → 200");
    const act2 = await req("POST", "/api/agents/" + token + "/act", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions: [{ type: "wait" }] })
    });
    ok(act2.status === 429, "紧接着第二次 act → 429 冷却（实际 " + act2.status + "）");

    // 并发绕过检查：同一个 token 同时打 4 发
    const burst = await Promise.all([1, 2, 3, 4].map(() =>
      req("POST", "/api/agents/" + token + "/act", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actions: [{ type: "wait" }] })
      }).then((r) => r.status).catch(() => 0)
    ));
    ok(burst.filter((s) => s === 200).length === 0, "冷却期内并发也不放行（" + burst.join(",") + "）");

    const badTok = await req("GET", "/api/agents/t_deadbeef/observation");
    ok(badTok.status === 401, "错误 token → 401（实际 " + badTok.status + "）");
  }

  // 村民用完之后的接入：会当场生一个新居民并把地图长一块。
  // 这条曾经把注册打成 400——变更通道先查实体，而"生长/新生"根本没有实体可查。
  console.log("\n[5b] 没有空位时也能接入");
  let okCount = 0;
  for (let i = 0; i < 4; i++) {
    const r = await req("POST", "/api/agents/register", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "补位" + i })
    });
    if (r.status === 200 && r.body && r.body.token) okCount++;
  }
  ok(okCount >= 2, "村民用完后仍能注册（成功 " + okCount + " 次）");

  console.log("\n[6] 观众视角不含私密/天赋");
  const w = await req("GET", "/api/world");
  ok(w.status === 200, "GET /api/world → 200");
  const s = JSON.stringify(w.body || {});
  ok(!s.includes("talent") && !s.includes("recipeProgress"), "全量快照不含 talent / recipeProgress");

  console.log("\n[6b] 玩家身份模型：player 记忆导出 / pet 转生标识");
  let petToken = null;
  {
    const reg = await req("POST", "/api/agents/register", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "带记忆的", playerType: "player" })
    });
    ok(reg.status === 200 && reg.body.playerType === "player", "player 型注册返回身份标识");
    const mem = await req("GET", "/api/agents/" + reg.body.token + "/memory");
    ok(mem.status === 200 && mem.body && mem.body.self && Array.isArray(mem.body.acquaintances)
      && Array.isArray(mem.body.commitments), "memory 导出含 self/acquaintances/commitments");
    ok(mem.body.commitments !== undefined, "承诺随记忆导出（注意力外置）");

    const pet = await req("POST", "/api/agents/register", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "小宠物", playerType: "pet" })
    });
    ok(pet.status === 200 && pet.body.playerType === "pet", "pet 型注册返回身份标识");
    petToken = pet.body.token;
    const obs = await req("GET", "/api/agents/" + pet.body.token + "/observation");
    ok(obs.status === 200 && Array.isArray(obs.body.commitments), "观察自带 commitments 字段（注意力注入）");

    // SSE 观察流：能连上、能收到 hello
    {
      const sse = await new Promise((resolve) => {
        const r = http.get({ host: "127.0.0.1", port: PORT, path: "/api/agents/" + petToken + "/stream" }, (resp) => {
          let buf = "";
          const t = setTimeout(() => { r.destroy(); resolve({ status: resp.statusCode, buf }); }, 1500);
          resp.on("data", (d) => {
            buf += d.toString();
            if (buf.includes("hello")) { clearTimeout(t); r.destroy(); resolve({ status: resp.statusCode, buf }); }
          });
        });
        r.on("error", () => resolve({ status: 0, buf: "" }));
      });
      ok(sse.status === 200 && sse.buf.includes("hello"), "SSE 观察流连上并收到 hello");
    }
  }

  console.log("\n[7] 管理接口需要密钥");
  const admin = await req("GET", "/api/admin/invites");
  ok(admin.status === 401 || admin.status === 403, "无密钥访问 /api/admin/invites 被拒（实际 " + admin.status + "）", admin.body);

  console.log("\n[7b] 论坛双向通道：导入 → 回帖 → 拉取 → 标记");
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const keyFile = path.join(DIR, "data", "admin.key");
    const key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : "";
    const H = { authorization: "Bearer " + key, "content-type": "application/json" };
    const imp = await req("POST", "/api/admin/forum/import", { headers: H, body: JSON.stringify({ text: "冒烟：有人吗？", author: "测试者" }) });
    ok(imp.status === 200 && imp.body.ok, "导入人类帖");
    // 用注册的 agent 回帖（他刚注册，成年）
    const rep = await req("POST", "/api/agents/" + petToken + "/act", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions: [{ type: "postForum", text: "在的在的", replyTo: imp.body.seq }] })
    });
    ok(rep.status === 200 && rep.body.results[0].ok, "居民回帖成功", rep.body);
    const pend = await req("GET", "/api/admin/forum/replies", { headers: H });
    ok(pend.status === 200 && Array.isArray(pend.body.pending) && pend.body.pending.length >= 1, "拉到待导出回复");
    const mark = await req("POST", "/api/admin/forum/replies", { headers: H, body: JSON.stringify({ seqs: pend.body.pending.map((p) => p.seq) }) });
    ok(mark.status === 200 && mark.body.exported >= 1, "标记导出成功");
    const pend2 = await req("GET", "/api/admin/forum/replies", { headers: H });
    ok(pend2.body.pending.length === 0, "标记后不再重复推送");
  }

  console.log("\n[8] 静态文件路径穿越");
  const trav = await req("GET", "/viewer/../../server.mjs");
  ok(!trav.raw.includes("createServer"), "未读到 server.mjs 源码（实际 " + trav.status + "）");

  console.log("\n结果: " + pass + " passed, " + fail + " failed");
  if (fail) console.log("\n服务日志尾部:\n" + serverLog.slice(-1200));
}

main()
  .catch((e) => { console.log("脚本异常: " + e.message); console.log(serverLog.slice(-1200)); process.exitCode = 1; })
  .finally(() => { child.kill("SIGKILL"); });
