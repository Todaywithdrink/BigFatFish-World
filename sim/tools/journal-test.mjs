// 回放的端到端验证：起一个真服务 → 让它自己跑一会儿 → 导出黑匣子 → 离线重跑 → 比对。
//
// 必须在临时副本里跑（SIM_DIR 指向拷贝），绝不能在正在用的世界上做实验。
//
//   SIM_DIR=/tmp/simcopy node tools/journal-test.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = process.env.SIM_DIR || process.cwd();
const PORT = Number(process.env.PORT || 8095);
const BASE = "http://127.0.0.1:" + PORT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + "/api/health");
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error("服务没能在 " + timeoutMs + "ms 内起来");
}

const api = async (p, opts = {}) => {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (extra ? "  " + extra : "")); }
};

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: DIR,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    BRAINS: "0",             // 只测"动作 → 世界"，别让 LLM 搅进来
    INVITE_REQUIRED: "0",
    JOURNAL: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));

const cleanup = () => { try { child.kill(); } catch { /* 已退出 */ } };
process.on("exit", cleanup);

try {
  console.log("启动世界服务（临时副本）…");
  const health = await waitHealth();
  ok(health && health.ok, "服务起来了");

  console.log("\n[1] 造点历史");
  const reg = await api("/api/agents/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "回放测试" })
  });
  ok(reg.status === 200 && reg.body.token, "注册拿到 token", "status=" + reg.status);
  const token = reg.body.token;

  const acts = [
    { type: "move", dir: "s", tiles: 3 },
    { type: "move", dir: "e", tiles: 2 },
    { type: "forage" },
    { type: "say", text: "今天的风是往哪边吹的？" },
    { type: "move", dir: "n", tiles: 2 },
    { type: "sew", hue: 120, pattern: 2 }
  ];
  let applied = 0;
  for (const act of acts) {
    const r = await api("/api/agents/" + token + "/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions: [act] })
    });
    if (r.status === 200) applied++;
    await sleep(450);   // 让冷却过去，动作才落得下
  }
  ok(applied >= 4, "动作至少落下去 4 条（实际 " + applied + "）");

  // 让世界自己再跑一会儿（生理、感知、遗忘都在 step 里）
  await sleep(2500);

  console.log("\n[2] 导出黑匣子");
  const key = fs.readFileSync(path.join(DIR, "data", "admin.key"), "utf8").trim();
  const jr = await api("/api/admin/journal", { headers: { authorization: "Bearer " + key } });
  ok(jr.status === 200 && jr.body.enabled, "拿到流水", "status=" + jr.status);
  ok(Array.isArray(jr.body.actions) && jr.body.actions.length > 0, "流水非空（" + (jr.body.actions || []).length + " 条）");
  ok(!!jr.body.start && !!jr.body.start.state, "带开局快照");
  ok(typeof jr.body.hash === "string" && jr.body.hash.length === 16, "带终点指纹");

  const jf = path.join(os.tmpdir(), "journal-" + Date.now() + ".json");
  fs.writeFileSync(jf, JSON.stringify(jr.body));
  console.log("  写入 " + jf + " (" + Math.round(fs.statSync(jf).size / 1024) + " KB)");

  cleanup();
  await sleep(300);

  console.log("\n[3] 离线重跑");
  const rep = spawn(process.execPath, ["tools/replay.mjs", jf], {
    cwd: DIR, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  rep.stdout.on("data", (d) => (out += d));
  rep.stderr.on("data", (d) => (out += d));
  const code = await new Promise((r) => rep.on("close", r));
  console.log(out.split("\n").filter(Boolean).map((l) => "  " + l).join("\n"));

  ok(code === 0, "回放与当时逐字段一致");
} catch (err) {
  fail++;
  console.log("  ✗ 异常：" + err.message);
  console.log("\n--- 服务日志 ---\n" + serverLog.split("\n").slice(-25).join("\n"));
} finally {
  cleanup();
}

console.log("\n" + pass + " passed / " + fail + " failed");
process.exit(fail ? 1 : 0);
