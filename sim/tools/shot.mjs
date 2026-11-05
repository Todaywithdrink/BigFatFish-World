import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = process.env.EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] || "http://127.0.0.1:8080/";
const OUT = process.argv[3] || "shot.png";
const WAIT = Number(process.argv[4] || 4500);
const EVAL = process.argv[5] || "";
const WIN_W = process.argv[6] || "1440";
const WIN_H = process.argv[7] || "900";
const PORT = 9333;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edgeshot-"));
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  "--window-size=" + WIN_W + "," + WIN_H,
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + tmp,
  URL_TO_OPEN
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

try {
  const page = await waitForTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await cdp(ws, "Page.enable");
  await cdp(ws, "Runtime.enable");
  if (EVAL) {
    await cdp(ws, "Runtime.evaluate", { expression: EVAL, awaitPromise: true });
    await cdp(ws, "Page.reload", { ignoreCache: true });
  }
  await sleep(WAIT);                     // 让 SSE 跑几帧、村民走两步
  const shot = await cdp(ws, "Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log("saved " + OUT + " (" + fs.statSync(OUT).size + " bytes)");
  ws.close();
} catch (err) {
  console.error("FAILED: " + err.message);
  process.exitCode = 1;
} finally {
  proc.kill();
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit();
}