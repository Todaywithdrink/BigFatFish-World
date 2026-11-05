// 邀请码管理（管理员用）
//   node tools/invite.mjs new "给张三" [次数] [有效小时]
//   node tools/invite.mjs list
//   node tools/invite.mjs revoke DFY-XXXX
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SERVER || "http://127.0.0.1:8090";
const keyFile = path.join(HERE, "..", "data", "admin.key");

let key = process.env.ADMIN_TOKEN || "";
if (!key) {
  try { key = fs.readFileSync(keyFile, "utf8").trim(); } catch {}
}
if (!key) {
  console.error("找不到管理密钥：data/admin.key 不存在，也没有 ADMIN_TOKEN 环境变量。");
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const headers = { authorization: "Bearer " + key, "content-type": "application/json" };

async function main() {
  if (cmd === "new" || !cmd) {
    const label = rest[0] || "";
    const maxUses = Number(rest[1] || 1);
    const hours = Number(rest[2] || 0);
    const res = await fetch(BASE + "/api/admin/invites", {
      method: "POST", headers,
      body: JSON.stringify({ label, maxUses, hours })
    });
    const d = await res.json();
    if (!res.ok) return console.error("失败:", d.error || res.status);
    console.log("邀请码：", d.code);
    console.log("  用途：", d.label || "（未命名）", "· 可用", d.maxUses, "次",
      d.expiresAt ? "· " + new Date(d.expiresAt).toLocaleString() + " 过期" : "· 不过期");
  } else if (cmd === "list") {
    const res = await fetch(BASE + "/api/admin/invites", { headers });
    const list = await res.json();
    if (!res.ok) return console.error("失败:", list.error || res.status);
    if (!list.length) return console.log("（还没有邀请码）");
    for (const c of list) {
      console.log(c.code.padEnd(14), (c.label || "-").padEnd(12),
        c.uses + "/" + c.maxUses,
        c.disabled ? "已停用" : (c.expiresAt && Date.now() > c.expiresAt ? "已过期" : "有效"));
    }
  } else if (cmd === "revoke") {
    const code = (rest[0] || "").toUpperCase();
    const res = await fetch(BASE + "/api/admin/invites/" + code + "/revoke", { method: "POST", headers });
    const d = await res.json();
    console.log(res.ok ? "已停用 " + d.code : "失败: " + (d.error || res.status));
  } else {
    console.log("用法：node tools/invite.mjs new \"给谁用\" [次数] [有效小时] | list | revoke <码>");
  }
}
main().catch((e) => console.error(e.message));
