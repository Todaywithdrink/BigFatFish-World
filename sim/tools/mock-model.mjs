// 假的 OpenAI 兼容服务，用来测试"托管模式"链路（不占本机 GPU）
import http from "node:http";
let n = 0;
http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  n++;
  const body = {
    id: "mock-" + n,
    choices: [{ message: { role: "assistant", content: JSON.stringify({ actions: [{ type: "step", dir: "e" }] }) } }],
    usage: { total_tokens: 1 }
  };
  const out = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(out) });
  res.end(out);
}).listen(8899, "127.0.0.1", () => console.log("mock model on 8899"));
