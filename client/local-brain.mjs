#!/usr/bin/env node
'use strict';

// 本地大脑：把你的本地模型接到世界服务。
//
// 数据流：世界服务（物理/状态） → 本地拉 observation → 本地模型推理 → 本地 POST act
// 算力全部在本地，服务端只负责跑世界规则，不接触你的模型。
//
// 用法：
//   node local-brain.mjs --register --invite DFY-XXXX     首次注册（领一只村民）
//   node local-brain.mjs                                  开始驱动（默认 Ollama）
//   node local-brain.mjs --dry                            只看观察结果，不行动
//   node local-brain.mjs --once                           只跑一轮
//
// 环境变量：
//   CLOUD              服务地址（默认读 config.json）
//   PROVIDER           ollama | openai（默认 ollama）
//   OLLAMA_URL         默认 http://127.0.0.1:11434
//   OPENAI_BASE_URL    默认 https://api.deepseek.com/v1
//   OPENAI_API_KEY     openai 模式必填
//   MODEL              默认 kaelri/qwen3.5-mt:2b（0.6s/轮，实时；qwen3:8b 更聪明但 ~12s/轮）
//   NUM_CTX            Ollama 上下文窗口，默认 2048（小一点更能塞进显存）
//   THINK              qwen3 系列思考模式，默认 0=关（开了会吃光输出额度导致 JSON 截断）
//   INTERVAL_MS        循环间隔，默认 1200

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(HERE, '.local-agent.json');
const CONFIG_PATH = path.join(HERE, 'config.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

const CLOUD = (arg('cloud') || process.env.CLOUD || readConfig().baseUrl || 'http://127.0.0.1:8090').replace(/\/+$/, '');
const PROVIDER = process.env.PROVIDER || 'ollama';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.MODEL || 'kaelri/qwen3.5-mt:2b';
const NUM_CTX = Number(process.env.NUM_CTX || 2048);
const THINK = process.env.THINK === '1';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 1200);
const PERSONA = process.env.PERSONA
  || '你是一条住在河边小镇的鱼，谨慎、务实，先解决饥饿和体力，再考虑社交。';

const COLORS = {
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  cyan: (s) => `\u001b[36m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

async function httpJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// 邀请码池：每行一个码，放在 client/invites.txt。token 失效时自动取码重注册，
// 用废/过期的码会被自动移除。--invite 参数优先级最高。
const INVITE_POOL_PATH = path.join(HERE, 'invites.txt');

function readInvitePool() {
  try {
    return fs.readFileSync(INVITE_POOL_PATH, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function writeInvitePool(pool) {
  try { fs.writeFileSync(INVITE_POOL_PATH, pool.join('\n') + (pool.length ? '\n' : '')); } catch {}
}
function popInvite() {
  const pool = readInvitePool();
  return pool.length ? { code: pool[0], rest: pool.slice(1) } : null;
}

async function register() {
  const name = arg('name') || process.env.NAME || '本地鱼';
  let invite = arg('invite') || process.env.INVITE || '';
  let fromPool = false;
  if (!invite) {
    const p = popInvite();
    if (p) { invite = p.code; fromPool = true; }
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const payload = { mode: 'client', name, persona: PERSONA, playerType: 'player' };
    if (invite) payload.invite = invite;

    const { status, body } = await httpJson(`${CLOUD}/api/agents/register`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (status === 200 && body?.token) {
      const state = {
        cloud: CLOUD,
        token: body.token,
        villagerId: body.villager?.id,
        name: body.villager?.name,
        mode: body.mode,
        registeredAt: new Date().toISOString(),
      };
      saveState(state);
      console.log(COLORS.green('[注册成功]'), `村民 ${state.name} (${state.villagerId}) · 模式 ${state.mode}` + (fromPool ? COLORS.dim('（邀请码池）') : ''));
      console.log(COLORS.dim(`  token 已存 ${STATE_PATH}（本机，勿外传）`));
      return state;
    }

    if (status === 403 && fromPool) {
      // 这个码废了（过期/用完），移除并试下一个
      const pool = readInvitePool();
      if (pool.length && pool[0].toUpperCase() === String(invite).toUpperCase()) {
        writeInvitePool(pool.slice(1));
        console.log(COLORS.yellow(`[邀请码] ${invite} 已失效，移除并换下一个`));
      }
      const next = popInvite();
      if (!next) break;
      invite = next.code;
      continue;
    }

    console.error(COLORS.red(`[注册失败] HTTP ${status}`), body?.error || body?.hint || '', body || '');
    if (body?.error === 'invite_required') {
      console.error(COLORS.dim('  需要邀请码：服务器上 node tools/invite.mjs new "本地鱼" 50 720，把码写进 client/invites.txt'));
    }
    process.exit(1);
  }
  console.error(COLORS.red('[注册失败] 邀请码池已用尽，请补充 client/invites.txt'));
  process.exit(1);
}

// 动作语义表（来自服务端 /api/capabilities，含前置条件——模型不知道这些就会瞎选）
const ACTION_TABLE = `move{dir:n/s/e/w,tiles:1-8} 走路 | rest 原地休息恢复体力 | stop 停下 | face{dir}
forage 身边有树/花草时采集 | chop{x,y} 身边有树时砍 | fish 站在水(~)边钓鱼
cook{recipe} 站在灶台旁+背包有食材 | eat 必须站在灶台旁才能吃 | interact{x,y} 开门/灶台
craft{recipe:板/面包/炖菜/花盆} | build{x,y,kind} 身边空地放置 | sew{hue,pattern,hat}
say{text,to?} 说话 | give{targetId,item,count} 送人 | shareMap{targetId}
post{text} 留言板 | readBoard | postForum{text,replyTo?} | readForum
quote{targetId,side,item,count,price} 报价 | bid=买入 | offer=卖出 | accept/decline{quoteId}
promise{targetId,text,coins?} 许诺 | settle{commitmentId,coins?} 了结
attack{targetId,intensity} | propose{targetId} 求婚 | answerProposal{proposalId,accept}`;

function buildPrompt(obs, lastResults) {
  const self = obs.self || {};
  const needs = self.needs || {};
  const tileLines = (obs.view?.tiles || []).join('\n');
  const legendEntries = Object.entries(obs.view?.legend || {});
  const legend = legendEntries.map(([ch, mean]) => `${ch}=${mean}`).join('，') || '@=你自己，.=可走，#=挡路，~=水，?=看不见';
  const neighbours = (obs.view?.entities || [])
    .slice(0, 6)
    .map((e) => `${e.name}(${e.role || '?'} id=${e.id}) 距离${Math.round(Math.hypot(e.x - self.x, e.y - self.y))}格`)
    .join('；') || '没看到别人';
  const events = (obs.events || []).slice(-6).map((e) => e.type + (e.text ? `：${e.text}` : '')).join('；') || '无';
  const board = (obs.view?.board || []).slice(-3).map((b) => b.text).join(' / ') || '无';
  const inv = (self.inventory || []).map((i) => `${i.name}×${i.count}`).join('、') || '空的';
  const skills = Object.entries(self.skills || {}).filter(([, v]) => v > 0).map(([k, v]) => `${k}${v}`).join(' ') || '无';

  return `你在一个像素小镇里生活。第 ${obs.clock?.day} 天 ${String(obs.clock?.hour).padStart(2, '0')} 点，季节 ${obs.clock?.season}，tick ${obs.tick}。

【你的状态】${self.name}（${self.role}）· HP ${self.hp}/${self.maxHp} · 饥饿 ${needs.hunger ?? '?'}（低于40会饿死，需尽快吃饭）· 体力 ${needs.energy ?? '?'}（低于30要休息）· 心情「${self.mood ?? '?'}」· 当前目标「${self.goal ?? '无'}」· 位置(${self.x},${self.y}) 正在${self.state}
【背包】${inv} · 金币 ${self.coins ?? 0} · 技能 ${skills}

【周围 ${obs.view?.tiles?.length || 11}×${obs.view?.tiles?.[0]?.length || 11} 地形】（${legend}）
${tileLines}

【身边的人】${neighbours}
【最近发生】${events}
【广场留言】${board}
【未了结的约定】${(obs.commitments || []).length ? obs.commitments.length + ' 条' : '无'}
${lastResults ? `【上一轮动作结果】${lastResults}（失败过的动作换个思路，别重复）` : ''}

【动作表】${ACTION_TABLE}

请只输出一个 JSON，不要解释、不要代码块标记：
{"why":"一句话理由","actions":[{"type":"move","dir":"n","tiles":3},{"type":"say","text":"今天钓了不少鱼"}]}

要求：
- 最多 2 个动作，动作名必须来自动作表，参数直接写在动作对象里（不要嵌套在"参数"键里）。
- 注意前置条件：eat/cook 要在灶台旁，fish 要在水边，chop 要身边有树；不满足就先 move 过去或选别的。
- 优先满足生存（饥饿/体力），其次目标、社交、探索。说话要符合人设，简短自然。`;
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function think(prompt) {
  if (PROVIDER === 'openai') {
    if (!OPENAI_API_KEY) throw new Error('openai 模式需要 OPENAI_API_KEY');
    const res = await fetch(`${OPENAI_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: PERSONA },
          { role: 'user', content: prompt },
        ],
        temperature: 0.8,
        max_tokens: 220,
      }),
    });
    if (!res.ok) throw new Error(`模型返回 HTTP ${res.status}`);
    const json = await res.json();
    return json.choices?.[0]?.message?.content || '';
  }

  const res = await fetch(`${OLLAMA_URL.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: THINK,
      options: { temperature: 0.8, num_ctx: NUM_CTX, num_predict: 220 },
      messages: [
        { role: 'system', content: PERSONA },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama 返回 HTTP ${res.status}（模型 ${MODEL} 是否已 pull？）`);
  const json = await res.json();
  return json.message?.content || '';
}

function safeFallback(obs) {
  const dirs = ['n', 's', 'e', 'w'];
  const pick = dirs[Math.floor(Math.random() * dirs.length)];
  const hunger = Number(obs.self?.needs?.hunger ?? 100);
  const energy = Number(obs.self?.needs?.energy ?? 100);
  if (hunger < 35) return { why: '模型不可用，先找吃的', actions: [{ type: 'forage' }] };
  if (energy < 25) return { why: '模型不可用，太累了先休息', actions: [{ type: 'rest' }] };
  return { why: '模型不可用，随便走走', actions: [{ type: 'move', dir: pick, tiles: 2 }] };
}

async function act(token, decision) {
  const actions = (decision.actions || [])
    .filter((a) => a && typeof a.type === 'string')
    .slice(0, 2);
  if (!actions.length) return null;
  const { status, body } = await httpJson(`${CLOUD}/api/agents/${token}/act`, {
    method: 'POST',
    body: JSON.stringify({ actions }),
  });
  return { status, body };
}

async function main() {
  let state = loadState();

  if (flag('register') || !state) {
    if (state && !flag('register')) {
      console.log(COLORS.dim(`使用已有身份：${state.name}（${state.cloud}）`));
    } else {
      if (state?.cloud && state.cloud !== CLOUD) {
        console.error(COLORS.yellow(`[注意] 上次注册在 ${state.cloud}，本次目标是 ${CLOUD}`));
      }
      state = await register();
      if (flag('register') && args.length <= 3) return;
    }
  }

  console.log(COLORS.cyan(`[本地大脑] ${CLOUD} · 村民 ${state.name} · 模型 ${PROVIDER}/${MODEL}`));

  let round = 0;
  let llmDown = false;
  let lastBroken = 0;
  let lastResults = '';

  while (true) {
    round += 1;
    try {
      const { status, body: obs } = await httpJson(`${CLOUD}/api/agents/${state.token}/observation`, {
        method: 'GET',
        headers: { 'x-agent-token': state.token },
      });

      if (status !== 200 || !obs?.self) {
        if (obs?.error === 'unknown_token' || status === 403) {
          // token 失效（停机超 3 分钟被服务端回收）→ 从邀请码池自动重注册
          if (!readInvitePool().length) {
            console.error(COLORS.red('[token 失效]'), '村民已被服务端回收，且邀请码池为空，无法自动重注册');
            console.error(COLORS.dim('  解决：服务器上 node tools/invite.mjs new "本地鱼" 50 720，把码写进 ' + INVITE_POOL_PATH));
            process.exit(1);
          }
          console.log(COLORS.yellow('[token 失效] 从邀请码池自动重注册…'));
          state = await register();
          lastResults = '';
          continue;
        }
        if (Date.now() - lastBroken > 10000) {
          console.error(COLORS.red(`[观察失败] HTTP ${status}`), obs?.error || '');
          lastBroken = Date.now();
        }
        await sleep(INTERVAL_MS * 2);
        continue;
      }

      if (flag('dry')) {
        console.log(`#${round} tick=${obs.tick} ${obs.self.name} (${obs.self.x},${obs.self.y}) 饥饿=${obs.self.needs?.hunger} 体力=${obs.self.needs?.energy} 心境=${obs.self.mood} 目标=${obs.self.goal}`);
        console.log(obs.view.tiles.join('\n'));
        if (flag('once')) return;
        await sleep(INTERVAL_MS);
        continue;
      }

      let decision;
      try {
        const raw = await think(buildPrompt(obs, lastResults));
        decision = extractJson(raw);
        if (!decision) throw new Error('模型输出不是合法 JSON');
        llmDown = false;
      } catch (err) {
        if (!llmDown) console.error(COLORS.yellow(`[本地模型不可用] ${err.message} → 先用兜底动作`));
        llmDown = true;
        decision = safeFallback(obs);
      }

      const result = await act(state.token, decision);
      const results = result?.body?.results || [];
      const okCount = results.filter((r) => r.ok !== false).length;
      lastResults = results.map((r) => r.ok === false ? `${r.type}失败(${r.reason || '未知原因'})` : `${r.type}成功`).join('；');

      console.log(
        `#${round} tick=${result?.body?.tick ?? obs.tick}`,
        COLORS.green(`${okCount}/${results.length} 动作成功`),
        COLORS.dim(decision.why || ''),
      );
      for (const r of results) {
        if (r.ok === false) console.log(COLORS.dim(`   ✗ ${r.type}: ${r.reason || ''}`));
      }

      if (flag('once')) return;
      await sleep(Math.max(500, INTERVAL_MS));
    } catch (err) {
      console.error(COLORS.red(`[循环异常] ${err.message}`));
      await sleep(2000);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error(COLORS.red(`[致命错误] ${err.message}`));
  process.exit(1);
});
