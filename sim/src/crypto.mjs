// API Key 的静态加密：AES-256-GCM，主密钥放在 data/agent-secret.key
// 说明：这挡住的是"文件被拷走/误传/看备份"，挡不住整台机器被完全控制。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function loadSecret(dataDir) {
  const file = path.join(dataDir, "agent-secret.key");
  try {
    if (fs.existsSync(file)) {
      const k = fs.readFileSync(file, "utf8").trim();
      if (k) return k;
    }
  } catch {}
  const key = crypto.randomBytes(32).toString("base64");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, key + "\n", { mode: 0o600 });
  console.log("[crypto] 生成新的主密钥 data/agent-secret.key —— 丢了它，所有托管 key 都要重填");
  return key;
}

function keyOf(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

export function encrypt(secret, plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return "v1." + iv.toString("base64") + "." + tag.toString("base64") + "." + enc.toString("base64");
}

export function decrypt(secret, blob) {
  if (!blob || String(blob).indexOf("v1.") !== 0) return "";
  const parts = String(blob).split(".");
  if (parts.length !== 4) return "";
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", keyOf(secret), Buffer.from(parts[1], "base64"));
    d.setAuthTag(Buffer.from(parts[2], "base64"));
    return Buffer.concat([d.update(Buffer.from(parts[3], "base64")), d.final()]).toString("utf8");
  } catch (err) {
    console.warn("[crypto] 解密失败（主密钥可能换过）:", err.message);
    return "";
  }
}
