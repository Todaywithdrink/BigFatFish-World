'use strict';

// 正常打开时：/?token=xxx 会被服务端换成 HttpOnly cookie 并重定向到 /，
// 所以地址栏和历史里都不含令牌；下面的 TOKEN 只在自动化/兼容场景才会非空。
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const DEMO = location.protocol === 'file:';   // 直接打开静态 HTML（预览面板）时只展示骨架
const $ = (sel) => document.querySelector(sel);
let dirty = false;
let toastTimer = null;
let brainData = null;

async function api(path, options = {}) {
  if (DEMO) throw new Error('预览模式：请双击「启动器.bat」后再操作');
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (TOKEN) headers['x-launcher-token'] = TOKEN;
  const res = await fetch(path, { ...options, headers });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (res.status === 403) throw new Error('会话已失效，请重新双击「启动器.bat」打开');
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}
function metric(k, v, dim = false) {
  return `<div class="metric"><span class="k">${k}</span><span class="v${dim ? ' dim' : ''}">${v}</span></div>`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function showResult(text) {
  const el = $('#brain-result');
  el.textContent = text || '（无输出）';
  el.hidden = false;
}
async function withBusy(btn, text, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = text;
  try { await fn(); }
  finally { btn.disabled = false; btn.textContent = original; }
}

// ---------- 顶部状态 ----------
async function loadStatus(setInput = false) {
  try {
    const s = await api('/api/status');
    $('#node-pill').textContent = `Node ${s.node}`;
    $('#footer-path').textContent = s.here;
    if (setInput || !dirty) $('#base').value = s.baseUrl;
    if (setInput) $('#openmode').value = s.openMode || 'tab';

    const badge = $('#cloud-badge');
    if (s.cloud.ok) {
      badge.className = 'badge ok';
      badge.textContent = `在线 · ${s.cloud.ms}ms`;
    } else {
      badge.className = 'badge off';
      badge.textContent = '离线';
    }

    $('#metrics').innerHTML = [
      metric('延迟', s.cloud.ok ? `${s.cloud.ms} ms` : '—', !s.cloud.ok),
      metric('tick', s.cloud.ok ? (s.cloud.tick ?? '—') : '—', !s.cloud.ok),
      metric('村民', s.cloud.ok ? (s.cloud.villagers ?? '—') : '—', !s.cloud.ok),
      metric('浏览器', s.browser || '未找到', !s.browser),
      metric('Electron', s.electron ? '已安装' : '未安装', !s.electron),
      metric('本地内核', s.localWorld ? '可用' : '不可用', !s.localWorld),
    ].join('');

    const hint = $('#cloud-hint');
    if (s.cloud.ok) {
      hint.className = 'hint';
      hint.textContent = `世界已连接 ${s.baseUrl}；观测窗页面内部会自行消费 SSE 增量流。`;
    } else {
      hint.className = 'hint warn';
      hint.textContent = `连不上 ${s.baseUrl}（${esc(s.cloud.error || '未知原因')}）。这不代表启动器坏了：可改地址，或用「本地世界」离线运行。`;
    }
  } catch (err) {
    toast(`读取状态失败：${err.message}`, 'err');
  }
}

// ---------- 自检 / 日志 ----------
function renderCheck(data) {
  const core = data.items.filter((i) => i.level === 'core');
  const feature = data.items.filter((i) => i.level === 'feature');
  const row = (i) => `<div class="check-item"><span class="dot ${i.ok ? 'ok' : 'bad'}"></span><span class="name">${esc(i.label)}</span><span class="detail">${esc(i.detail)}</span></div>`;
  $('#check-list').innerHTML =
    `<div class="check-group">核心（阻断级）</div>${core.map(row).join('')}` +
    `<div class="check-group">功能（降级不阻断）</div>${feature.map(row).join('')}`;
  const sum = $('#check-summary');
  if (data.fails) {
    sum.textContent = `${data.fails} 项阻断`;
    sum.style.color = 'var(--err)';
  } else if (data.warns) {
    sum.textContent = `核心通过 · ${data.warns} 项降级`;
    sum.style.color = 'var(--warn)';
  } else {
    sum.textContent = '全部通过';
    sum.style.color = 'var(--ok)';
  }
}
async function loadCheck() {
  try { renderCheck(await api('/api/check')); }
  catch (err) { toast(`自检失败：${err.message}`, 'err'); }
}
async function loadLogs() {
  try {
    const data = await api('/api/logs');
    const el = $('#logs');
    el.textContent = data.lines.length ? data.lines.join('\n') : '暂无日志';
    el.scrollTop = el.scrollHeight;
  } catch (err) { $('#logs').textContent = `读取日志失败：${err.message}`; }
}

// ---------- 本地大脑 ----------
function renderBrain(b) {
  brainData = b;
  const badge = $('#brain-badge');
  if (b.ready) { badge.className = 'badge ok'; badge.textContent = '配置完成 · 可启动'; }
  else { badge.className = 'badge off'; badge.textContent = `还差 ${b.missing} 项`; }
  const optionalLeft = b.checks.filter((c) => c.optional && !c.ok).length;
  $('#brain-missing').textContent = b.ready
    ? (optionalLeft ? `必需项全部通过 · ${optionalLeft} 项可选待确认` : '全部通过')
    : `${b.missing} 项必需配置未完成`;

  const row = (i) => `<div class="check-item${i.optional ? ' opt' : ''}">
    <span class="dot ${i.ok ? 'ok' : 'bad'}"></span>
    <span class="name">${esc(i.title)}</span>
    <span class="detail">${esc(i.detail)}</span>
    <span class="how">怎么办：${esc(i.how)}</span>
  </div>`;
  $('#brain-checks').innerHTML = b.checks.map(row).join('');

  $('#brain-identity').textContent = b.identity
    ? `当前身份：${b.identity.name || '未命名'}（${b.identity.villagerId}）· token ${b.identity.tokenMask} · 备用邀请码 ${b.invites.count} 个`
    : `当前身份：还没有村民 · 备用邀请码 ${b.invites.count} 个`;
  const src = b.sources || {};
  $('#brain-sources').textContent = `来源：模型服务 ${src.provider || '—'} / Key ${src.apiKey || '—'} / 模型 ${src.model || '—'}${b.hasApiKey ? '（Key 已存，不回显）' : ''}`;
  $('#brain-ready-text').textContent = b.ready
    ? '必需项都通过了。点「启动本地大脑」即可常驻运行，随时可以停止。'
    : `体检还有 ${b.missing} 项必需配置未完成：${b.checks.filter((c) => !c.ok && !c.optional).map((c) => c.title.replace(/^\d+\s·\s/, '')).join('、')}。可以先点「检测全部」看详情；仍然可以启动，但日志里会报错。`;
  $('#btn-brain-stop').disabled = !b.process.running;
  $('#btn-brain-stop').textContent = b.process.running ? `停止进程（pid ${b.process.pid}）` : '停止进程';
  $('#brain-log').textContent = b.logTail.length ? b.logTail.join('\n') : '暂无本地大脑日志（启动后这里会显示每轮决策结果）';
  $('#brain-log').scrollTop = $('#brain-log').scrollHeight;
}
async function loadBrain() {
  try { renderBrain(await api('/api/brain')); }
  catch (err) { toast(`读取本地大脑状态失败：${err.message}`, 'err'); }
}
async function loadBrainLog() {
  try {
    const d = await api('/api/brain/log');
    $('#brain-log').textContent = d.lines.length ? d.lines.join('\n') : '暂无本地大脑日志';
  } catch (err) { toast(`读取日志失败：${err.message}`, 'err'); }
}
function brainFields() {
  return {
    cloud: $('#f-cloud').value.trim(),
    provider: $('#f-provider').value,
    ollamaUrl: $('#f-ollama-url').value.trim(),
    openaiBaseUrl: $('#f-openai-base').value.trim(),
    apiKey: $('#f-api-key').value.trim(),
    model: $('#f-model').value.trim(),
  };
}
async function saveFields(fields, invite, msg) {
  const r = await api('/api/brain/save', { method: 'POST', body: JSON.stringify({ fields, invite }) });
  toast(msg || (r.changed.length ? `已保存：${r.changed.join('、')}` : '没有改动（所有输入框都是空的）'), r.changed.length ? 'ok' : '');
  await loadBrain();
  await loadLogs();
  return r;
}
async function runProbe(fields) {
  const r = await api('/api/brain/probe', { method: 'POST', body: JSON.stringify(fields || {}) });
  const lines = r.items.map((i) => `[${i.ok ? '通过' : '未通过'}] ${i.detail}`);
  if (r.models.length) lines.push('', `可用模型（${r.models.length}）：${r.models.slice(0, 12).join('、')}`);
  showResult(lines.join('\n'));
  toast(r.items.every((i) => i.ok) ? '检测全部通过' : '检测完成，有未通过项，请看结果', r.items.every((i) => i.ok) ? 'ok' : '');
  await loadBrain();
  return r;
}
function syncProviderFields() {
  const p = $('#f-provider').value;
  $('#f-ollama-url').style.display = p === 'openai' ? 'none' : 'block';
  $('#f-openai-base').style.display = p === 'openai' ? 'block' : 'none';
  $('#f-api-key').style.display = p === 'openai' ? 'block' : 'none';
}

// ---------- 事件 ----------
$('#base').addEventListener('input', () => { dirty = true; });
$('#base').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-save').click(); });

$('#btn-save').addEventListener('click', (btn) => withBusy(btn.target, '保存中…', async () => {
  const baseUrl = $('#base').value.trim();
  if (!baseUrl) { toast('地址不能为空', 'err'); return; }
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ baseUrl }) });
    dirty = false;
    toast(`已保存 ${r.baseUrl}，正在重新探测`, 'ok');
    await loadStatus(true);
    await loadLogs();
    await loadBrain();
  } catch (err) { toast(`保存失败：${err.message}`, 'err'); }
}));
$('#btn-probe').addEventListener('click', (e) => withBusy(e.target, '探测中…', async () => { await loadStatus(false); toast('探测完成'); }));
$('#openmode').addEventListener('change', async (e) => {
  const openMode = e.target.value;
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ openMode }) });
    $('#openmode-hint').textContent = openMode === 'tab'
      ? '已保存：下次启动用系统默认浏览器的普通标签页，不会新建 profile、不会重启插件。'
      : openMode === 'app'
        ? '已保存：下次启动用独立无边框窗口（干净实例，不加载日常扩展）。'
        : '已保存：下次启动只打印地址，不自动打开浏览器。';
    toast('打开方式已保存，下次启动生效', 'ok');
    await loadLogs();
  } catch (err) { toast(`保存失败：${err.message}`, 'err'); }
});

document.querySelectorAll('.mode').forEach((card) => {
  const btn = card.querySelector('.btn.go');
  btn.addEventListener('click', () => withBusy(btn, '启动中…', async () => {
    try {
      const r = await api('/api/action', { method: 'POST', body: JSON.stringify({ mode: card.dataset.mode }) });
      toast(r.message, r.ok ? 'ok' : 'err');
      await loadLogs();
      if (card.dataset.mode === 'brain') await loadBrain();
    } catch (err) { toast(`启动失败：${err.message}`, 'err'); }
  }));
});

$('#btn-check').addEventListener('click', (e) => withBusy(e.target, '检查中…', async () => { await loadCheck(); }));
$('#btn-logs').addEventListener('click', async () => { await loadLogs(); });
$('#btn-repair').addEventListener('click', (e) => withBusy(e.target, '修复中…', async () => {
  try {
    const r = await api('/api/action', { method: 'POST', body: JSON.stringify({ mode: 'repair' }) });
    toast(r.message, r.ok ? 'ok' : 'err');
    await loadCheck();
    await loadLogs();
  } catch (err) { toast(`修复失败：${err.message}`, 'err'); }
}));

$('#btn-brain-refresh').addEventListener('click', (e) => withBusy(e.target, '刷新中…', async () => { await loadBrain(); toast('状态已刷新'); }));
$('#btn-brain-log').addEventListener('click', async () => { await loadBrainLog(); });
$('#btn-brain-stop').addEventListener('click', (e) => withBusy(e.target, '停止中…', async () => {
  try {
    const r = await api('/api/brain/stop', { method: 'POST' });
    toast(r.message, r.ok ? 'ok' : 'err');
    await loadBrain(); await loadLogs();
  } catch (err) { toast(`停止失败：${err.message}`, 'err'); }
}));

$('#btn-step1-save').addEventListener('click', (e) => withBusy(e.target, '保存中…', async () => {
  try { await saveFields({ cloud: $('#f-cloud').value.trim() }, undefined, $('#f-cloud').value.trim() ? '世界地址已保存' : '已清除，改为跟随上方「世界连接」的地址'); }
  catch (err) { toast(`保存失败：${err.message}`, 'err'); }
}));
$('#btn-step1-check').addEventListener('click', (e) => withBusy(e.target, '检测中…', async () => {
  try { await runProbe({ cloud: $('#f-cloud').value.trim() }); }
  catch (err) { toast(`检测失败：${err.message}`, 'err'); }
}));

$('#btn-copy-invite').addEventListener('click', async () => {
  const cmd = 'node tools/invite.mjs new "名字" 50 720';
  try { await navigator.clipboard.writeText(cmd); toast('命令已复制，到世界服务器的 sim/ 目录执行', 'ok'); }
  catch { toast(`手动复制：${cmd}`); }
});
$('#btn-step2-save').addEventListener('click', (e) => withBusy(e.target, '保存中…', async () => {
  const code = $('#f-invite').value.trim();
  if (!code) { toast('先填入邀请码', 'err'); return; }
  try { await saveFields({}, code, '邀请码已加入本机邀请码池（还未注册）'); }
  catch (err) { toast(`保存失败：${err.message}`, 'err'); }
}));
$('#btn-step2-register').addEventListener('click', (e) => withBusy(e.target, '领取中…', async () => {
  try {
    const r = await api('/api/brain/register', { method: 'POST', body: JSON.stringify({ invite: $('#f-invite').value.trim() }) });
    showResult(r.output);
    toast(r.ok ? '领取成功，村民身份已写入本机' : '领取失败，请看下方输出', r.ok ? 'ok' : 'err');
    await loadBrain(); await loadLogs();
  } catch (err) { toast(`领取失败：${err.message}`, 'err'); }
}));

$('#f-provider').addEventListener('change', syncProviderFields);
$('#btn-step3-save').addEventListener('click', (e) => withBusy(e.target, '保存中…', async () => {
  try { await saveFields(brainFields()); }
  catch (err) { toast(`保存失败：${err.message}`, 'err'); }
}));
$('#btn-step3-check').addEventListener('click', (e) => withBusy(e.target, '检测中…', async () => {
  try { await runProbe(brainFields()); }
  catch (err) { toast(`检测失败：${err.message}`, 'err'); }
}));

$('#btn-brain-probe').addEventListener('click', (e) => withBusy(e.target, '检测中…', async () => {
  try { await runProbe(brainFields()); }
  catch (err) { toast(`检测失败：${err.message}`, 'err'); }
}));
$('#btn-brain-start').addEventListener('click', (e) => withBusy(e.target, '启动中…', async () => {
  try {
    const r = await api('/api/action', { method: 'POST', body: JSON.stringify({ mode: 'brain' }) });
    toast(r.message, r.ok ? 'ok' : 'err');
    await loadBrain(); await loadLogs();
  } catch (err) { toast(`启动失败：${err.message}`, 'err'); }
}));

$('#btn-exit').addEventListener('click', async () => {
  try { await api('/api/shutdown', { method: 'POST' }); } catch { /* 服务可能已退出 */ }
  $('#closed').hidden = false;
  try { window.close(); } catch { /* 普通标签页可能不允许脚本关窗，遮罩已给出提示 */ }
});

if (DEMO) {
  $('#node-pill').textContent = '预览模式';
  $('#cloud-badge').textContent = '未连接启动器';
  $('#base').value = 'http://127.0.0.1:8090';
  $('#metrics').innerHTML = [
    metric('延迟', '—', true), metric('tick', '—', true), metric('村民', '—', true),
    metric('浏览器', '待检测', true), metric('Electron', '待检测', true), metric('本地内核', '待检测', true),
  ].join('');
  $('#cloud-hint').textContent = '这是静态预览。双击「启动器.bat」启动本机服务后，这里会显示实时状态与可用操作。';
  $('#check-summary').textContent = '未连接';
  $('#check-list').innerHTML = '<div class="check-item"><span class="dot bad"></span><span class="name">启动器服务</span><span class="detail">未连接，请双击「启动器.bat」</span></div>';
  $('#logs').textContent = '预览模式：暂无运行日志。';
  $('#footer-path').textContent = 'client/launcher-ui';
  $('#brain-badge').textContent = '未连接';
  $('#brain-missing').textContent = '需要启动器服务';
  $('#brain-checks').innerHTML = '<div class="check-item"><span class="dot bad"></span><span class="name">配置体检</span><span class="detail">双击「启动器.bat」后这里会列出 6 项检查与逐项解决办法</span></div>';
  $('#brain-log').textContent = '预览模式：暂无本地大脑日志。';
  $('#brain-identity').textContent = '身份：未连接启动器';
  $('#brain-sources').textContent = '来源：未连接启动器';
  $('#brain-ready-text').textContent = '四步向导：连世界 → 领村民 → 接模型 → 检测并启动。所有值都由你填写。';
  syncProviderFields();
} else {
  // 普通标签页会被浏览器节流定时器，不靠心跳维持服务；这里仍保持状态轮询。
  setInterval(() => { api('/api/heartbeat', { method: 'POST' }).catch(() => {}); }, 20000);
  setInterval(() => { if (!dirty) loadStatus(false); }, 30000);
  syncProviderFields();
  loadStatus(true);
  loadCheck();
  loadLogs();
  loadBrain();
}
