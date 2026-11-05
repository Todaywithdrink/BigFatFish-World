// Pixi 观测器验收工具（可重复执行，幂等）：读取 window.__pixiDebug() 指标并截图
// 用法：node sim/tools/verify-pixi.mjs [url] [outPng] [waitMs]
//   例：node sim/tools/verify-pixi.mjs "http://127.0.0.1:8090/viewer/pixi.html?hour=22" docs/review-2026-11-05/night.png
// 依赖：本机 Edge（可用 EDGE 环境变量指定路径）+ 目标站点已启动
// 输出：SAMPLE_A / SAMPLE_B 两帧指标（相隔 120ms，用于确认插值在跑、FPS 稳定），随后截图
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = process.env.EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] || "http://127.0.0.1:8090/viewer/pixi.html";
const OUT = process.argv[3] || path.join(os.tmpdir(), "pixi-shot.png");
const WAIT = Number(process.argv[4] || 7000);
const HOOK = process.env.HOOK || "__pixiDebug";
const PORT = 9335;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pixiverify-"));
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,900",
  "--remote-debugging-port=" + PORT, "--user-data-dir=" + tmp, URL_TO_OPEN
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
      const list = await res.json();
      const page = list.find((t) => t.type === "page" && t.url.startsWith("http"));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("no debuggable page");
}

let id = 0;
function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    const onMsg = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id === msgId) {
        ws.removeEventListener("message", onMsg);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function readDebug(ws) {
  const r = await cdp(ws, "Runtime.evaluate", {
    expression: `JSON.stringify(window.${HOOK} ? window.${HOOK}() : {err:"no hook ${HOOK}", hud: document.getElementById("hud")?.textContent})`,
    returnByValue: true
  });
  return r.result.value;
}

try {
  const page = await waitForTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await cdp(ws, "Page.enable");
  await cdp(ws, "Runtime.enable");
  await sleep(WAIT);

  console.log("SAMPLE_A " + (await readDebug(ws)));
  await sleep(120);
  console.log("SAMPLE_B " + (await readDebug(ws)));

  const shot = await cdp(ws, "Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log("saved " + OUT);
  ws.close();
} catch (err) {
  console.error("FAILED: " + err.message);
  process.exitCode = 1;
} finally {
  proc.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit();
}
