// 网络边界的统一守卫：入站 body 限长、出站 URL 白名单、CORS 判定。
// 所有"外部可影响"的 URL / 请求体都必须过这里，避免校验散落在各处。
import net from "node:net";

export const MAX_JSON_BODY = Number(process.env.AVB_MAX_BODY || 256 * 1024);

// 允许的模型端点（可用 AVB_ALLOWED_MODEL_HOSTS 追加，逗号分隔）
const DEFAULT_MODEL_HOSTS = [
  "api.openai.com",
  "api.deepseek.com",
  "openrouter.ai",
  "api.anthropic.com",
  "dashscope.aliyuncs.com",
  "api.moonshot.cn",
  "open.bigmodel.cn"
];

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./
];

function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (/\.(internal|local|localhost)$/.test(h)) return true;
  if (net.isIP(h) === 4) return PRIVATE_V4.some((re) => re.test(h));
  if (net.isIP(h) === 6) return true; // 简化：v6 一律按私网对待，除非显式白名单
  return false;
}

/**
 * 校验「用户提交的模型端点」。
 * @returns {string|null} 不通过时返回原因代码，通过返回 null
 */
export function checkModelBaseUrl(raw, { allowHosts = [], allowPrivate = false, allowLoopback = false } = {}) {
  if (typeof raw !== "string" || !raw.trim()) return "empty";
  if (raw.length > 300) return "too_long";
  let u;
  try { u = new URL(raw); } catch { return "bad_url"; }
  if (u.username || u.password) return "credentials_in_url";
  if (u.protocol !== "https:" && u.protocol !== "http:") return "bad_scheme";
  if (u.protocol === "http:" && !allowPrivate && !allowLoopback) return "https_required";

  const host = u.hostname.toLowerCase();
  // 本地算力：回环地址 + 显式开关 → 放行（没钱的玩家用自己电脑的 GPU 玩）
  if (allowLoopback && isLoopbackHost(host)) return null;

  const extra = allowHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  const defaultAllowed = DEFAULT_MODEL_HOSTS.includes(host) || DEFAULT_MODEL_HOSTS.some((d) => host.endsWith("." + d));
  // 管理员显式放行的域名：允许私网（自建模型端点走这条路，且只对显式白名单生效）
  if (extra.includes(host)) return null;
  if (defaultAllowed) return null;
  if (isPrivateHost(host)) return "private_host";

  return "host_not_allowed";
}

export function allowedModelHosts() {
  const raw = process.env.AVB_ALLOWED_MODEL_HOSTS || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function allowPrivateModel() {
  return process.env.AVB_ALLOW_PRIVATE_MODEL === "1";
}

// 本地算力通道：只放行回环地址（localhost / 127.x / ::1），
// Ollama / LM Studio / vLLM 等本机 OpenAI 兼容端点走这条，比私网开关更窄。
export function allowLocalModel() {
  return allowPrivateModel() || process.env.AVB_ALLOW_LOCAL_LLM === "1";
}

function isLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** 只把状态码这样的"安全信息"回给调用方；上游响应体只进伺服端日志。 */
export function publicUpstreamError(status) {
  return "upstream " + (status || "error");
}

/** 读 JSON 请求体，带硬上限。超限返回 { tooLarge: true }，由调用方回 413 并排空连接。 */
export function readJsonBody(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    req.on("data", (c) => {
      if (done) return;                 // 已经定案（超限/超时）就不再往内存里堆
      size += c.length;
      if (size > limit) {
        // 不在这里 destroy：先让调用方把 413 发出去，否则客户端只看到 socket hang up
        finish({ tooLarge: true, value: {} });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return finish({ value: {} });
      try { finish({ value: JSON.parse(raw) }); }
      catch { finish({ value: null, badJson: true }); }
    });
    req.on("error", () => finish({ value: null, badJson: true }));
  });
}

/**
 * CORS：默认只回显"自己人"的 Origin；不匹配就不发头（浏览器自然拦）。
 * AVB_CORS="*" 时才放开（明确知道自己在做什么的人才会开）。
 */
export function makeCorsChecker(port, extraOrigins = []) {
  const open = process.env.AVB_CORS === "*";
  const defaults = [
    "http://127.0.0.1:" + port,
    "http://localhost:" + port,
    "http://[::1]:" + port
  ];
  const allow = new Set([...defaults, ...extraOrigins]);
  return function corsFor(req) {
    const origin = req.headers.origin;
    if (!origin) return null;            // 同源/非浏览器请求，不需要头
    if (open) return "*";
    return allow.has(origin) ? origin : null;
  };
}

export function envOrigins() {
  return (process.env.AVB_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

/** Origin 主机是否属于本机（给 bridge 用，它没有端口白名单的语境） */
export function isLoopbackOrigin(origin) {
  if (!origin) return true;              // 非浏览器
  try {
    const u = new URL(origin);
    const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch { return false; }
}
