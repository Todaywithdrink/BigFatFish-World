// 本地模型对照测试：同一份提示词、同样参数，读 Ollama 自报的 prefill / decode 耗时。
// 用法: node bench-models.mjs "modelA" "modelB" ...
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const PROMPT = `你在一个像素小镇里生活。当前 tick 8464，第 2 天 14 点，季节 春。

【你的状态】名字 本地鱼，职业 fisher，HP 100/100，饥饿 42，体力 61，位置 (13.5, 61.5)，状态 idle

【周围 11×11 地形】（@ 是你，. 可走，# 挡路，~ 水，D 关门，d 开门，? 看不见）
...........
...........
...#...#...
...........
....@......
...........
...........
...........
...........
...........
...........

【身边的人】没看到别人
【最近发生】无
【广场留言】无
【在办的玩法】无
【未了结的约定】无

【可选动作】move, forage, eat, cook, rest, say, give, trade, build, fish, chop, mine, plant, water, harvest, sleep, sit, read, write, post

请只输出一个 JSON，不要解释、不要代码块标记，格式：
{"why":"一句话理由","actions":[{"type":"动作名","参数":"值"}]}

要求：
- 最多 2 个动作，按顺序执行；动作名必须来自上面的可选动作。
- 参数按动作语义给，例如 move 需要 dir(n/s/e/w) 和 tiles(1-8)；say 需要 text。
- 优先满足生存需求（饥饿/体力），其次社交或探索。`;

const SYSTEM = '你是像素小镇里的居民，说话简短，只输出 JSON。';

function parseJson(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(cleaned.slice(s, e + 1)); } catch { return null; }
}

async function run(model) {
  const body = {
    model, stream: false, think: false,
    options: { temperature: 0.8, num_ctx: 4096, num_predict: 220 },
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: PROMPT }],
  };

  // 预热：让模型先进显存，把加载时间与被测耗时分开
  const t0 = Date.now();
  await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, options: { ...body.options, num_predict: 1 } }) }).catch(() => null);
  const loadMs = Date.now() - t0;

  const t1 = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const wallMs = Date.now() - t1;
  const j = await res.json();
  const txt = j.message?.content || '';
  const parsed = parseJson(txt);

  const ms = (n) => (n ? Math.round(n / 1e6) + 'ms' : '-');
  const tps = j.eval_count && j.eval_duration ? (j.eval_count / (j.eval_duration / 1e9)).toFixed(1) : '-';
  console.log(`\n=== ${model} ===`);
  console.log(`  冷加载(预热轮): ${loadMs}ms   被测轮墙钟: ${wallMs}ms`);
  console.log(`  prefill ${j.prompt_eval_count || 0} tok / ${ms(j.prompt_eval_duration)}   decode ${j.eval_count || 0} tok / ${ms(j.eval_duration)}  → ${tps} tok/s`);
  console.log(`  JSON 合法: ${parsed ? 'YES' : 'NO'}  ${parsed ? '| why=' + JSON.stringify(parsed.why) + ' | actions=' + JSON.stringify(parsed.actions) : '| 原始输出前 160 字: ' + txt.slice(0, 160).replace(/\n/g, ' ')}`);
}

const models = process.argv.slice(2);
if (!models.length) { console.log('用法: node bench-models.mjs 模型1 模型2'); process.exit(1); }
for (const m of models) { try { await run(m); } catch (err) { console.log(`\n=== ${m} ===\n  失败: ${err.message}`); } }
