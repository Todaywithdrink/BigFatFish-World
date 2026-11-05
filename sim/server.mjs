// 世界服务器：tick + HTTP API + SSE 直播流 + 静态观看端
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GameMap } from "./src/map.mjs";
import { loadTiled } from "./src/tiledmap.mjs";
import { World, CFG, pub, pubFor, redactEvent } from "./src/world.mjs";
import { worldHash } from "./src/fingerprint.mjs";
import { randomUUID, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { attachBrains } from "./agents/brain.mjs";
import { dumpMind } from "./agents/autonomy.mjs";
import { createHostedRunner } from "./agents/hosted.mjs";
import { loadSecret, encrypt, decrypt } from "./src/crypto.mjs";
import { serializeWorld, loadSave, writeSaveFile, readSaveFile } from "./src/persist.mjs";
import { VILLAGERS, defaultVillagerCount, spawnCast } from "./src/cast.mjs";
import { checkModelBaseUrl, allowedModelHosts, allowPrivateModel, allowLocalModel,
  readJsonBody, MAX_JSON_BODY, makeCorsChecker, envOrigins } from "./src/netguard.mjs";
import { isMinor, stageOf } from "./src/lifecycle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);
// 默认只听回环：要对外必须先明确 HOST=0.0.0.0，并在前面加 TLS 反代
const HOST = process.env.HOST || "127.0.0.1";
const AGENT_TTL_MS = Number(process.env.AGENT_TTL_DAYS || 90) * 86400000;
// 托管 agent 由服务器代跑，只要还在成功行动就不算闲置；长期失败/没人管就回收
const AGENT_IDLE_MS = Number(process.env.AGENT_IDLE_DAYS || 3) * 86400000;
const ENABLE_BRAINS = process.env.BRAINS !== "0";

const MAP_FILE = path.join(HERE, "data", "world-map.json");
const TILED_FILE = path.join(HERE, "maps", "village.tmj");
const map = fs.existsSync(TILED_FILE)
  ? new GameMap(loadTiled(TILED_FILE))
  : fs.existsSync(MAP_FILE)
    ? GameMap.load(MAP_FILE)
    : GameMap.load(path.join(HERE, "data", "village.json"));
const WORLD_SEED = Number(process.env.WORLD_SEED || 1);
// hearth：正式世界在广场边生成一口公共灶台（世界生成，不掷骰）
const world = new World(map, { seed: WORLD_SEED, hearth: true });



// 本地只放少数几条做测试；正式环境由外部 AI 注册接管
const VILLAGER_COUNT = defaultVillagerCount(process.env.VILLAGERS);

function spawnDefaultVillagers() {
  return spawnCast(world, map, VILLAGER_COUNT);
}

// ---------- 存档 ----------
const DATA_DIR = path.join(HERE, "data");
const SECRET = loadSecret(DATA_DIR);

// ---------- 邀请制 + 限流 ----------
const INVITE_REQUIRED = process.env.INVITE_REQUIRED !== "0";
const INVITES_FILE = path.join(DATA_DIR, "invites.json");
const ADMIN_KEY_FILE = path.join(DATA_DIR, "admin.key");

function loadAdminKey() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  try {
    if (fs.existsSync(ADMIN_KEY_FILE)) {
      const k = fs.readFileSync(ADMIN_KEY_FILE, "utf8").trim();
      if (k) return k;
    }
  } catch {}
  const k = randomBytes(24).toString("hex");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_KEY_FILE, k + "\n", { mode: 0o600 });
  console.log("[admin] 生成管理密钥 data/admin.key（用它发邀请码）");
  return k;
}
const ADMIN_KEY = loadAdminKey();

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

let invites = { version: 1, codes: [] };
try {
  if (fs.existsSync(INVITES_FILE)) invites = JSON.parse(fs.readFileSync(INVITES_FILE, "utf8"));
} catch (err) {
  console.warn("[invite] 读取失败:", err.message);
}

function saveInvites() {
  try {
    fs.writeFileSync(INVITES_FILE, JSON.stringify(invites, null, 1));
  } catch (err) {
    console.warn("[invite] 保存失败:", err.message);
  }
}

function newCode() {
  return "DFY-" + randomBytes(4).toString("hex").toUpperCase();
}

function createInvite({ label = "", maxUses = 1, hours = 0 } = {}) {
  const rec = {
    code: newCode(),
    label: String(label || "").slice(0, 40),
    maxUses: Math.max(1, Math.min(100, Number(maxUses) || 1)),
    uses: 0,
    createdAt: Date.now(),
    expiresAt: hours > 0 ? Date.now() + hours * 3600 * 1000 : 0,
    disabled: false
  };
  invites.codes.push(rec);
  saveInvites();
  return rec;
}

function consumeInvite(code) {
  const rec = invites.codes.find((c) => c.code === String(code || "").trim().toUpperCase());
  if (!rec || rec.disabled) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) return null;
  if (rec.uses >= rec.maxUses) return null;
  rec.uses++;
  saveInvites();
  return rec;
}

// 简单的令牌桶：每个 IP 每分钟 N 次
const buckets = new Map();
function allow(ip, perMinute, burst) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: burst, last: now }; buckets.set(ip, b); }
  b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 60000) * perMinute);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// 注册：每 IP 每 10 分钟 5 次，全服每小时 30 条
const regPerIp = new Map();
function allowRegister(ip) {
  const now = Date.now();
  const win = 10 * 60 * 1000;
  const rec = regPerIp.get(ip) || { n: 0, reset: now + win };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + win; }
  if (rec.n >= 10) return false;
  rec.n++;
  regPerIp.set(ip, rec);
  return true;
}
let globalReg = { n: 0, reset: Date.now() + 3600 * 1000 };
function allowGlobalRegister() {
  const now = Date.now();
  if (now > globalReg.reset) globalReg = { n: 0, reset: now + 3600 * 1000 };
  if (globalReg.n >= 30) return false;
  globalReg.n++;
  return true;
}
const STATE_FILE = path.join(HERE, "data", "world-state.json");
const AGENTS_FILE = path.join(HERE, "data", "agents.json");
const MINDS_FILE = path.join(HERE, "data", "minds.json");
const SAVE_EVERY_TICKS = 100;   // 10 秒


// 渐进开放（大纲修订 2026-11）：世界形貌预先定死（outline.mjs），但只显现一部分。
// 居民真的走到开放区边缘，才把下一块"按图施工"出来——东到海、南到山为止。
let lastExpandTick = -1000;
function maybeExpand() {
  if (world.tickCount - lastExpandTick < 600) return;  // 60 秒内不重复长
  const margin = 8;
  for (const v of world.entities.values()) {
    if (v.state === "dead") continue;
    let side = null;
    if (v.x > map.width - margin) side = "e";
    else if (v.y > map.height - margin) side = "s";
    if (!side) continue;
    const g = world.mutate({ kind: "grow", side });
    if (!g.ok) continue;   // 大陆尽头：这个方向不再长，试下一个居民/方向
    lastExpandTick = world.tickCount;
    saveMap();
    broadcast({ type: "mapnew", map: map.toJSON() });
    console.log("[map] " + v.name + " 走到了世界边缘，" + (g.theme || side) + "区域显现（" + map.width + "×" + map.height + (g.edge ? "，这里是大陆尽头" : "") + "）");
    break;
  }
}

function saveMap() {
  try {
    fs.writeFileSync(MAP_FILE, JSON.stringify(map.toJSON()));
    if (fs.existsSync(TILED_FILE)) saveTiledFromMap(map, TILED_FILE);
  } catch (err) {
    console.warn("[map] 保存失败:", err.message);
  }
}

// 把运行时地图写回 Tiled（tmj 始终是唯一地图源，运行时的建造/扩张不会丢）
function saveTiledFromMap(m, file) {
  const W = m.width, H = m.height;
  const G = { grass: 1, tuft: 2, grass2: 3, water_a: 5, water_b: 6, dirt: 7, path0: 17 };
  const K = { wall: 13, floor: 15, door: 16, bench: 21, barrel: 22, stall: 23, rock: 12, fence: 10, lamp: 19, bed: -1, stove: -1, board: -1, crate: -1, stump: -1 };
  const O = { tree: 38, tree2: 40, tree3: 41 };
  const ground = new Array(W * H).fill(0);
  const objects = new Array(W * H).fill(0);
  const h2 = (x, y) => {
    let h = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const kindAt = (x, y) => {
    const t = m.tile(x, y);
    return t ? t.kind : "grass";
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = kindAt(x, y), i = y * W + x;
      if (k === "water") ground[i] = ((Math.floor((x + y) / 7) % 2) ? G.water_b : G.water_a);
      else if (k === "sand") ground[i] = G.dirt;
      else if (k === "path") {
        let mm = 0;
        if (kindAt(x, y - 1) !== "path") mm |= 1;
        if (kindAt(x + 1, y) !== "path") mm |= 2;
        if (kindAt(x, y + 1) !== "path") mm |= 4;
        if (kindAt(x - 1, y) !== "path") mm |= 8;
        ground[i] = G.path0 + mm;
      } else if (k === "wall" || k === "floor" || k === "door") ground[i] = 33 + K[k];
      else ground[i] = (h2(x, y) < 0.18 ? G.tuft : h2(x, y) < 0.26 ? G.grass2 : G.grass);
      if (k === "tree") { const n = h2(x + 7, y + 3); objects[i] = n < 0.5 ? O.tree : n < 0.8 ? O.tree2 : O.tree3; }
      else if (k === "rock") objects[i] = 33 + K.rock;
      else if (k === "fence") objects[i] = 33 + K.fence;
    }
  }
  const tmj = {
    type: "map", version: "1.10", tiledversion: "1.11.0", orientation: "orthogonal",
    renderorder: "right-down", width: W, height: H, tilewidth: 16, tileheight: 16,
    infinite: false, nextlayerid: 3, nextobjectid: 1,
    tilesets: [
      { firstgid: 1, name: "tiles2", image: "tiles2.png", imagewidth: 128, imageheight: 64, tilewidth: 16, tileheight: 16, columns: 8, tilecount: 32, margin: 0, spacing: 0 },
      { firstgid: 33, name: "tiles", image: "tiles.png", imagewidth: 128, imageheight: 80, tilewidth: 16, tileheight: 16, columns: 8, tilecount: 40, margin: 0, spacing: 0 }
    ],
    layers: [
      { id: 1, name: "ground", type: "tilelayer", width: W, height: H, x: 0, y: 0, visible: true, opacity: 1, data: ground },
      { id: 2, name: "objects", type: "tilelayer", width: W, height: H, x: 0, y: 0, visible: true, opacity: 1, data: objects }
    ]
  };
  fs.writeFileSync(file, JSON.stringify(tmj));
}
function saveWorld() {
  try {
    writeSaveFile(world, STATE_FILE);
  } catch (err) {
    console.warn("[save] 失败:", err.message);
  }
}

function loadWorld() {
  try {
    const data = readSaveFile(STATE_FILE);
    if (!data) return false;
    return loadSave(world, data);
  } catch (err) {
    console.warn("[load] 失败:", err.message);
    return false;
  }
}

// ---------- 外部 AI 接入 ----------
const agents = new Map();      // sha256(token) -> {villagerId, name, lastAct, since}
const AGENT_COOLDOWN_TICKS = 4; // 400ms
const hashToken = (t) => createHash("sha256").update(String(t)).digest("hex").slice(0, 32);

function saveAgents() {
  try {
    fs.writeFileSync(AGENTS_FILE, JSON.stringify({
      version: 1,
      agents: [...agents.entries()].map(([key, a]) => ({
        key, villagerId: a.villagerId, name: a.name, since: a.since,
        mode: a.mode || "client", persona: a.persona || "", publicView: a.publicView !== false,
        playerType: a.playerType === "pet" ? "pet" : "player",
        rebirths: a.rebirths || 0,
        schedule: a.schedule || { all: true },
        model: a.model ? {
          baseUrl: a.model.baseUrl, model: a.model.model, apiKeyEnc: a.model.apiKeyEnc,
          temperature: a.model.temperature, maxTokens: a.model.maxTokens
        } : null
      }))
    }));
  } catch (err) {
    console.warn("[save] agents 失败:", err.message);
  }
}

function loadAgents() {
  try {
    if (!fs.existsSync(AGENTS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
    for (const a of data.agents || []) {
      const v = world.entities.get(a.villagerId);
      if (!v) continue;
      v.external = true;
      let model = a.model || null;
      if (model) {
        if (!model.apiKeyEnc && model.apiKey) {
          model = { ...model, apiKeyEnc: encrypt(SECRET, model.apiKey) };   // 旧存档里的明文，顺手加密
          console.log("[crypto] 已把一条旧的明文 key 加密");
        }
        model = { ...model, apiKey: model.apiKeyEnc ? decrypt(SECRET, model.apiKeyEnc) : "" };
      }
      agents.set(a.key, {
        villagerId: a.villagerId, name: a.name, mode: a.mode || "client",
        playerType: a.playerType === "pet" ? "pet" : "player",
        rebirths: a.rebirths || 0,
        persona: a.persona || "", schedule: a.schedule || { all: true }, model, publicView: a.publicView !== false,
        lastAct: world.tickCount, since: a.since
      });
    }
    console.log("[load] 恢复了 " + agents.size + " 个 AI 接入");
  } catch (err) {
    console.warn("[load] agents 失败:", err.message);
  }
}

// ---------- 启动 ----------
if (!fs.existsSync(MAP_FILE)) saveMap();

const restored = loadWorld();
if (!restored) {
  spawnDefaultVillagers();
  console.log("[world] 新世界，生成 " + VILLAGER_COUNT + " 条鱼");
}
loadAgents();

// 动作流水：只记"谁在哪一 tick 想做什么"，配合种子和开局快照就能整段重跑。
// 默认开着——它就是线上出问题时的黑匣子，事后想开就晚了。
const JOURNAL_LIMIT = Number(process.env.JOURNAL_LIMIT || 200000);
const JOURNAL_ON = process.env.JOURNAL !== "0";
if (JOURNAL_ON) world.startJournal(JOURNAL_LIMIT);
const journalStart = { tick: world.tickCount, map: world.map.toJSON(), state: serializeWorld(world) };

// 11x11 的局部地形：看得见的给符号，被挡住的给 ?
// . 可走   # 挡路   D 关着的门   d 开着的门   ~ 水   ? 看不见
function tileView(world, v, r = 5) {
  const map = world.map;
  const cx = Math.floor(v.x), cy = Math.floor(v.y);
  const rows = [];
  for (let dy = -r; dy <= r; dy++) {
    let line = "";
    for (let dx = -r; dx <= r; dx++) {
      const t = map.tile(cx + dx, cy + dy);
      if (!t) { line += "?"; continue; }
      if (dx === 0 && dy === 0) { line += "@"; continue; }
      if (map.lineBlocked(v.x, v.y, cx + dx + 0.5, cy + dy + 0.5)) { line += "?"; continue; }
      if (t.kind === "door") line += t.walkable ? "d" : "D";
      else if (t.kind === "water") line += "~";
      else if (!t.walkable) line += "#";
      else line += ".";
    }
    rows.push(line);
  }
  return rows;
}

function observe(world, v) {
  const seen = [];
  for (const o of world.entities.values()) {
    if (o === v) continue;
    if (!world.canSee(v, o)) continue;
    const p = pubFor(o, v);
    p.uid = world.maskUid(v, o);
    p.acquaintance = world.pairs.get(world.pairKey(v.id, o.id)) || 0;
    seen.push(p);
  }
  const events = v.inbox.splice(0, v.inbox.length);
  return {
    tick: world.tickCount,
    clock: { ...world.clock, hour: world.hour },
    self: {
      ...pubFor(v, v),
      skills: Object.fromEntries(Object.entries(v.skills).map(([k, s]) => [k, s.level])),
      knownRecipes: v.knownRecipes.slice()
    },
    exploredCount: v.explored.size,
    // 注意力机制：未了结的约定每次观察都在眼前——忘了不是借口，违约是自由
    commitments: world.commitmentsFor(v),
    view: {
      entities: seen,
      atBoard: !!world.boardNear(v, 4),
      protocols: [...world.protocols.values()].filter((p) => p.state === "open").map((p) => ({
        id: p.id, host: p.hostName, rules: world.rulesOf(p),
        highest: p.bids.length ? p.bids[p.bids.length - 1].price : null,
        secondsLeft: Math.max(0, Math.round((p.deadline - world.tickCount) / 10))
      })),
      board: world.boardNear(v, 4) ? world.board.slice(-8) : [],
      tileRadius: 5,
      tiles: tileView(world, v),
      legend: { ".": "可走", "#": "挡路", "D": "关着的门", "d": "开着的门", "~": "水", "?": "看不见", "@": "你自己" }
    },
    events,
    actions: CAPABILITIES.map((c) => c.id)
  };
}

function parseSchedule(sch) {
  if (!sch || sch === "24h") return { all: true };
  const m = String(sch).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return { all: true };
  return { all: false, from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]) };
}

// 内存里保留明文给 runner 用，落盘写密文
function sealModel(m) {
  if (!m) return null;
  return {
    baseUrl: m.baseUrl,
    model: m.model,
    apiKey: m.apiKey || "",
    apiKeyEnc: encrypt(SECRET, m.apiKey || ""),
    temperature: Number(m.temperature ?? 0.9),
    maxTokens: Number(m.maxTokens ?? 200)
  };
}

function sanitizeModel(m) {
  if (!m || typeof m !== "object") return null;
  if (!m.baseUrl || !m.model) return null;
  // 端点必须过白名单：防止把服务器当成对内网/云元数据的探针
  if (checkModelBaseUrl(String(m.baseUrl), { allowHosts: allowedModelHosts(), allowPrivate: allowPrivateModel(), allowLoopback: allowLocalModel() })) return null;
  return {
    baseUrl: String(m.baseUrl).slice(0, 300),
    model: String(m.model).slice(0, 80),
    apiKey: typeof m.apiKey === "string" ? m.apiKey.slice(0, 200) : "",
    temperature: Math.max(0, Math.min(2, Number(m.temperature) || 0.9)),
    maxTokens: Math.max(32, Math.min(2048, Number(m.maxTokens) || 200))
  };
}

function modelRejectReason(m) {
  if (!m || typeof m !== "object") return "missing";
  if (!m.baseUrl || !m.model) return "missing_baseUrl_or_model";
  return checkModelBaseUrl(String(m.baseUrl), { allowHosts: allowedModelHosts(), allowPrivate: allowPrivateModel(), allowLoopback: allowLocalModel() }) || null;
}

function maskAgent(a) {
  return {
    name: a.name, mode: a.mode || "client",
    playerType: a.playerType === "pet" ? "pet" : "player",
    rebirths: a.rebirths || 0,
    persona: a.persona || "",
    publicView: a.publicView !== false,
    schedule: a.schedule && !a.schedule.all ? a.schedule.from + "-" + a.schedule.to : "24h",
    model: a.model ? { baseUrl: a.model.baseUrl, model: a.model.model, hasKey: !!a.model.apiKey } : null
  };
}

// 有硬上限的 JSON 体读取；超限直接 413 并 resolve(null)，调用方必须判空
function readBody(req, res) {
  return readJsonBody(req, MAX_JSON_BODY).then((r) => {
    if (r.tooLarge) {
      if (!res.headersSent) {
        res.setHeader("connection", "close");
        json(res, 413, { error: "body_too_large", limit: MAX_JSON_BODY });
      }
      req.resume();   // 排空剩下的包，别让客户端死在写半路（RST）
      return null;
    }
    if (r.badJson) {
      if (!res.headersSent) json(res, 400, { error: "bad_json" });
      return null;
    }
    return r.value && typeof r.value === "object" ? r.value : {};
  });
}


// ---------- AI 能做什么：能力清单（也是权限边界） ----------
const CAPABILITIES = [
  { id: "move", level: 1, scope: "self", desc: "朝一个方向连续走 N 格", cost: 0,
    params: { dir: "n|s|e|w", tiles: "1..32" },
    limits: "一路走到底；被墙/水/关门/高差挡住就停在原地或半路（不报错，返回 moved 几格）" },
  { id: "sew", level: 2, scope: "self", desc: "用花布给自己做衣服（颜色自己定）", cost: 0,
    params: { hue: "0..360?", pattern: "0..3?", hat: "0..360?（额外 1 块布）" }, limits: "要 1 块花布；做出来立刻穿上" },
  { id: "chop", level: 2, scope: "adjacent", desc: "砍树（树干→树桩→挖掉）", cost: 0,
    params: { x: "int", y: "int" }, limits: "距离<=2；砍倒得木头 3，挖树桩再得 1" },
  { id: "fish", level: 2, scope: "adjacent", desc: "在水边钓鱼", cost: 0,
    params: {}, limits: "身边 2.2 格内要有水；2 秒冷却；按钓鱼等级决定上钩率" },
  { id: "forage", level: 2, scope: "adjacent", desc: "采集（树→木头，花→花）", cost: 0,
    params: {}, limits: "身边 2 格内要有树或花；2 秒冷却" },
  { id: "cook", level: 2, scope: "adjacent", desc: "在灶台做菜（消耗食材）", cost: 0,
    params: { recipe: "bread|stew" }, limits: "距离灶台 <= 1.9；食材不够会拒绝" },
  { id: "give", level: 2, scope: "adjacent", desc: "把东西白送人", cost: 0,
    params: { targetId: "entityId", item: "itemId", count: "1..99" }, limits: "距离 <= 2.5" },
  { id: "quote", level: 2, scope: "adjacent", desc: "双向报价：我卖（sell）或我买（buy）", cost: 0,
    params: { targetId: "entityId", side: "sell|buy", item: "itemId", count: "1..999", price: "0..1e9（无上限）", want: "{item,count}?（以物易物）", allowCredit: "boolean?" },
    limits: "距离 <= 3、看得见；卖要有货；allowCredit 时买家钱不够也成交，差额算欠款；60 秒过期" },
  { id: "bid", level: 2, scope: "adjacent", desc: "报价的别名：我想买 N 个，出价 P", cost: 0,
    params: { targetId: "entityId", item: "itemId", count: "number", price: "number" }, limits: "同 quote(side=buy)" },
  { id: "offer", level: 2, scope: "adjacent", desc: "报价的别名：我卖 N 个，要价 P", cost: 0,
    params: { targetId: "entityId", item: "itemId", count: "number", price: "number" }, limits: "同 quote(side=sell)" },
  { id: "accept", level: 2, scope: "self", desc: "接受报价（双向都能接）", cost: 0,
    params: { quoteId: "string" }, limits: "只能接给你的报价；钱不够会拒绝（除非对方开了赊账）" },
  { id: "decline", level: 2, scope: "self", desc: "拒绝报价", cost: 0,
    params: { quoteId: "string" }, limits: "" },
  { id: "publish", level: 4, scope: "global", desc: "发布一个玩法（目前：拍卖会）", cost: 0,
    params: { kind: "auction", item: "itemId", count: "1..99", price: "起拍价", seconds: "10..3600", public: "boolean?", to: "entityId?" },
    limits: "东西会先被托管走；可以公开发到留言板，也可以只发给某个人" },
  { id: "placeBid", level: 4, scope: "global", desc: "给拍卖出价", cost: 0,
    params: { protocolId: "string", price: "number" }, limits: "不能给自己拍；必须高于当前最高价" },
  { id: "closeAuction", level: 4, scope: "global", desc: "主持人提前收槌", cost: 0,
    params: { protocolId: "string" }, limits: "只有主持人能收" },
  { id: "readProtocols", level: 4, scope: "global", desc: "看看镇上在办什么活动", cost: 0,
    params: {}, limits: "返回公开的、以及发给你的" },
  { id: "post", level: 2, scope: "adjacent", desc: "在留言板上写字（可匿名）", cost: 0,
    params: { text: "string<=200", anonymous: "boolean?" }, limits: "要在留言板 3 格内" },
  { id: "readBoard", level: 2, scope: "adjacent", desc: "读最近的留言", cost: 0,
    params: {}, limits: "要在留言板 4 格内；返回最近 10 条" },
  { id: "craft", level: 2, scope: "self", desc: "制作物品（板材/面包/炖菜/花盆）", cost: 0,
    params: { recipe: "plank|bread|stew|flowerpot" },
    limits: "要食材；按大类累计熟练度，天赋放大；做失败材料就废了" },
  { id: "build", level: 3, scope: "adjacent", desc: "在身边的空地放东西（花/长椅/围栏/路灯/路/床/箱子，床要木头+木板）", cost: 0,
    params: { x: "int", y: "int", kind: "flower|bench|fence|lamp|path|bed|crate" }, limits: "距离<=2.2；只能建在草地/小路/花上；3 秒冷却" },
  { id: "remove", level: 3, scope: "adjacent", desc: "拆掉别人造的东西", cost: 0,
    params: { x: "int", y: "int" }, limits: "只能拆玩家/NPC 造出来的，不能拆原生地形" },
  { id: "shareMap", level: 1, scope: "adjacent", desc: "把你知道的区域告诉身边的人", cost: 0,
    params: { targetId: "entityId" }, limits: "距离 <= 3 格、必须看得见、10 秒冷却、一次最多 40 格" },
  { id: "face", level: 1, scope: "self", desc: "转向", cost: 0,
    params: { dir: "radians" }, limits: "只影响视野朝向" },
  { id: "say", level: 1, scope: "self", desc: "说话（可指定对象/私密）", cost: 0,
    params: { text: "string<=280", to: "entityId?", private: "boolean?" },
    limits: "6 格内可听；看不见的人只能听到'有人在说话'；私密时旁人拿不到内容；20 tick 内只能再说一次" },
  { id: "interact", level: 1, scope: "adjacent", desc: "开关身边的门/箱盖（旧入口，等价 open/close）", cost: 0,
    params: { x: "number", y: "number", credential: "{type,value}?" }, limits: "距离 <= 1.8 格；锁着时带正确凭证可一步解锁" },
  { id: "open", level: 1, scope: "adjacent", desc: "开门 / 掀箱盖（锁着时输入凭证一步解锁）", cost: 0,
    params: { id: "propId | x,y", credential: "{type:'code'|'key',value}?" }, limits: "门 <=1.8 格 / 箱 <=2.2 格；锁着必须给对凭证" },
  { id: "close", level: 1, scope: "adjacent", desc: "关门 / 合箱盖", cost: 0,
    params: { id: "propId" }, limits: "关门不受锁限制；箱盖合上后不能存取" },
  { id: "lock", level: 2, scope: "adjacent", desc: "上锁（要交出当前凭证）", cost: 0,
    params: { id: "propId", credential: "{type,value}" }, limits: "必须先 setLock 配好锁具；上锁会同时合上开关" },
  { id: "unlock", level: 2, scope: "adjacent", desc: "解锁", cost: 0,
    params: { id: "propId", credential: "{type,value}" }, limits: "密码只存 sha256 摘要，钥匙只认编号；不判定所有权" },
  { id: "setLock", level: 3, scope: "adjacent", desc: "配置 / 拆除锁具（密码、钥匙、提示）", cost: 0,
    params: { id: "propId", mode: "none|code|key", newSecret: "string<=64", hint: "string<=40?" },
    limits: "锁着时不能改；已有锁具改配必须交出旧凭证；secret 永不出现在任何对外视图" },
  { id: "deposit", level: 2, scope: "adjacent", desc: "往开着的储物箱存东西", cost: 0,
    params: { id: "propId", item: "itemId", count: "number" }, limits: "箱要开着且没锁；箱额度 30 格 / 200 负重 / 单类 10 格" },
  { id: "withdraw", level: 2, scope: "adjacent", desc: "从开着的储物箱取东西", cost: 0,
    params: { id: "propId", item: "itemId", count: "number" }, limits: "背包额度 24 格 / 80 负重 / 单类 6 格，装不下就拒绝" },
  { id: "inspectProp", level: 1, scope: "adjacent", desc: "看门 / 箱的开合与锁状态", cost: 0,
    params: { id: "propId" }, limits: "只读；不返回密码摘要和钥匙编号" },
  { id: "attack", level: 2, scope: "adjacent", desc: "攻击（只给强度，不给形式）", cost: 0,
    params: { targetId: "entityId", intensity: "0..1" }, limits: "距离 <= 1.6 格、必须看得见、0.8s 冷却" },
  { id: "rest", level: 1, scope: "self", desc: "原地休息（恢复体力）", cost: 0, params: {}, limits: "移动会打断" },
  { id: "eat", level: 2, scope: "adjacent", desc: "在灶台吃饭（恢复饥饿）", cost: 0, params: {}, limits: "距离灶台 <= 1.9 格，3 秒冷却" },
  { id: "stop", level: 1, scope: "self", desc: "停下", cost: 0, params: {}, limits: "" },
  { id: "propose", level: 4, scope: "adjacent", desc: "求婚（成年限定）", cost: 0,
    params: { targetId: "entityId" }, limits: "双方成年且未婚、距离<=3、看得见；60 秒内有效；一次只能挂一个" },
  { id: "answerProposal", level: 4, scope: "self", desc: "答应或拒绝求婚", cost: 0,
    params: { proposalId: "string", accept: "boolean" }, limits: "只能答发给自己的" },
  { id: "giveBirth", level: 4, scope: "adjacent", desc: "和配偶生孩子（孩子从 0 岁开始长大）", cost: 0,
    params: { name: "string<=12?" }, limits: "已婚、配偶在 3 格内、3 游戏日冷却；孩子天赋/性格随父母" },
  { id: "postForum", level: 5, scope: "global", desc: "游戏内论坛发帖/回帖（成年限定，线上不限距离）", cost: 0,
    params: { text: "string<=280", replyTo: "seq?" }, limits: "成年才能用；3 秒冷却；未成年人看不到这一层" },
  { id: "readForum", level: 5, scope: "global", desc: "读游戏内论坛最近 20 条（成年限定）", cost: 0,
    params: {}, limits: "居民的帖子和人类导入的内容混排" },
  { id: "promise", level: 3, scope: "adjacent", desc: "对人许下约定（未了结前每次观察都会提醒你）", cost: 0,
    params: { targetId: "id", text: "string<=80", coins: "number?" }, limits: "成年；面对面 3 格内；每人名下最多 20 条" },
  { id: "settle", level: 3, scope: "self", desc: "了结自己欠下的一条约定（还钱/宣告完成，没人强制你）", cost: 0,
    params: { commitmentId: "id", coins: "number?（部分偿还）" }, limits: "成年；只有欠的一方能了结" }
];

const CAPABILITY_LADDER = [
  { level: 1, name: "身体", desc: "移动、看、说、听、开合门与箱盖、攻击", status: "已实现" },
  { level: 2, name: "财物", desc: "拾取、种植、收获、烹饪、赠予、买卖、储物箱存取、上锁", status: "已实现：背包三重额度（24 格/80 负重/单类 6 格）+ 储物箱 + 密码/钥匙锁；NPC 自主用锁待开发" },
  { level: 3, name: "空间", desc: "占地、建房、改门、摆家具、配锁具", status: "部分实现：build/remove（含储物箱），还没有地块所有权" },
  { level: 4, name: "社会", desc: "契约、雇佣、结婚、结社、投票、立法、征税", status: "部分实现：拍卖 + 求婚/婚配/生育/继承；还没有组织与规则引擎" },
  { level: 5, name: "元层", desc: "发公告、办报纸、开店铺、雇 NPC", status: "未实现：需要持久化与调度" },
  { level: 6, name: "外部", desc: "调用外部 API / 发邮件 / 花钱", status: "不建议开放：注入与越权风险" }
];

// ---------- SSE ----------
const clients = new Map();   // res -> token（null 表示观众：全知视角）
// v2 观众（?v=2）：走增量协议——5Hz 轻帧 + 2s 全量对账，流量约为 v1 的 1/20
const v2clients = new Set();
// Agent 观察流：res -> villagerId。定向推送"发给这个角色的事件"（说话/提醒/报价…）。
// 轮询拿的是完整观察，这里只推增量——Agent App 想省额度就走这条。
const agentStreams = new Map();
world.targetHooks.add((target, ev) => {
  if (!target) return;
  for (const [res, vid] of agentStreams) {
    if (vid !== target.id) continue;
    try {
      res.write("data: " + JSON.stringify(ev) + "\n\n");
    } catch { agentStreams.delete(res); }
  }
});
// SSE 心跳：代理/负载均衡最怕 30 秒没流量的长连接
const agentStreamKeepalive = setInterval(() => {
  for (const res of agentStreams.keys()) {
    try { res.write(": ping\n\n"); } catch { agentStreams.delete(res); }
  }
}, 15000);
agentStreamKeepalive.unref?.();

// token 优先走头（不进 URL / 日志），query 仅作兼容保留
function tokenFrom(req, url) {
  const auth = String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const h = req.headers["x-agent-token"];
  if (typeof h === "string" && h.trim()) return h.trim();
  return (url && url.searchParams.get("token")) || null;
}

function validAgent(token) {
  if (!token) return null;
  const key = hashToken(token);
  const a = agents.get(key);
  if (!a) return null;
  if (a.since && Date.now() - a.since > AGENT_TTL_MS) {
    agents.delete(key);
    saveAgents();
    console.log("[agent] token 过期释放 " + a.villagerId);
    return null;
  }
  a.lastUsed = Date.now();
  return a;
}

function villagerFromToken(token) {
  const a = validAgent(token);
  return a ? world.entities.get(a.villagerId) || null : null;
}

function maskedMapFor(v) {
  const j = map.toJSON();
  const seen = v.explored || new Set();
  j.rows = j.rows.map((row, y) => {
    let s = "";
    for (let x = 0; x < row.length; x++) s += seen.has(x + "," + y) ? row[x] : ".";
    return s;
  });
  return j;
}

// 按观察者重建世界：只给看得见的人、只给走过的地图
function projectFor(v) {
  const ents = [];
  for (const o of world.entities.values()) {
    if (o.id === v.id) { ents.push(pubFor(o, v)); continue; }
    if (!world.canSee(v, o)) continue;
    const p = pubFor(o, v);
    p.uid = String(o.uid || "").slice(0, 1) + "······";
    ents.push(p);
  }
  return {
    tick: world.tickCount,
    clock: { ...world.clock, hour: world.hour },
    entities: ents,
    doors: [], patches: [], log: [],
    map: maskedMapFor(v)
  };
}


function broadcast(obj) {
  for (const [res, token] of clients) {
    try {
      if (!token) {
        res.write("data: " + JSON.stringify(obj) + "\n\n");
        continue;
      }
      // 居民连接：只推自己看得见的那一份，地图变化和全局事件不推
      if (obj.type !== "state") continue;
      const v = villagerFromToken(token);
      if (!v) continue;
      res.write("data: " + JSON.stringify({ type: "state", ...projectFor(v) }) + "\n\n");
    } catch { clients.delete(res); }
  }
  // v2 观众：state 由 tick 循环单独调度（5Hz dyn + 2s 全量），其余消息照发
  if (obj.type !== "state") bcastV2(obj);
}

function bcastV2(obj) {
  for (const res of v2clients) {
    try {
      res.write("data: " + JSON.stringify(obj) + "\n\n");
    } catch { v2clients.delete(res); }
  }
}

// v2 增量帧：只含动态字段，且只发有变化的实体。
// 数组格式 [id, x, y, dir, state, hp, bubble]，比对象省一半字节。
let lastDyn = new Map();
function dynFrame() {
  const out = [];
  const cur = new Map();
  for (const v of world.entities.values()) {
    if (v.state === "dead") continue;
    const b = v.bubble ? v.bubble.text : null;
    const key = v.x.toFixed(1) + "|" + v.y.toFixed(1) + "|" + (v.dir || 0).toFixed(2) + "|" + v.state + "|" + v.hp + "|" + (b || "");
    cur.set(v.id, key);
    if (lastDyn.get(v.id) === key) continue;
    out.push([v.id, Math.round(v.x * 10) / 10, Math.round(v.y * 10) / 10, Math.round((v.dir || 0) * 100) / 100, v.state, v.hp, b]);
  }
  lastDyn = cur;
  return out;
}

function clockLite() {
  return { day: world.clock.day, minutes: Math.round(world.clock.minutes), season: world.clock.season, hour: world.hour };
}

world.subscribers.add((ev) => {
  if (["utterance", "said", "attack_landed", "fell", "downed", "learned_recipe", "forgot"].includes(ev.type)) {
    broadcast({ type: "event", ev: redactEvent(ev, null) });
  }
});

// 记忆导出：给自带上下文的 Agent App（player 型）维持长期记忆用的结构化摘要。
// 世界不替 AI 记住一切——它只把"值得带走的"交出去，剩下的由 AI 自己的上下文保存。
function memoryExport(v) {
  const pairs = [];
  for (const [k, n] of world.pairs) {
    const [aId, bId] = k.split("|");
    const otherId = aId === v.id ? bId : aId;
    if (aId !== v.id && bId !== v.id) continue;
    const o = world.entities.get(otherId);
    if (o && o.state !== "dead") pairs.push({ name: o.name, id: o.id, familiarity: n });
  }
  pairs.sort((x, y) => y.familiarity - x.familiarity);
  return {
    self: {
      name: v.name, id: v.id, role: v.role, ageDays: v.ageDays, stage: stageOf(v.ageDays),
      home: v.home, coins: v.coins || 0,
      needs: { energy: Math.round(v.needs.energy), hunger: Math.round(v.needs.hunger) }
    },
    skills: Object.fromEntries(Object.entries(v.skills).map(([k, s]) => [k, s.level])),
    knownRecipes: v.knownRecipes.slice(),
    acquaintances: pairs.slice(0, 12),
    commitments: world.commitmentsFor(v),
    family: v.family || { parents: [], spouseId: null, children: [] },
    board: world.board.slice(-8),
    day: world.clock.day, tick: world.tickCount
  };
}

// 电子宠物转生：同一 persona 空降为全新成年旅行者——uid、熟人、技能、地图记忆全部清零。
// "无记忆转生"就是字面意思：世界不为他保留任何东西，除了名字和他主人的爱。
function reincarnate(a) {
  try {
    const name = (a.name || "转生者").slice(0, 12);
    const born = world.mutate({ kind: "spawn", spec: { name, role: "wanderer", home: map.spawn, ageDays: 20, origin: "traveler", aging: "manual" } });
    if (!born || !born.ok) return null;
    const nv = world.entities.get(born.id);
    if (!nv) return null;
    world.mutate({ kind: "external", id: nv.id, on: true });
    a.villagerId = nv.id; a.name = nv.name;
    a.rebirths = (a.rebirths || 0) + 1;
    a.lastAct = world.tickCount;
    saveAgents(); saveWorld();
    return nv;
  } catch (err) {
    console.warn("[agent] 转生失败:", err.message);
    return null;
  }
}

// 居民的心（目标、记忆、性格）。它不属于世界状态，单独存档：
// 不进指纹、不进回放——回放的是"做了什么"，不是"想过什么"。
function saveMinds() {
  if (!brains) return;
  try {
    fs.writeFileSync(MINDS_FILE, JSON.stringify(brains.serialize()));
  } catch (err) {
    console.warn("[minds] 存盘失败:", err.message);
  }
}
function readMinds() {
  try {
    if (!fs.existsSync(MINDS_FILE)) return null;
    return JSON.parse(fs.readFileSync(MINDS_FILE, "utf8"));
  } catch {
    return null;
  }
}

let brains = null;

const loop = setInterval(() => {
  world.step();
  if (brains) brains.tick();   // 决策跟着 tick 走，不跟墙钟走
  maybeExpand();   // 居民开拓：走到边缘就按大纲显现下一块
  // 电子宠物死了/没了 → 无记忆转生（每秒巡检一次，玩家型不转生：死亡是他们的故事结局）
  for (const [key, a] of agents) {
    if (a.playerType !== "pet") continue;
    const pv = world.entities.get(a.villagerId);
    if (!pv || pv.state === "dead") {
      const nv = reincarnate(a);
      if (nv) console.log("[agent] 电子宠物转生: " + nv.name + "（第 " + a.rebirths + " 次）");
    }
  }
  // 外部 AI 掉线超过 30 秒，把村民还给脚本
  for (const [key, a] of agents) {
    const v = world.entities.get(a.villagerId);
    // 托管模式由服务器自己驱动，看不到客户端心跳，按"最近一次成功行动"算闲置
    const idleMs = (a.mode || "client") === "hosted"
      ? Date.now() - (a.lastOkAt || a.since || 0)
      : 0;
    const staleClient = (a.mode || "client") !== "hosted" && world.tickCount - a.lastAct > 1800;
    const staleHosted = idleMs > AGENT_IDLE_MS;
    if (staleClient || staleHosted) {
      if (v) world.mutate({ kind: "external", id: v.id, on: false });
      for (const [res, vid] of agentStreams) {
        if (vid === a.villagerId) { try { res.end(); } catch {} agentStreams.delete(res); }
      }
      agents.delete(key);
      saveAgents();
      console.log("[agent] " + (staleHosted ? "托管闲置回收" : "超时释放") + " " + (v ? v.name : a.villagerId));
    }
  }
  if (world.tickCount % SAVE_EVERY_TICKS === 0) { saveWorld(); saveMap(); }
  if (world.tickCount % SAVE_EVERY_TICKS === 0) saveMinds();
  broadcast({ type: "state", ...world.snapshot() });   // v1：每 tick 全量（旧观测器兼容）
  // v2：每 2 tick 一帧增量（只发有变化的实体），每 50 tick（5s）一次全量对账
  if (v2clients.size) {
    if (world.tickCount % 2 === 0) {
      const e = dynFrame();
      if (e.length) bcastV2({ type: "dyn", tick: world.tickCount, clock: clockLite(), e });
    }
    if (world.tickCount % 50 === 0) bcastV2({ type: "state", ...world.snapshot() });
  }
}, 1000 / CFG.TICK_HZ);

if (ENABLE_BRAINS) {
  brains = attachBrains(world, { timer: false });
  const restoredMinds = brains.restore(readMinds());
  console.log("[brain] 已启动，村民按自己的目标行动" + (restoredMinds ? "（恢复 " + restoredMinds + " 份记忆）" : ""));
}

// 托管：用玩家给的 API 驱动他们的鱼
const hostedRunner = createHostedRunner({
  world,
  agents,
  observe,
  applyAction: (v, act) => world.applyAction(v, act),
  log: (m) => console.log(m),
  intervalMs: Number(process.env.HOSTED_INTERVAL_MS || 5000)
}).start();
// 加载插件：NPC/主人可以给世界加新动作
try {
  const pluginDir = path.join(HERE, "plugins");
  if (fs.existsSync(pluginDir)) {
    for (const file of fs.readdirSync(pluginDir)) {
      if (!file.endsWith(".mjs")) continue;
      const mod = await import(pathToFileURL(path.join(pluginDir, file)).href);
      if (typeof mod.register === "function") {
        mod.register(world);
        console.log("[plugin] 加载 " + file);
      }
    }
  }
} catch (err) {
  console.warn("[plugin] 加载失败:", err.message);
}

console.log("[hosted] 托管运行器已启动（每 " + Math.round(Number(process.env.HOSTED_INTERVAL_MS || 5000) / 1000) + " 秒一次）");

// ---------- HTTP ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
  if (res.cors) headers["access-control-allow-origin"] = res.cors;
  if (res.cors && res.cors !== "*") headers.vary = "Origin";
  res.writeHead(code, headers);
  res.end(body);
}

function serveStatic(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "x-content-type-options": "nosniff"
    });
    res.end(buf);
  });
}

const rawMap = JSON.parse(fs.readFileSync(path.join(HERE, "data", "village.json"), "utf8"));
const corsFor = makeCorsChecker(PORT, envOrigins());

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  res.cors = corsFor(req);

  const reqIp = req.socket.remoteAddress || "local";
  // 注册接口也进限流桶（原先被 /api/agents/ 前缀整体排除，等于免限流）
  if (p.startsWith("/api/") && p !== "/api/stream"
      && !(p.startsWith("/api/agents/") && p !== "/api/agents/register")) {
    if (!allow(reqIp, 300, 60)) return json(res, 429, { error: "rate_limited" });
  }

  if (req.method === "OPTIONS") {
    const headers = { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, x-agent-token" };
    if (res.cors) {
      headers["access-control-allow-origin"] = res.cors;
      if (res.cors !== "*") headers.vary = "Origin";
    }
    res.writeHead(204, headers);
    return res.end();
  }

  // 观看端
  if (p === "/" || p === "/index.html") return serveStatic(res, path.join(HERE, "viewer", "index.html"));
  if (p === "/join" || p === "/join.html") return serveStatic(res, path.join(HERE, "viewer", "join.html"));
  if (p === "/watch" || p === "/chief") return serveStatic(res, path.join(HERE, "viewer", "index.html"));
  if (p === "/pixi") return serveStatic(res, path.join(HERE, "viewer", "pixi.html"));
  if (p === "/create" || p === "/create.html") return serveStatic(res, path.join(HERE, "viewer", "create.html"));
  if (p.startsWith("/maps/")) return serveStatic(res, path.join(HERE, "maps", path.basename(p)));
  if (p.startsWith("/viewer/")) return serveStatic(res, path.join(HERE, "viewer", path.basename(p)));

  // 外部接入接口
  if (p === "/api/world") {
    const v = villagerFromToken(tokenFrom(req, url));
    if (v) return json(res, 200, projectFor(v));
    return json(res, 200, { map: map.toJSON(), ...world.snapshot(null) });
  }
  if (p === "/api/health") return json(res, 200, { ok: true, tick: world.tickCount, entities: world.entities.size });
  // 居民此刻在想什么：目标、心情、内驱力、记住的地方。给观察者和调参用。
  if (p === "/api/minds") {
    const list = [];
    if (brains) {
      for (const [id, m] of brains.minds) {
        const v = world.entities.get(id);
        if (v && v.state !== "dead") list.push(dumpMind(v, m.bb, null, null));
      }
    }
    return json(res, 200, { tick: world.tickCount, brains: !!brains, minds: list });
  }
  if (p === "/api/server") return json(res, 200, {
    inviteRequired: INVITE_REQUIRED,
    tick: world.tickCount,
    villagers: world.entities.size,
    freeSlots: [...world.entities.values()].filter((v) => !v.external).length,
    map: { width: map.width, height: map.height, homes: map.homes.length },
    connected: agents.size,
    uptime: Math.round(process.uptime()),
    savedAt: (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).savedAt; } catch { return null; } })()
  });
  if (p === "/api/capabilities") return json(res, 200, { capabilities: CAPABILITIES, ladder: CAPABILITY_LADDER });
  // 物件控制台：观测站角色页用。与 Agent 的 act 走同一个 world.propControl，
  // 所以"输入 → 判断 → 开关"只有一套规则。公网部署请在网关层加鉴权。
  if (p === "/api/props") return json(res, 200, { tick: world.tickCount, props: world.propsView() });
  if (p === "/api/props/act" && req.method === "POST") {
    readBody(req, res).then((body) => {
      if (!body) return;
      const r = world.propControl(body || {});
      // 业务拒绝（密码错、背包满、离太远）是正常结果，不是 HTTP 错误：
      // 和 /api/agents/:token/act 一样恒返回 200，由响应体里的 ok 表达成败。
      return json(res, 200, r);
    }).catch(() => json(res, 400, { error: "bad_body" }));
    return;
  }

  if (p.startsWith("/api/villagers/")) {
    const id = p.split("/").pop();
    const v = world.entities.get(id);
    if (!v) return json(res, 404, { error: "no such villager" });
    return json(res, 200, {
      ...pubFor(v, null),
      skills: Object.fromEntries(Object.entries(v.skills).map(([k, s]) => [k, { level: s.level }])),
      knownRecipes: v.knownRecipes,
      personality: v.personality
      // talent 永远不出去
    });
  }

  if (p === "/api/streams") {
    return json(res, 200, [...agents.entries()]
      .filter(([, a]) => a.publicView !== false)
      .map(([, a]) => {
        const v = world.entities.get(a.villagerId);
        return v ? { villagerId: v.id, name: v.name, mode: a.mode || "client", rules: "" } : null;
      })
      .filter(Boolean));
  }

  if (p === "/api/protocols") {
    return json(res, 200, [...world.protocols.values()].map((x) => ({
      ...x, rules: world.rulesOf(x)
    })));
  }

  if (p === "/api/board") {
    const limit = Math.min(100, Number(url.searchParams.get("limit") || 30));
    return json(res, 200, { posts: world.board.slice(-limit) });
  }

  if (p === "/api/log") {
    const since = Number(url.searchParams.get("since") || 0);
    return json(res, 200, world.log
      .filter((e) => e.tick > since)
      .slice(-200)
      .map((e) => redactEvent(e, null)));
  }

  if (p === "/api/stream") {
    const sseHeaders = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-content-type-options": "nosniff"
    };
    if (res.cors) {
      sseHeaders["access-control-allow-origin"] = res.cors;
      if (res.cors !== "*") sseHeaders.vary = "Origin";
    }
    res.writeHead(200, sseHeaders);
    const tok = tokenFrom(req, url);
    const vv = villagerFromToken(tok);
    res.write("data: " + JSON.stringify({ type: "hello", map: vv ? maskedMapFor(vv) : map.toJSON(), tick: world.tickCount }) + "\n\n");
    if (!vv && url.searchParams.get("v") === "2") {
      // v2 观众：先给一份全量打底，之后走 5Hz dyn + 2s 对账
      v2clients.add(res);
      res.write("data: " + JSON.stringify({ type: "state", ...world.snapshot() }) + "\n\n");
      req.on("close", () => v2clients.delete(res));
    } else {
      clients.set(res, vv ? tok : null);
      req.on("close", () => clients.delete(res));
    }
    return;
  }


  // ---------- 管理：邀请码 ----------
  if (p.startsWith("/api/admin/")) {
    const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!sameSecret(given, ADMIN_KEY)) return json(res, 401, { error: "unauthorized" });

    if (p === "/api/admin/invites" && req.method === "POST") {
      readBody(req, res).then((body) => {
      if (!body) return;
        const rec = createInvite({
          label: body.label,
          maxUses: body.maxUses,
          hours: Number(body.hours || 0)
        });
        console.log("[invite] 生成 " + rec.code + "（" + (rec.label || "未命名") + "，可用 " + rec.maxUses + " 次）");
        json(res, 200, rec);
      }).catch(() => json(res, 400, { error: "bad_body" }));
      return;
    }
    if (p === "/api/admin/invites" && req.method === "GET") {
      return json(res, 200, invites.codes);
    }

    // 黑匣子：种子 + 开局快照 + 全部动作 = 可以离线重跑这一段
    if (p === "/api/admin/journal" && req.method === "GET") {
      if (!JOURNAL_ON) return json(res, 200, { enabled: false });
      const limit = Number(url.searchParams.get("limit") || 0);
      const acts = world.journal || [];
      return json(res, 200, {
        enabled: true,
        seed: world.seed,
        startedAt: journalStart.tick,
        tick: world.tickCount,
        overflow: world.journalOverflow,
        count: acts.length,
        hash: worldHash(world),
        start: journalStart,
        // 终点状态一并带上：回放对不上时能直接指出是哪个字段先分的叉，
        // 而不是只丢一个哈希让人猜。十几 KB，比人工排查便宜太多。
        endState: serializeWorld(world),
        actions: limit > 0 ? acts.slice(-limit) : acts
      });
    }
    if (p === "/api/admin/grow" && req.method === "POST") {
      readBody(req, res).then((body) => {
      if (!body) return;
        const side = ["n", "s", "e", "w"].includes(body.side) ? body.side : "e";
        const g = world.mutate({ kind: "grow", side });
        if (!g.ok) return json(res, 400, { error: g.reason, hint: g.hint || null });
        saveMap();
        broadcast({ type: "mapnew", map: map.toJSON() });
        json(res, 200, { ok: true, ...g, homes: map.homes.length });
      }).catch((e) => json(res, 400, { error: "bad_body", detail: String(e && e.message || e) }));
      return;
    }

    if (p === "/api/admin/teleport" && req.method === "POST") {
      readBody(req, res).then((body) => {
      if (!body) return;
        const v = world.entities.get(body.villagerId) || [...world.entities.values()][0];
        if (!v) return json(res, 404, { error: "no_villager" });
        const x = Number(body.x), y = Number(body.y);
        const r = world.mutate({ kind: "teleport", id: v.id, x, y });
        if (!r.ok) return json(res, 400, { error: r.reason });
        json(res, 200, { ok: true, villager: v.name, at: { x, y } });
      }).catch(() => json(res, 400, { error: "bad_body" }));
      return;
    }

    if (p === "/api/admin/grant" && req.method === "POST") {
      readBody(req, res).then((body) => {
      if (!body) return;
        const v = world.entities.get(body.villagerId) || [...world.entities.values()][0];
        if (!v) return json(res, 404, { error: "no_villager" });
        world.mutate({ kind: "grant", id: v.id, item: body.item, count: body.count, coins: body.coins });
        json(res, 200, { ok: true, villager: v.name, coins: v.coins, inventory: v.inventory });
      }).catch(() => json(res, 400, { error: "bad_body" }));
      return;
    }

    if (p === "/api/admin/forum/import" && req.method === "POST") {
      // 人类内容网关：把外部帖子/弹幕导入游戏内论坛（成年居民可见，未成年人不可见）
      readBody(req, res).then((body) => {
        if (!body) return;
        const r = world.mutate({ kind: "forumImport", text: body.text, author: body.author });
        if (!r.ok) return json(res, 400, { error: r.reason });
        json(res, 200, { ok: true, seq: r.seq, note: "已导入游戏内论坛：成年居民可见" });
      }).catch(() => json(res, 400, { error: "bad_body" }));
      return;
    }

    if (p === "/api/admin/forum/replies" && req.method === "GET") {
      // 双向通道：居民回给人类帖的、还没拉走的回复。送回人类侧后用 mark 导出标记。
      return json(res, 200, { pending: world.pendingForumReplies(), tick: world.tickCount });
    }
    if (p === "/api/admin/forum/replies" && req.method === "POST") {
      readBody(req, res).then((body) => {
        if (!body) return;
        const n = world.markForumRepliesExported(body.seqs);
        json(res, 200, { ok: true, exported: n });
      }).catch(() => json(res, 400, { error: "bad_body" }));
      return;
    }

    if (p === "/api/admin/growup" && req.method === "POST") {
      readBody(req, res).then((body) => {
      if (!body) return;
        const v = world.entities.get(body.villagerId) || [...world.entities.values()][0];
        if (!v) return json(res, 404, { error: "no_villager" });
        const r = world.mutate({ kind: "growUp", id: v.id });
        if (!r.ok) return json(res, 400, { error: r.reason, ...(r.hint ? { hint: r.hint } : {}) });
        json(res, 200, { ok: true, villager: v.name, ageDays: r.ageDays, stage: r.stage });
      }).catch(() => json(res, 400, { error: "bad_body" }));
      return;
    }

    if (p === "/api/admin/age" && req.method === "POST") {
      readBody(req, res).then((body) => {
      if (!body) return;
        const v = world.entities.get(body.villagerId) || [...world.entities.values()][0];
        if (!v) return json(res, 404, { error: "no_villager" });
        const r = world.mutate({ kind: "age", id: v.id, ageDays: body.ageDays });
        if (!r.ok) return json(res, 400, { error: r.reason });
        json(res, 200, { ok: true, villager: v.name, ageDays: v.ageDays, stage: stageOf(v.ageDays) });
      }).catch(() => json(res, 400, { error: "bad_body" }));
      return;
    }

    const rev = p.match(/^\/api\/admin\/invites\/([^/]+)\/revoke$/);
    if (rev && req.method === "POST") {
      const rec = invites.codes.find((c) => c.code === rev[1].toUpperCase());
      if (!rec) return json(res, 404, { error: "no_such_code" });
      rec.disabled = true;
      saveInvites();
      return json(res, 200, { ok: true, code: rec.code });
    }
    return json(res, 404, { error: "not_found" });
  }

  // ---------- 外部 AI：注册 / 观察 / 行动 ----------
  if (p === "/api/agents" && req.method === "GET") {
    return json(res, 200, [...agents.entries()].map(([token, a]) => ({
      villagerId: a.villagerId,
      name: (world.entities.get(a.villagerId) || {}).name,
      idleTicks: world.tickCount - a.lastAct
    })));
  }

  if (p === "/api/agents/register" && req.method === "POST") {
    readBody(req, res).then((body) => {
      if (!body) return;
      const ip = req.socket.remoteAddress || "local";
      if (!allowRegister(ip)) {
        return json(res, 429, { error: "too_many_registrations", hint: "同一 IP 10 分钟最多领 10 条" });
      }
      if (INVITE_REQUIRED) {
        const inv = consumeInvite(body.invite);
        if (!inv) {
          return json(res, 403, { error: "invite_required", hint: "需要一个有效的邀请码（找管理员要）" });
        }
      }
      if (!allowGlobalRegister()) {
        return json(res, 429, { error: "server_busy", hint: "这个小时注册的人太多了，稍后再试" });
      }

      // 先校验模型端点，再动世界：否则一个坏 baseUrl 也会白占格、白长地图
      const mode = body.mode === "hosted" ? "hosted" : "client";
      const persona = typeof body.persona === "string" ? body.persona.slice(0, 2000) : "";
      const schedule = parseSchedule(body.schedule);
      const publicView = body.publicView !== false;
      // 玩家身份（大纲修订）：
      //   player = 自带上下文的 AI 玩家——记忆在它自己的 Agent App 里，本服只出观察与"记忆导出"；
      //   pet    = 电子宠物——无长期记忆，死亡后带着同一 persona 无记忆转生。
      const playerType = body.playerType === "pet" ? "pet" : "player";
      if (mode === "hosted") {
        const reason = modelRejectReason(body.model);
        if (reason) {
          return json(res, 400, {
            error: "hosted_needs_model", reason,
            hint: "托管模式需要 {baseUrl, model, apiKey}；baseUrl 须 https 且在白名单内。本地算力（Ollama/LM Studio）让管理员开 AVB_ALLOW_LOCAL_LLM=1 后填 http://127.0.0.1:端口"
          });
        }
      }
      const model = mode === "hosted" ? sealModel(sanitizeModel(body.model)) : null;

      // 未成年硬隔离（蓝图 3.2）：未成年人不能被外部 AI 接管。
      // 这不是模型层面的"建议"，是注册入口的物理拒绝——孩子的上下文
      // 从源头上就不允许注入任何人类内容。
      let free = [...world.entities.values()].find((v) => !v.external && !isMinor(v) && v.state !== "dead");

      if (!free) {
        // 没有空位就生成一个新居民：住广场（房子要自己盖）。
        // 注册进来的按蓝图设定是"空降的成年旅行者"，不是原住民——
        // 原住民只能靠 birth 出生，从童年开始长大。
        const g = world.mutate({ kind: "grow", side: "e" });
        if (g.ok) {
          saveMap();
          broadcast({ type: "mapnew", map: map.toJSON() });
        }
        // 大陆尽头（g.ok=false）也不影响：世界够大，新居民照样空降
        const born = world.mutate({ kind: "spawn", spec: { name: "新居民", role: "wanderer", home: map.spawn, ageDays: 20, origin: "traveler", aging: "manual" } });
        free = world.entities.get(born.id);
        world.mutate({ kind: "home", id: free.id, home: null });
        console.log("[world] 新居民 " + free.name + " 来到广场" + (g.ok ? "；地图长了一块 → " + map.width + "×" + map.height : "；（大陆已开放到尽头，就地安置）"));
      }
      world.mutate({ kind: "external", id: free.id, on: true });
      if (body.name) world.mutate({ kind: "rename", id: free.id, name: String(body.name).slice(0, 12) });

      // 玩家上传的头像：只收 16×16 的 PNG，尺寸小、可控
      const portrait = typeof body.portrait === "string"
        && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(body.portrait)
        && body.portrait.length < 60000 ? body.portrait : null;
      if (portrait) world.mutate({ kind: "appearance", id: free.id, patch: { portrait } });

      // 调色板：只收 5 个合法十六进制色
      let palette = null;
      if (body.palette && typeof body.palette === "object") {
        const picked = {};
        for (const key of ["hair", "dress", "skin", "white", "accent"]) {
          const val = body.palette[key];
          if (typeof val === "string" && /^#[0-9a-fA-F]{6}$/.test(val)) picked[key] = val;
        }
        if (Object.keys(picked).length >= 3) palette = picked;
      }
      if (palette) world.mutate({ kind: "appearance", id: free.id, patch: { palette } });
      saveWorld();
      const token = "t_" + randomUUID().replace(/-/g, "");
      agents.set(hashToken(token), {
        villagerId: free.id, name: free.name, mode, persona, schedule, model, publicView, playerType,
        lastAct: world.tickCount - AGENT_COOLDOWN_TICKS, since: Date.now(), rebirths: 0
      });
      saveAgents();
      console.log("[agent] 接入 " + free.name + " (" + free.id + ", " + mode + ")");
      json(res, 200, {
        token,
        mode, playerType,
        villager: pubFor(free, null),
        usage: mode === "hosted"
          ? { note: "服务器会用你给的 API 每 2 秒想一次；你不在线它也在跑。", status: "GET /api/agents/" + token + "/status" }
          : {
              observe: "GET /api/agents/" + token + "/observation",
              act: "POST /api/agents/" + token + "/act",
              memory: "GET /api/agents/" + token + "/memory（给自带上下文的 Agent App 维持长期记忆用）"
            }
      });
    }).catch(() => json(res, 400, { error: "bad_body" }));
    return;
  }

  // 切换模式 / 改人设 / 改模型（用同一个 token）
  const cfgRoute = p.match(/^\/api\/agents\/([A-Za-z0-9_]+)\/config$/);
  if (cfgRoute && req.method === "POST") {
    const a = validAgent(cfgRoute[1]);
    if (!a) return json(res, 401, { error: "unknown_token" });
    const v = world.entities.get(a.villagerId);
    if (!v) return json(res, 410, { error: "villager_gone" });

    readBody(req, res).then((body) => {
      if (!body) return;
      const before = a.mode || "client";
      const nextMode = body.mode === "hosted" || body.mode === "client" ? body.mode : before;

      if (typeof body.persona === "string") a.persona = body.persona.slice(0, 2000);
      if (typeof body.publicView === "boolean") a.publicView = body.publicView;
      if (body.schedule) a.schedule = parseSchedule(body.schedule);

      if (body.model) {
        const prevBase = a.model ? String(a.model.baseUrl || "") : "";
        const nextBase = String(body.model.baseUrl || prevBase || "");
        // 换端点必须重新给 key：否则存量密钥会被静默发到新地址
        if (prevBase && nextBase !== prevBase && !body.model.apiKey) {
          return json(res, 400, { error: "apiKey_required_on_baseUrl_change", hint: "修改 baseUrl 时必须同时提交新的 apiKey" });
        }
        const reason = modelRejectReason({ ...(a.model || {}), ...body.model, baseUrl: nextBase, apiKey: body.model.apiKey || (a.model ? a.model.apiKey : "") });
        if (reason) return json(res, 400, { error: "bad_model_endpoint", reason });
        const merged = sanitizeModel({
          ...(a.model || {}),
          ...body.model,
          baseUrl: nextBase,
          apiKey: body.model.apiKey || (a.model ? a.model.apiKey : "")
        });
        if (merged) a.model = sealModel(merged);
      }

      if (nextMode === "hosted" && (!a.model || !a.model.baseUrl || !a.model.model)) {
        return json(res, 400, { error: "hosted_needs_model", hint: "切到托管要有 baseUrl + model + apiKey" });
      }

      if (nextMode !== before) {
        a.mode = nextMode;
        world.mutate({ kind: "external", id: v.id, on: true });
        if (nextMode === "client") a.lastAct = world.tickCount;  // 给 30 秒接管时间
        console.log("[agent] " + v.name + " 切换 " + before + " -> " + nextMode);
      }

      saveAgents();
      json(res, 200, { ok: true, ...maskAgent(a), villager: pubFor(v, v) });
    }).catch(() => json(res, 400, { error: "bad_body" }));
    return;
  }

  const agentRoute = p.match(/^\/api\/agents\/([A-Za-z0-9_]+)\/(observation|act|status|map|memory|stream)$/);
  if (agentRoute) {
    const token = agentRoute[1], kind = agentRoute[2];
    const a = validAgent(token);
    if (!a) return json(res, 401, { error: "unknown_token" });
    let v = world.entities.get(a.villagerId);
    // 宠物型死亡：懒转生（巡检循环通常已处理，这里兜底）
    if ((!v || v.state === "dead") && a.playerType === "pet") v = reincarnate(a) || v;
    if (!v) return json(res, 410, { error: "villager_gone" });
    // 玩家型死亡：不转生。给一段"讣告 + 记忆导出"，让他的 Agent App 给故事收尾。
    if (v.state === "dead" && kind !== "memory") {
      return json(res, 410, {
        error: "villager_dead",
        memorial: {
          name: v.name, ageDays: v.ageDays, stage: stageOf(v.ageDays),
          note: "这条命结束了。你的记忆导出在 memory 里，世界会记得他。"
        },
        memory: memoryExport(v)
      });
    }
    if (kind === "memory" && req.method === "GET") {
      return json(res, 200, memoryExport(v));
    }
    if (kind === "stream" && req.method === "GET") {
      // 观察流订阅：定向推送发给这个角色的事件（SSE）。
      // 事件同时仍会进 inbox——轮询和订阅两条路不互相抢。
      const sseHeaders = {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-content-type-options": "nosniff"
      };
      if (res.cors) {
        sseHeaders["access-control-allow-origin"] = res.cors;
        if (res.cors !== "*") sseHeaders.vary = "Origin";
      }
      res.writeHead(200, sseHeaders);
      res.write("data: " + JSON.stringify({ type: "hello", tick: world.tickCount, villager: v.name, note: "定向事件流；完整观察仍走 /observation" }) + "\n\n");
      agentStreams.set(res, v.id);
      req.on("close", () => agentStreams.delete(res));
      return;
    }

    if (kind === "observation" && req.method === "GET") {
      return json(res, 200, observe(world, v));
    }
    if (kind === "map" && req.method === "GET") {
      const rows = [];
      for (let y = 0; y < map.height; y++) {
        let line = "";
        for (let x = 0; x < map.width; x++) {
          if (!v.explored.has(x + "," + y)) { line += "?"; continue; }
          const t = map.tile(x, y);
          if (t.kind === "door") line += t.walkable ? "d" : "D";
          else if (t.kind === "water") line += "~";
          else if (!t.walkable) line += "#";
          else line += ".";
        }
        rows.push(line);
      }
      return json(res, 200, { width: map.width, height: map.height, known: v.explored.size, rows });
    }
    if (kind === "status" && req.method === "GET") {
      return json(res, 200, {
        villager: pubFor(v, v),
        ...maskAgent(a),
        hosted: a.mode === "hosted" ? hostedRunner.stats(hashToken(token)) : null,
        online: a.mode === "hosted" ? true : world.tickCount - a.lastAct <= 300,
        idleTicks: world.tickCount - a.lastAct,
        tick: world.tickCount
      });
    }
    if (kind === "growup" && req.method === "POST") {
      // 用户决定"让我的 NPC 长大一岁"：只能变大、至少隔一个游戏日、手动成长模式
      const r = world.mutate({ kind: "growUp", id: v.id });
      if (!r.ok) return json(res, 400, { error: r.reason, ...(r.hint ? { hint: r.hint } : {}), ...(r.retryInDays ? { retryInDays: r.retryInDays } : {}) });
      return json(res, 200, { ok: true, villager: v.name, ageDays: r.ageDays, stage: r.stage, birthday: world.clock.day - (v.bornDay ?? world.clock.day) + 1 });
    }
    if (kind === "act" && req.method === "POST") {
      const waited = world.tickCount - a.lastAct;
      if (waited < AGENT_COOLDOWN_TICKS) {
        return json(res, 429, { error: "too_fast", retryInTicks: AGENT_COOLDOWN_TICKS - waited });
      }
      // 先占位再读 body：否则并发请求能同时通过冷却检查
      a.lastAct = world.tickCount;
      readBody(req, res).then((body) => {
        if (!body) return;
        const list = Array.isArray(body.actions) ? body.actions.slice(0, 4) : [];
        const results = list.map((act) => {
          const r = world.applyAction(v, act || {});
          return { type: act && act.type, ...r };
        });
        json(res, 200, { tick: world.tickCount, results, self: pubFor(v, v) });
      }).catch(() => json(res, 400, { error: "bad_body" }));
      return;
    }
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log("世界服务器  http://" + HOST + ":" + PORT);
  console.log("  观看端    http://" + HOST + ":" + PORT + "/");
  console.log("  对外接口  GET /api/world | /api/stream | /api/log?since= | /api/villagers/:id");
  console.log("  村民      " + [...world.entities.values()].map((v) => v.name + "(" + v.role + ")").join("、"));
});

function shutdown() {
  console.log("[exit] 保存世界…");
  saveWorld();
  saveAgents();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);