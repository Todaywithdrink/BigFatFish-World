import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDGE = process.env.EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL_TO_OPEN = process.argv[2] || "http://127.0.0.1:8090/";
const EXPR = process.argv[3] || "1";
const WAIT = Number(process.argv[4] || 5000);
const PORT = 9334;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edgeval-"));
spawn(EDGE, ["--headless=new", "--disable-gpu", "--window-size=1440,900",
  "--remote-debugging-port=" + PORT, "--user-data-dir=" + tmp, URL_TO_OPEN], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id = 0;
function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const on = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id === mid) {
        ws.removeEventListener("message", on);
        d.error ? reject(new Error(d.error.message)) : resolve(d.result);
      }
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
try {
  let page = null;
  for (let i = 0; i < 40 && !page; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json();
      page = list.find((t) => t.type === "page" && t.url.startsWith("http"));
    } catch {}
    if (!page) await sleep(250);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await cdp(ws, "Runtime.enable");
  await sleep(WAIT);
  const r = await cdp(ws, "Runtime.evaluate", { expression: EXPR, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result && r.result.value, null, 1));
  ws.close();
  process.exit(0);
} catch (e) {
  console.error("ERR", e.message);
  process.exit(1);
}
