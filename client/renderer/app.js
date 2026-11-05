'use strict';

const el = {
  baseUrl: document.getElementById('baseUrl'),
  hint: document.getElementById('hint'),
  dot: document.getElementById('dot'),
  statusText: document.getElementById('statusText'),
  btnConnect: document.getElementById('btnConnect'),
  btnProbe: document.getElementById('btnProbe'),
  btnPin: document.getElementById('btnPin'),
  btnFull: document.getElementById('btnFull'),
  btnClose: document.getElementById('btnClose'),
  btnClear: document.getElementById('btnClear'),
  observerState: document.getElementById('observerState'),
  logList: document.getElementById('logList'),
  lastBeat: document.getElementById('lastBeat'),
  metrics: {
    latency: document.getElementById('mLatency'),
    tick: document.getElementById('mTick'),
    entities: document.getElementById('mEntities'),
    villagers: document.getElementById('mVillagers'),
    free: document.getElementById('mFree'),
    uptime: document.getElementById('mUptime'),
  },
};

const HEARTBEAT_MS = 3000;
let heartbeatTimer = null;
let observerOpen = false;
let pinned = false;
let lastState = null;
let busy = false;

function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function log(message, kind) {
  const li = document.createElement('li');
  if (kind) li.className = kind;
  const time = document.createElement('time');
  time.textContent = stamp();
  li.appendChild(time);
  li.appendChild(document.createTextNode(message));
  el.logList.appendChild(li);
  while (el.logList.children.length > 120) el.logList.removeChild(el.logList.firstChild);
  el.logList.scrollTop = el.logList.scrollHeight;
}

function setStatus(kind, text) {
  el.dot.className = `dot ${kind}`;
  el.statusText.textContent = text;
}

function fmtUptime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '--';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

function renderMetrics(result) {
  const health = result.health || {};
  const server = result.server || {};

  el.metrics.latency.textContent = Number.isFinite(result.latency) ? result.latency : '--';
  el.metrics.tick.textContent = health.tick ?? server.tick ?? '--';
  el.metrics.entities.textContent = health.entities ?? '--';
  el.metrics.villagers.textContent = server.villagers ?? '--';
  el.metrics.free.textContent = server.freeSlots ?? '--';
  el.metrics.uptime.textContent = fmtUptime(server.uptime);
}

function clearMetrics() {
  Object.values(el.metrics).forEach((node) => {
    node.textContent = '--';
  });
}

async function probe({ silent = false } = {}) {
  if (busy) return null;
  busy = true;
  if (!silent) setStatus('wait', '检测中');

  const result = await window.bfw.probe(el.baseUrl.value);

  busy = false;
  el.lastBeat.textContent = `最近心跳 ${stamp()}`;

  if (result.ok) {
    renderMetrics(result);
    setStatus('ok', `在线 · ${result.latency}ms`);
    el.hint.textContent = `已连通 ${result.baseUrl}｜世界 ${result.server?.map?.width ?? '?'}×${result.server?.map?.height ?? '?'} 格`;
    if (lastState !== 'ok') log(`连通 ${result.baseUrl}（${result.latency}ms）`, 'ok');
    lastState = 'ok';
  } else {
    clearMetrics();
    setStatus('bad', '连接失败');
    el.hint.textContent = result.error ? `失败原因：${result.error}` : '连接失败';
    if (lastState !== 'bad') log(`连接失败：${result.error || '未知错误'}`, 'bad');
    lastState = 'bad';
  }

  return result;
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => probe({ silent: true }), HEARTBEAT_MS);
}

async function connect() {
  const result = await probe();
  if (!result || !result.ok) {
    log('未连通，已取消打开观测窗', 'bad');
    return;
  }
  const opened = await window.bfw.connect(result.baseUrl);
  if (opened.ok) {
    log(`观测窗已打开：${opened.baseUrl}/`, 'ok');
  } else {
    log(`观测窗打开失败：${opened.error}`, 'bad');
  }
}

function applyObserverState(state) {
  observerOpen = Boolean(state.open);
  pinned = Boolean(state.alwaysOnTop);

  el.observerState.textContent = observerOpen
    ? state.fullscreen
      ? '运行中 · 全屏'
      : '运行中'
    : '未打开';
  el.observerState.classList.toggle('on', observerOpen);

  el.btnPin.disabled = !observerOpen;
  el.btnFull.disabled = !observerOpen;
  el.btnClose.disabled = !observerOpen;
  el.btnPin.textContent = pinned ? '取消置顶' : '置顶';
}

el.btnProbe.addEventListener('click', () => probe());

el.btnConnect.addEventListener('click', connect);

el.baseUrl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connect();
});

el.btnPin.addEventListener('click', async () => {
  const next = await window.bfw.togglePin(!pinned);
  log(next ? '观测窗已置顶（可供 OBS 抓取）' : '已取消置顶');
});

el.btnFull.addEventListener('click', () => window.bfw.toggleFullscreen());

el.btnClose.addEventListener('click', () => {
  window.bfw.closeObserver();
  log('观测窗已关闭');
});

el.btnClear.addEventListener('click', () => {
  el.logList.innerHTML = '';
});

window.bfw.onObserverState(applyObserverState);
window.bfw.onReconnect(() => {
  log('收到重新连接指令');
  connect();
});

(async () => {
  const cfg = await window.bfw.getConfig();
  el.baseUrl.value = cfg.baseUrl || 'http://127.0.0.1:8090';
  log('客户端已启动，开始探测世界服务');
  await probe();
  startHeartbeat();
})();
