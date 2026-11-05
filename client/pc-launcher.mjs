#!/usr/bin/env node
'use strict';

// 大肥鱼世界 · 统一 PC 启动器
//
// 设计原则：入口 .bat 永远是「纯 ASCII + CRLF + 无 BOM」的转发壳，
// 编码与换行都不再是变量；所有会被反复更新的内容只存在于本文件与 config.json。
// 入口脚本即使被别的工具改坏，本文件启动时也会自动重建（--repair 可手动跑）。
//
// 用法：
//   node pc-launcher.mjs                      可视化启动窗口（默认）
//   node pc-launcher.mjs --mode=gui          可视化启动窗口（--no-open 只起服务）
//   node pc-launcher.mjs --mode=menu         旧式命令行菜单
//   node pc-launcher.mjs --mode=observe      轻量观测窗（零依赖）
//   node pc-launcher.mjs --mode=electron     Electron 控制台
//   node pc-launcher.mjs --mode=brain        本地大脑
//   node pc-launcher.mjs --mode=local        本地世界（离线兜底）
//   node pc-launcher.mjs --check             命令行自检，不启动任何东西
//   node pc-launcher.mjs --repair            重建 / 修复全部启动脚本
//   node pc-launcher.mjs --base=http://x     临时覆盖服务地址
//   node pc-launcher.mjs --yes               非交互，失败直接返回退出码

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CONFIG_PATH = path.join(HERE, 'config.json');
const LOG_DIR = path.join(HERE, 'logs');
const UI_DIR = path.join(HERE, 'launcher-ui');
const DEFAULT_BASE = 'http://127.0.0.1:8090';
const LOCAL_PORT = Number(process.env.WORLD_PORT || 8090);
const GUI_PORT_START = 17890;
const GUI_PORT_TRIES = 12;
// 只有「独立应用窗口」模式才靠心跳判定关闭。普通标签页会被浏览器节流定时器，
// 用心跳自动退出会把后台标签误判成已关闭（这正是网页端体验差的另一个坑）。
const HEARTBEAT_TIMEOUT = 180000;
const DEFAULT_CONFIG = {
  baseUrl: DEFAULT_BASE,
  alwaysOnTop: false,
  observerSize: { width: 1440, height: 900 },
  localWorldDir: '',
  browser: '',
  // tab  = 系统默认浏览器的普通标签页（默认，不碰浏览器参数/profile，插件原样保留）
  // app  = 独立无边框应用窗口（给 OBS 采集；使用独立干净实例，不加载日常扩展）
  // none = 只打印地址，不自动打开
  openMode: 'tab',
};
const BRAIN_STATE_PATH = path.join(HERE, '.local-agent.json');
const BRAIN_SETTINGS_PATH = path.join(HERE, 'brain-settings.json');
const INVITE_POOL_PATH = path.join(HERE, 'invites.txt');
// 只允许向导写入的字段白名单；任何值都必须由用户在页面上填写，不在此处预置默认值。
const BRAIN_FIELDS = ['cloud', 'provider', 'ollamaUrl', 'openaiBaseUrl', 'apiKey', 'model', 'persona', 'intervalMs'];
const running = new Map();   // tag -> { pid, startedAt }：页面可见、可停止、防重复启动

// 所有入口脚本都由这里生成：纯 ASCII 字节在 UTF-8 / GBK / ANSI 下完全一致，
// 因此「保存成什么编码」不再可能破坏启动；CRLF 保证括号块与标签安全。
const SHELLS = [
  { name: '启动器.bat', args: '--mode=gui', pause: 'error' },
  { name: '启动客户端.bat', args: '--mode=observe', pause: 'always' },
  { name: '启动客户端-Electron版.bat', args: '--mode=electron', pause: 'always' },
  { name: '启动本地大脑.bat', args: '--mode=brain', pause: 'always' },
  { name: '验证启动器.bat', args: '--check', pause: 'always' },
];

function shellTemplate(args, pause = 'always') {
  const tail = args ? ` ${args}` : '';
  // GUI 入口是常驻服务：正常退出直接关掉黑窗口，只有出错才 pause 让人看报错。
  const after = pause === 'error'
    ? ['if errorlevel 1 pause', 'exit /b 0']
    : ['echo.', 'pause', 'exit /b 0'];
  return [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'set "ELECTRON_RUN_AS_NODE="',
    'set "NODE_EXE="',
    'where node >nul 2>nul',
    'if not errorlevel 1 set "NODE_EXE=node"',
    'if not defined NODE_EXE if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles%\\nodejs\\node.exe"',
    'if not defined NODE_EXE if exist "%ProgramFiles(x86)%\\nodejs\\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\\nodejs\\node.exe"',
    'if not defined NODE_EXE if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE_EXE=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"',
    'if not defined NODE_EXE goto NONODE',
    `"%NODE_EXE%" pc-launcher.mjs${tail} %*`,
    ...after,
    ':NONODE',
    'echo [ERROR] Node.js not found in PATH or standard install locations.',
    'echo Install Node.js LTS from https://nodejs.org/ then double-click again.',
    'echo Details are written to logs\\launcher-*.log',
    'pause',
    'exit /b 1',
    '',
  ].join('\r\n');
}

const TAGS = { INFO: '[信息]', OK: '[通过]', WARN: '[提醒]', FAIL: '[失败]', TIP: '[建议]' };
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
function log(level, msg, detail) {
  const prefix = TAGS[level] || '[信息]';
  console.log(`${prefix} ${msg}`);
  if (detail) console.log(String(detail).split('\n').map((l) => `       ${l}`).join('\n'));
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = `[${new Date().toISOString()}] ${level} ${msg}${detail ? `\n${detail}` : ''}\n`;
    fs.appendFileSync(path.join(LOG_DIR, `launcher-${stamp()}.log`), line, 'utf8');
  } catch { /* 日志失败不影响启动 */ }
}

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = { mode: '', base: '', yes: false, check: false, repair: false, noOpen: false };
  for (const a of argv) {
    if (a.startsWith('--mode=')) out.mode = a.slice(7);
    else if (a.startsWith('--base=')) out.base = a.slice(7);
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--no-open') out.noOpen = true;
    else if (a === '--check' || a === '--doctor') out.check = true;
    else if (a === '--repair') out.repair = true;
    else if (/^https?:\/\//i.test(a)) out.base = a;
  }
  return out;
}

// ---------- 配置（坏档自动备份 + 重建） ----------
function normalizeBase(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('缺少服务器地址');
  return new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`).origin;
}
function loadConfig() {
  let cfg = null;
  let repaired = false;
  let backup = '';
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是对象');
    cfg = { ...DEFAULT_CONFIG, ...parsed };
    cfg.baseUrl = normalizeBase(cfg.baseUrl);
    if (!cfg.observerSize || typeof cfg.observerSize !== 'object') cfg.observerSize = DEFAULT_CONFIG.observerSize;
  } catch (err) {
    cfg = { ...DEFAULT_CONFIG };
    repaired = true;
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        backup = path.join(LOG_DIR, `config.bad-${Date.now()}.json`);
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.copyFileSync(CONFIG_PATH, backup);
      }
    } catch { /* 备份失败也要继续 */ }
    try {
      fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      log('WARN', `config.json 解析失败（${err.message}），已重建默认配置`, backup ? `原文件备份：${backup}` : '');
    } catch (e) {
      log('FAIL', `config.json 无法写入：${e.message}`);
    }
  }
  return { cfg, repaired, backup };
}

// ---------- 入口脚本自愈 ----------
function auditShell(shell) {
  const { name, args, pause } = shell;
  const file = path.join(HERE, name);
  const expected = shellTemplate(args, pause);
  if (!fs.existsSync(file)) return { name, status: 'missing', reason: '文件不存在' };
  const buf = fs.readFileSync(file);
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  let nonAscii = false;
  for (const byte of buf) if (byte > 0x7f) { nonAscii = true; break; }
  const text = buf.toString('latin1');
  const lfOnly = text.includes('\n') && !text.includes('\r\n');
  if (text === expected) return { name, status: 'ok', reason: '纯 ASCII + CRLF + 无 BOM' };
  const reasons = [];
  if (bom) reasons.push('带 UTF-8 BOM');
  if (nonAscii) reasons.push('含非 ASCII 字符（中文/全角）');
  if (lfOnly) reasons.push('LF 换行（cmd 复合语句易错）');
  if (!reasons.length) reasons.push('内容与标准模板不一致');
  return { name, status: 'drift', reason: reasons.join('、') };
}
function ensureShells(verbose) {
  const results = SHELLS.map(auditShell);
  const fixed = [];
  for (const r of results) {
    if (r.status === 'ok') continue;
    const file = path.join(HERE, r.name);
    const shell = SHELLS.find((s) => s.name === r.name);
    try {
      if (r.status === 'drift') {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.copyFileSync(file, path.join(LOG_DIR, `${r.name.replace(/\.bat$/, '')}.before-${Date.now()}.txt`));
      }
      fs.writeFileSync(file, shellTemplate(shell.args, shell.pause), 'latin1');
      fixed.push(r.name);
    } catch (err) {
      log('FAIL', `重建 ${r.name} 失败：${err.message}`);
    }
  }
  if (verbose) {
    for (const r of results) {
      log(r.status === 'ok' ? 'OK' : 'WARN', `${r.name} — ${r.reason}`);
    }
  }
  if (fixed.length) log('OK', `已自动修复 ${fixed.length} 个入口脚本：${fixed.join('、')}（原文件备份在 logs/）`);
  return SHELLS.map(auditShell);
}

// ---------- 环境探测 ----------
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // smoke.log 里的 TypeError 就是它泄漏导致的
  return env;
}
function getJson(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const mod = target.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = mod.get(target, { headers: { 'user-agent': 'bigfatfish-launcher/2.0' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        try { resolve({ ok: true, data: JSON.parse(body), ms: Date.now() - started }); }
        catch { resolve({ ok: false, error: '响应不是 JSON' }); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('超时')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}
async function probeCloud(base, timeoutMs = 4000) {
  const health = await getJson(new URL('/api/health', base).href, timeoutMs);
  if (!health.ok) return { ok: false, base, error: health.error };
  const server = await getJson(new URL('/api/server', base).href, timeoutMs);
  return {
    ok: true, base, ms: health.ms, tick: health.data?.tick ?? '?',
    villagers: server.ok ? (server.data.villagers ?? '?') : '?',
    map: server.ok ? server.data.map : null,
  };
}
function findBrowser(cfg) {
  if (cfg.browser && fs.existsSync(cfg.browser)) return cfg.browser;
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    la && path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    la && path.join(la, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find((f) => fs.existsSync(f)) || null;
}
function electronExe() {
  const f = path.join(HERE, 'node_modules', 'electron', 'dist', 'electron.exe');
  return fs.existsSync(f) ? f : null;
}
function localWorld() {
  // guesses 里放的是「仓库根」，下面统一检查 <root>/sim/server.mjs。
  // 发布版默认布局即仓库根 = 本文件的上一级，不再依赖任何本机绝对路径。
  const guesses = [
    process.env.WORLD_DIR,
    ROOT,
    path.dirname(HERE),
  ];
  const configured = loadConfigQuiet().localWorldDir;
  if (configured) guesses.unshift(configured);
  for (const dir of guesses.filter(Boolean)) {
    if (fs.existsSync(path.join(dir, 'sim', 'server.mjs'))) {
      return { ok: true, dir, server: path.join(dir, 'sim', 'server.mjs') };
    }
  }
  return { ok: false, dir: guesses.find(Boolean) || '' };
}
function loadConfigQuiet() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
// 用「系统默认浏览器」打开普通标签页：不传 --user-data-dir / --app / --no-first-run，
// 因此不会新建干净 profile，也就不会让扩展重新初始化、弹一次起始页。
function openUrlSystem(url, label) {
  if (!/^https?:\/\/[^\s"&|<>^]+$/.test(url)) {
    log('FAIL', `${label}地址不合法，未打开浏览器`);
    return false;
  }
  const spawnOpts = { detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnv() };
  try {
    if (process.platform === 'win32') {
      const comspec = process.env.ComSpec || 'cmd.exe';
      // windowsVerbatimArguments：由我们自己拼好命令行，避免 Node 对含空格参数二次加引号，
      // 让 cmd 的 start 内建命令拿到「空标题 + URL」两个参数。
      const child = spawn(comspec, [`/d /c start "" "${url}"`], {
        ...spawnOpts, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-500); });
      child.on('exit', (code) => {
        if (code === 0 && !stderr.trim()) return;
        log('WARN', `默认浏览器调用异常（exit ${code} ${stderr.trim()}），改用系统文件关联`);
        try {
          const fb = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], spawnOpts);
          fb.on('error', (e2) => log('WARN', `文件关联也失败：${e2.message}`));
          fb.unref();
        } catch { /* 控制台已打印完整地址供手动打开 */ }
      });
      child.on('error', (e) => log('WARN', `默认浏览器调用失败：${e.message}；控制台已打印完整地址`));
      child.unref();
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(cmd, [url], spawnOpts);
      child.on('error', () => log('WARN', `无法调用 ${cmd}，请手动打开下面的地址`));
      child.unref();
    }
    log('OK', `${label}已交给系统默认浏览器（普通标签页，不新建浏览器 profile）`);
    return true;
  } catch (err) {
    log('WARN', `打开浏览器失败：${err.message}，请手动打开 ${url}`);
    return false;
  }
}

function openBrowser(cfg, url, label) {
  const mode = String(cfg.openMode || 'tab').toLowerCase();
  if (mode === 'none') {
    log('INFO', `${label}未自动打开（openMode=none），地址：${url}`);
    return true;
  }
  if (mode === 'tab') return openUrlSystem(url, label);

  // app 模式：独立无边框窗口，供 OBS 窗口采集。共用同一个 profile，避免开两个浏览器实例；
  // 这个实例是干净的，不会加载用户日常扩展——这是刻意行为，日志里说清楚。
  const browser = findBrowser(cfg);
  if (!browser) {
    log('WARN', '没有找到 Edge / Chrome，请手动打开下面的地址');
    console.log(`       ${url}`);
    return false;
  }
  const size = cfg.observerSize || DEFAULT_CONFIG.observerSize;
  const profile = path.join(process.env.LOCALAPPDATA || HERE, 'bigfatfish-app');
  try {
    const child = spawn(browser, [
      `--app=${url}`,
      `--window-size=${size.width},${size.height}`,
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    ], { detached: true, stdio: 'ignore', env: cleanEnv() });
    child.unref();
  } catch (err) {
    log('WARN', `应用窗口启动失败：${err.message}，请手动打开 ${url}`);
    return false;
  }
  log('OK', `${label}已打开（独立无边框窗口；此实例为干净 profile，不加载日常扩展）`);
  return true;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- 各模式 ----------
async function runObserve(cfg, opts) {
  const base = opts.base ? normalizeBase(opts.base) : cfg.baseUrl;
  const probe = await probeCloud(base);
  if (probe.ok) {
    log('OK', `服务在线 ${base} · 延迟 ${probe.ms}ms · tick ${probe.tick} · 村民 ${probe.villagers}`);
    return openBrowser(cfg, `${base}/`, '观测窗') ? 0 : 1;
  }
  log('WARN', `服务暂时连不上 ${base} —— ${probe.error}`);
  log('TIP', '这不代表启动器坏了：可能是实例停机、防火墙或本机网络代理。');
  if (opts.yes || !process.stdin.isTTY) return 2;
  const choice = await ask([
    '  选一个：',
    '   [1] 重试一次',
    '   [2] 换一个服务器地址',
    '   [3] 启动本地世界（离线自己跑一个）',
    '   [4] 仍然用浏览器打开（可能白屏）',
    '   [0] 退出',
    '  请输入：',
  ].join('\n'), '0');
  if (choice === '1') return runObserve(cfg, { ...opts, yes: true });
  if (choice === '2') {
    const next = await ask('  新地址（例 http://127.0.0.1:8090）：', '');
    if (!next) return 2;
    try { return runObserve(cfg, { ...opts, base: normalizeBase(next) }); }
    catch (e) { log('FAIL', `地址不合法：${e.message}`); return 2; }
  }
  if (choice === '3') return runLocal(cfg, opts);
  if (choice === '4') return openBrowser(cfg, `${base}/`, '观测窗') ? 0 : 1;
  return 2;
}

async function runElectron(cfg, opts) {
  const exe = electronExe();
  if (!exe) {
    log('WARN', 'Electron 未安装（node_modules/electron/dist/electron.exe 不存在）');
    log('TIP', '可先在此目录执行 npm install，或改用「启动客户端.bat」零依赖版。');
    if (opts.yes || !process.stdin.isTTY) return 3;
    const c = await ask('  现在执行 npm install 吗？[y/N]：', 'n');
    if (c.toLowerCase() !== 'y') return 3;
    // 便携版 Node 可能不带 npm-cli.js，退回 PATH 里的 npm.cmd
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const code = fs.existsSync(cli)
      ? await runChild(process.execPath, [cli, 'install'], HERE)
      : await runChild('npm.cmd', ['install'], HERE, true);
    if (code !== 0 || !electronExe()) { log('FAIL', '安装未完成'); return 3; }
  }
  log('INFO', '启动 Electron 控制台（环境已清除 ELECTRON_RUN_AS_NODE）');
  const code = await runChild(electronExe(), ['.'], HERE);
  return code === 0 ? 0 : code;
}

async function runBrain(cfg, opts) {
  const script = path.join(HERE, 'local-brain.mjs');
  if (!fs.existsSync(script)) { log('FAIL', 'local-brain.mjs 不存在'); return 4; }
  log('INFO', '启动本地大脑（Ctrl+C 或关窗口即停止）');
  return runChild(process.execPath, [script], HERE);
}

async function runLocal(cfg, opts) {
  const world = localWorld();
  if (!world.ok) {
    log('FAIL', '没找到本地世界内核 sim/server.mjs');
    log('TIP', `可在 config.json 里设置 localWorldDir（当前探测过：${world.dir}）`);
    return 5;
  }
  const localBase = `http://127.0.0.1:${LOCAL_PORT}`;
  const alive = await probeCloud(localBase, 1200);
  if (!alive.ok) {
    log('INFO', `启动本地世界：${world.server}`);
    const child = spawn(process.execPath, [world.server], {
      cwd: path.dirname(world.server), detached: true, stdio: 'ignore',
      env: { ...cleanEnv(), HOST: '127.0.0.1', PORT: String(LOCAL_PORT) },
    });
    child.unref();
    let ready = false;
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      if ((await probeCloud(localBase, 800)).ok) { ready = true; break; }
    }
    if (!ready) { log('FAIL', '本地世界 7.5 秒内未就绪，详情看 logs/'); return 5; }
  }
  log('OK', `本地世界在线 ${localBase}`);
  return openBrowser(cfg, `${localBase}/`, '本地观测窗') ? 0 : 1;
}

function runChild(exe, args, cwd, shell = false) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, stdio: 'inherit', env: cleanEnv(), shell });
    child.on('error', (e) => { log('FAIL', `进程启动失败：${e.message}`); resolve(1); });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

function ask(question, fallback) {
  if (!process.stdin.isTTY) return Promise.resolve(fallback);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => {
    rl.close();
    resolve(String(a).trim() || fallback);
  }));
}

// ---------- 自检 ----------
async function runCheck(cfg, opts) {
  log('INFO', `自检开始 · Node ${process.version} · ${HERE}`);
  let fails = 0;   // 阻断级：入口本身起不来
  let warns = 0;   // 功能级：只影响某一个模式，不阻断其它模式

  const shells = ensureShells(true);
  for (const s of shells) if (s.status !== 'ok') { fails++; log('FAIL', `${s.name} 修复后仍异常`); }

  for (const f of ['pc-launcher.mjs', 'config.json']) {
    if (fs.existsSync(path.join(HERE, f))) log('OK', `核心文件 ${f}`);
    else { fails++; log('FAIL', `缺少核心文件 ${f}`); }
  }

  // 各模式单独体检：某个组件被更新改坏，只让那一个模式降级，不拖垮整个入口。
  const modes = [
    { name: '轻量观测(1)', files: [] },
    { name: 'Electron(2)', files: ['main.js', 'preload.js', path.join('renderer', 'index.html')] },
    { name: '本地大脑(3)', files: ['local-brain.mjs'] },
    { name: '本地世界(4)', files: [] },
  ];
  for (const m of modes) {
    const missing = m.files.filter((f) => !fs.existsSync(path.join(HERE, f)));
    if (missing.length) { warns++; log('WARN', `模式 ${m.name} 缺文件：${missing.join('、')}（其它模式不受影响）`); }
    else log('OK', `模式 ${m.name} 文件齐备`);
  }
  const legacy = 'launcher.mjs';
  if (fs.existsSync(path.join(HERE, legacy))) log('OK', `旧 CLI ${legacy} 可用（CLI 兼容，双击入口不依赖它）`);
  else log('WARN', `旧 CLI ${legacy} 不存在（仅影响命令行手动调用）`);

  if (electronExe()) log('OK', 'Electron 已安装');
  else { warns++; log('WARN', 'Electron 未安装（只影响模式 2，模式 1 零依赖不受影响）'); }
  if (findBrowser(cfg)) log('OK', `浏览器 ${path.basename(findBrowser(cfg))}`);
  else { warns++; log('WARN', '没找到 Edge / Chrome，观测窗无法以应用模式打开（可手动开浏览器）'); }
  const world = localWorld();
  if (world.ok) log('OK', `本地世界内核 ${world.dir}`);
  else { warns++; log('WARN', '本地世界内核不可用（只影响离线模式 4）'); }

  const probe = await probeCloud(opts.base || cfg.baseUrl);
  if (probe.ok) log('OK', `服务在线 ${probe.base} · ${probe.ms}ms · tick ${probe.tick}`);
  else { warns++; log('WARN', `服务离线 ${probe.base} · ${probe.error}（不算启动器故障，可用模式 4 离线运行）`); }

  console.log('');
  if (fails) log('FAIL', `启动器自检：${fails} 项阻断问题，入口可能无法启动`);
  else if (warns) log('OK', `启动器自检：核心通过，入口可以启动；${warns} 项功能降级（见上方提醒）`);
  else log('OK', '启动器自检：全部通过，双击「启动器.bat」即可使用');
  log('INFO', `日志：${path.join(LOG_DIR, `launcher-${stamp()}.log`)}`);
  return fails ? 1 : 0;
}

// ---------- 菜单 ----------
async function runMenu(cfg, opts) {
  const base = opts.base || cfg.baseUrl;
  const cloud = await probeCloud(base, 2500);
  const world = localWorld();
  console.log('');
  console.log('  ============================================');
  console.log('     大肥鱼世界 · PC 启动器');
  console.log('  ============================================');
  console.log(`  服务      ${base}  ${cloud.ok ? `在线 ${cloud.ms}ms / tick ${cloud.tick}` : '离线'}`);
  console.log(`  本地世界  ${world.ok ? '可用' : '不可用（可在 config.json 设 localWorldDir）'}`);
  console.log('');
  console.log('   [1] 轻量观测窗   零依赖，Edge/Chrome 应用模式（推荐）');
  console.log('   [2] Electron     控制台 + 观测窗，可置顶给 OBS');
  console.log('   [3] 本地大脑     用本机模型驱动世界里的村民');
  console.log('   [4] 本地世界     离线自己跑一个世界');
  console.log('   [0] 自检 / 诊断  检查启动器与依赖');
  console.log('   [q] 退出');
  console.log('');
  const choice = opts.yes ? '1' : await ask('  请输入：', 'q');
  switch (choice.toLowerCase()) {
    case '1': return runObserve(cfg, opts);
    case '2': return runElectron(cfg, opts);
    case '3': return runBrain(cfg, opts);
    case '4': return runLocal(cfg, opts);
    case '0': return runCheck(cfg, opts);
    default: return 0;
  }
}

// ---------- 可视化启动窗口（本地服务 + 静态页面） ----------
async function collectCheck(cfg) {
  const items = [];
  for (const s of ensureShells(false)) {
    items.push({ level: 'core', ok: s.status === 'ok', label: s.name, detail: s.reason });
  }
  for (const f of ['pc-launcher.mjs', 'config.json', path.join('launcher-ui', 'index.html')]) {
    const ok = fs.existsSync(path.join(HERE, f));
    items.push({ level: 'core', ok, label: f, detail: ok ? '存在' : '文件缺失' });
  }
  const modes = [
    { label: '轻量观测(1)', files: [] },
    { label: 'Electron(2)', files: ['main.js', 'preload.js', path.join('renderer', 'index.html')] },
    { label: '本地大脑(3)', files: ['local-brain.mjs'] },
    { label: '本地世界(4)', files: [] },
  ];
  for (const m of modes) {
    const missing = m.files.filter((f) => !fs.existsSync(path.join(HERE, f)));
    items.push({ level: 'feature', ok: !missing.length, label: `模式 ${m.label}`, detail: missing.length ? `缺 ${missing.join('、')}` : '文件齐备' });
  }
  const pairs = [
    ['浏览器', findBrowser(cfg) ? path.basename(findBrowser(cfg)) : null],
    ['Electron', electronExe() ? '已安装' : null],
    ['本地内核', localWorld().ok ? localWorld().dir : null],
  ];
  for (const [label, value] of pairs) {
    items.push({ level: 'feature', ok: !!value, label, detail: value || '不可用（只影响对应模式）' });
  }
  const probe = await probeCloud(cfg.baseUrl, 3000);
  items.push({
    level: 'feature', ok: probe.ok, label: '服务连接',
    detail: probe.ok ? `${probe.base} · ${probe.ms}ms` : `${probe.error || '不可达'} · 可用「本地世界」离线运行`,
  });
  return { items, fails: items.filter((i) => i.level === 'core' && !i.ok).length, warns: items.filter((i) => i.level === 'feature' && !i.ok).length };
}

async function collectStatus(cfg, base) {
  const cloud = await probeCloud(base || cfg.baseUrl, 3500);
  const world = localWorld();
  return {
    node: process.version,
    here: HERE,
    baseUrl: base || cfg.baseUrl,
    cloud: { ok: cloud.ok, ms: cloud.ms ?? null, tick: cloud.tick ?? null, villagers: cloud.villagers ?? null, error: cloud.error ?? null },
    browser: findBrowser(cfg) ? path.basename(findBrowser(cfg)) : null,
    electron: !!electronExe(),
    localWorld: world.ok ? world.dir : null,
    openMode: cfg.openMode || 'tab',
    ui: fs.existsSync(path.join(UI_DIR, 'index.html')),
  };
}

function spawnDetached(exe, args, cwd, tag, extraEnv) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const fd = fs.openSync(path.join(LOG_DIR, `${tag}-${stamp()}.log`), 'a');
    const child = spawn(exe, args, {
      cwd, detached: true, stdio: ['ignore', fd, fd],
      env: { ...cleanEnv(), ...(extraEnv || {}) },
    });
    child.unref();
    fs.closeSync(fd);
    running.set(tag, { pid: child.pid, startedAt: new Date().toISOString() });
    return child.pid;
  } catch (err) {
    log('FAIL', `拉起 ${tag} 失败：${err.message}`);
    return null;
  }
}

// ---------- 本地大脑：只读体检 + 由用户显式完成的配置向导 ----------
// 原则：这里绝不自动生成任何配置、不预置密钥、不代替用户注册。
// 所有写入都只在页面上由用户填好并点击「保存 / 领取 / 启动」之后才发生。
function maskSecret(v) {
  const s = String(v || '');
  if (!s) return '';
  return s.length <= 8 ? '••••••••' : `${s.slice(0, 3)}••••${s.slice(-3)}`;
}
function readJsonSafe(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
function readBrainSettings() { return readJsonSafe(BRAIN_SETTINGS_PATH); }
function readBrainIdentity() {
  const s = readJsonSafe(BRAIN_STATE_PATH);
  if (!s || !s.token) return null;
  return {
    cloud: String(s.cloud || ''), name: String(s.name || ''),
    villagerId: String(s.villagerId || ''), registeredAt: String(s.registeredAt || ''),
    tokenMask: maskSecret(s.token), tokenShapeOk: /^[A-Za-z0-9_\-]{8,}$/.test(String(s.token)),
  };
}
function readInvitePool() {
  try {
    return fs.readFileSync(INVITE_POOL_PATH, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function track(tag) {
  const r = running.get(tag);
  if (!r) return { running: false, pid: null, startedAt: null };
  if (processAlive(r.pid)) return { running: true, pid: r.pid, startedAt: r.startedAt };
  running.delete(tag);
  return { running: false, pid: null, startedAt: null };
}
function tailLog(file, n = 18) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n')
      .filter((l) => !/(api[_-]?key|token=)/i.test(l)).slice(-n);
  } catch { return []; }
}
function brainLogFile() {
  const own = path.join(LOG_DIR, `brain-${stamp()}.log`);
  const legacy = path.join(LOG_DIR, `local-brain-${stamp()}.log`);
  return fs.existsSync(own) ? own : legacy;
}
function brainEnv(cfg, settings) {
  const env = cleanEnv();
  const map = {
    cloud: 'CLOUD', provider: 'PROVIDER', ollamaUrl: 'OLLAMA_URL',
    openaiBaseUrl: 'OPENAI_BASE_URL', apiKey: 'OPENAI_API_KEY',
    model: 'MODEL', persona: 'PERSONA', intervalMs: 'INTERVAL_MS',
  };
  for (const [k, name] of Object.entries(map)) {
    if (settings && settings[k] !== undefined && settings[k] !== '') env[name] = String(settings[k]);
  }
  if (!env.CLOUD) env.CLOUD = cfg.baseUrl;
  return env;
}
// 标注每个变量到底来自哪里：系统环境变量 / 向导保存 / 都没配（程序内置默认）。
function brainSources(settings, env) {
  const map = {
    provider: 'PROVIDER', ollamaUrl: 'OLLAMA_URL', openaiBaseUrl: 'OPENAI_BASE_URL',
    apiKey: 'OPENAI_API_KEY', model: 'MODEL', persona: 'PERSONA', intervalMs: 'INTERVAL_MS',
  };
  const out = {};
  for (const [k, name] of Object.entries(map)) {
    out[k] = settings && settings[k] !== undefined && settings[k] !== ''
      ? '向导保存' : (env[name] ? '系统环境变量' : '内置默认');
  }
  return out;
}

async function collectBrain(cfg) {
  const settings = readBrainSettings();
  const identity = readBrainIdentity();
  const invites = readInvitePool();
  const env = brainEnv(cfg, settings);
  const provider = settings?.provider || env.PROVIDER || 'ollama';
  const model = settings?.model || env.MODEL || 'kaelri/qwen3.5-mt:2b';
  let cloud = settings?.cloud || cfg.baseUrl;
  try { cloud = new URL(String(cloud)).origin; } catch { cloud = cfg.baseUrl; }

  const world = await probeCloud(cloud, 1500);
  let modelService = { ok: false, detail: '尚未检测' };
  let models = [];
  if (provider === 'ollama') {
    let tagsUrl = null;
    try { tagsUrl = new URL('/api/tags', settings?.ollamaUrl || env.OLLAMA_URL || 'http://127.0.0.1:11434').href; } catch { /* 地址写错时下面给提示 */ }
    const r = tagsUrl
      ? await getJson(tagsUrl, 1000)
      : { ok: false, error: 'Ollama 地址不合法，请在第 3 步修正' };
    modelService = r.ok
      ? { ok: true, detail: `Ollama 在线，已装 ${(r.data?.models || []).length} 个模型` }
      : { ok: false, detail: `连不上 Ollama（${r.error}）` };
    models = (r.data?.models || []).map((m) => m.name || m.model).filter(Boolean);
  } else {
    const hasKey = !!(settings?.apiKey || env.OPENAI_API_KEY);
    modelService = {
      ok: hasKey,
      detail: hasKey ? '已填 API Key，点「检测」验证接口是否可用' : '未填 API Key，点「检测」前先在第 3 步保存',
    };
  }
  const modelOk = provider === 'ollama'
    ? models.some((m) => m === model || m.split(':')[0] === model.split(':')[0])
    : modelService.ok;
  const explicit = !!(settings && Object.keys(settings).length);

  const checks = [
    {
      key: 'world', ok: world.ok, title: '1 · 连得上世界',
      detail: world.ok ? `${cloud} 在线 · tick ${world.tick}` : `${cloud} 不可达（${world.error}）`,
      how: '在上方「世界连接」改地址；服务不可达就点「本地世界」在本机起一个，再把地址改成 http://127.0.0.1:8090',
    },
    {
      key: 'identity', ok: !!(identity && identity.tokenShapeOk), title: '2 · 有一只自己的村民',
      detail: identity
        ? `${identity.name || '未命名'}（${identity.villagerId}）· token ${identity.tokenMask} · 注册于 ${identity.registeredAt.slice(0, 10)}`
        : '没有 .local-agent.json，或里面没有 token',
      how: '在第 2 步填入邀请码并点「领一只村民」。没有码时在世界服务器执行：node tools/invite.mjs new "名字" 50 720',
    },
    {
      key: 'service', ok: modelService.ok, title: '3 · 模型服务可用',
      detail: modelService.detail,
      how: provider === 'ollama'
        ? '安装并启动 Ollama（https://ollama.com），或在第 3 步切到 OpenAI 兼容接口'
        : '在第 3 步填好接口地址与 API Key 后点「检测」',
    },
    {
      key: 'model', ok: modelOk, title: '4 · 选定的模型存在',
      detail: modelOk ? `当前模型 ${model}` : `当前模型 ${model} 不在已装列表里（或模型服务未连通）`,
      how: provider === 'ollama'
        ? `终端执行 ollama pull ${model}，或把第 3 步的模型名改成已装模型`
        : '把第 3 步的模型名改成该接口支持的模型 id',
    },
    {
      key: 'explicit', ok: explicit, optional: true, title: '5 · 已显式确认过设置',
      detail: explicit ? `brain-settings.json 已由你保存（${Object.keys(settings).length} 项）` : '未显式配置：程序会用内置默认的 ollama / 11434 / kaelri/qwen3.5-mt:2b',
      how: '在第 3 步填写并点「保存设置」。向导不会替你填任何值，也不会自动生成这个文件',
    },
    {
      key: 'invites', ok: invites.length > 0, optional: true, title: '6 · 备用邀请码（可选）',
      detail: invites.length ? `邀请码池有 ${invites.length} 个码：${invites.slice(0, 2).map(maskSecret).join('、')}` : '邀请码池为空：token 失效时无法自动重注册',
      how: '把新的邀请码填进第 2 步并点「加入邀请码池」，码只保存在本机 invites.txt',
    },
  ];
  const missing = checks.filter((c) => !c.ok && !c.optional).length;
  return {
    provider, model, cloud,
    settings: settings ? { ...settings, apiKey: maskSecret(settings.apiKey) } : null,
    hasApiKey: !!(settings?.apiKey || env.OPENAI_API_KEY),
    sources: brainSources(settings, env),
    identity, invites: { count: invites.length, masked: invites.map(maskSecret) },
    models: models.slice(0, 20),
    checks, missing, ready: missing === 0,
    process: track('brain'),
    logTail: tailLog(brainLogFile()),
  };
}

async function probeBrainDeep(cfg, body) {
  const settings = readBrainSettings() || {};
  const env = brainEnv(cfg, settings);
  const provider = body.provider || settings.provider || env.PROVIDER || 'ollama';
  let cloud = body.cloud || settings.cloud || cfg.baseUrl;
  try { cloud = new URL(String(cloud)).origin; } catch { cloud = cfg.baseUrl; }
  const items = [];
  const world = await probeCloud(cloud, 3000);
  items.push({ key: 'world', ok: world.ok, detail: world.ok ? `${cloud} 在线（${world.ms}ms，tick ${world.tick}）` : `${cloud} 不可达：${world.error}` });

  let models = [];
  if (provider === 'ollama') {
    const url = body.ollamaUrl || settings.ollamaUrl || env.OLLAMA_URL || 'http://127.0.0.1:11434';
    let tagsUrl = null;
    try { tagsUrl = new URL('/api/tags', url).href; } catch { /* 下面统一报错 */ }
    const r = tagsUrl ? await getJson(tagsUrl, 2500) : { ok: false, error: 'Ollama 地址不合法' };
    models = (r.data?.models || []).map((m) => m.name || m.model).filter(Boolean);
    items.push({ key: 'service', ok: r.ok, detail: r.ok ? `Ollama 在线，已装 ${models.length} 个模型` : `连不上 ${url}：${r.error}` });
  } else {
    const base = body.openaiBaseUrl || settings.openaiBaseUrl || env.OPENAI_BASE_URL || '';
    const key = body.apiKey || settings.apiKey || env.OPENAI_API_KEY || '';
    if (!base || !key) {
      items.push({ key: 'service', ok: false, detail: '接口地址或 API Key 未填，无法检测' });
    } else {
      try {
        const res = await fetch(`${base.replace(/\/+$/, '')}/models`, {
          headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000),
        });
        const data = await res.json().catch(() => ({}));
        models = (data.data || []).map((m) => m.id).filter(Boolean);
        items.push({ key: 'service', ok: res.ok, detail: res.ok ? `接口返回 HTTP ${res.status}，可用模型 ${models.length} 个` : `接口返回 HTTP ${res.status}：${data.error?.message || '鉴权或地址有误'}` });
      } catch (e) {
        items.push({ key: 'service', ok: false, detail: `接口请求失败：${e.message}` });
      }
    }
  }
  const identity = readBrainIdentity();
  const state = readJsonSafe(BRAIN_STATE_PATH);
  if (!identity || !state?.token) {
    items.push({ key: 'token', ok: false, detail: '还没有村民身份，请先在第 2 步领取' });
  } else {
    const tk = String(state.token);
    try {
      const res = await fetch(`${String(cloud).replace(/\/+$/, '')}/api/agents/${tk}/observation`, {
        headers: { 'x-agent-token': tk },
        signal: AbortSignal.timeout(3500),
      });
      items.push({ key: 'token', ok: res.ok, detail: res.ok ? `token 有效，${identity.name} 可以接收观察` : `token 已失效（HTTP ${res.status}），需要重新领一只村民` });
    } catch (e) {
      items.push({ key: 'token', ok: false, detail: `token 校验失败：${e.message}` });
    }
  }
  return { items, models: models.slice(0, 30) };
}

function saveBrainFields(body) {
  const incoming = body.fields && typeof body.fields === 'object' ? body.fields : {};
  const current = readBrainSettings() || {};
  const next = { ...current };
  const changed = [];
  for (const k of BRAIN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(incoming, k)) continue;
    const v = String(incoming[k] ?? '').trim();
    if (v === '') { if (k in next) { delete next[k]; changed.push(`清除 ${k}`); } }
    else { next[k] = v; changed.push(k); }
  }
  if (changed.length) {
    if (Object.keys(next).length) fs.writeFileSync(BRAIN_SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    else if (fs.existsSync(BRAIN_SETTINGS_PATH)) fs.unlinkSync(BRAIN_SETTINGS_PATH);
  }
  if (typeof body.invite === 'string' && body.invite.trim()) {
    const code = body.invite.trim();
    const pool = readInvitePool();
    if (!pool.some((p) => p.toUpperCase() === code.toUpperCase())) {
      pool.push(code);
      fs.writeFileSync(INVITE_POOL_PATH, pool.join('\n') + '\n', 'utf8');
      changed.push('邀请码池 +1');
    }
  }
  log('OK', `向导保存（用户操作）：${changed.length ? changed.join('、') : '没有改动'}`);
  return { ok: true, changed };
}

async function registerBrain(cfg, body) {
  const script = path.join(HERE, 'local-brain.mjs');
  if (!fs.existsSync(script)) return { ok: false, output: 'local-brain.mjs 不存在' };
  const settings = readBrainSettings();
  const args = [script, '--register'];
  if (typeof body.invite === 'string' && body.invite.trim()) args.push('--invite', body.invite.trim());
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(process.execPath, args, { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'], env: brainEnv(cfg, settings) });
    const keep = (d) => { out = (out + d.toString()).slice(-3500); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), 25000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      log(code === 0 ? 'OK' : 'WARN', `向导领村民（用户操作）：${code === 0 ? '成功' : `失败，退出码 ${code}`}`);
      resolve({ ok: code === 0, output: out.trim() });
    });
  });
}

function stopBrain() {
  const p = track('brain');
  if (!p.running) return { ok: false, message: '本地大脑当前没有在运行' };
  try {
    process.kill(p.pid, 'SIGTERM');
    running.delete('brain');
    log('OK', `已停止本地大脑（pid ${p.pid}）`);
    return { ok: true, message: `已停止本地大脑（pid ${p.pid}）` };
  } catch (e) {
    return { ok: false, message: `停止失败：${e.message}` };
  }
}

async function handleAction(mode, cfg, body) {
  const base = body.base ? normalizeBase(body.base) : cfg.baseUrl;
  switch (mode) {
    case 'observe': {
      const code = await runObserve(cfg, { yes: true, base });
      return { ok: code === 0, code, message: code === 0 ? '观测窗已打开' : '服务不可达，未打开观测窗；可改用「本地世界」或先改地址' };
    }
    case 'electron': {
      const exe = electronExe();
      if (!exe) return { ok: false, message: 'Electron 未安装，请先在 client/ 目录运行 npm install' };
      const pid = spawnDetached(exe, ['.'], HERE, 'electron');
      return { ok: !!pid, message: pid ? `Electron 控制台已启动（pid ${pid}）` : 'Electron 启动失败' };
    }
    case 'brain': {
      const script = path.join(HERE, 'local-brain.mjs');
      if (!fs.existsSync(script)) return { ok: false, message: 'local-brain.mjs 不存在，模式 3 不可用' };
      const p = track('brain');
      if (p.running) return { ok: false, message: `本地大脑已在运行（pid ${p.pid}），请先点「停止」再启动` };
      const settings = readBrainSettings();
      const brain = await collectBrain(cfg);
      const pid = spawnDetached(process.execPath, [script], HERE, 'brain', brainEnv(cfg, settings));
      const warn = brain.missing ? `；体检还差 ${brain.missing} 项，请到下方「本地大脑」看缺口` : '';
      return { ok: !!pid, message: pid ? `本地大脑已启动（pid ${pid}）${warn}` : '本地大脑启动失败' };
    }
    case 'local': {
      const code = await runLocal(cfg, { yes: true });
      return { ok: code === 0, code, message: code === 0 ? '本地世界已就绪，观测窗已打开' : '本地世界未就绪，详情见 logs/' };
    }
    case 'repair': {
      const bad = ensureShells(true).filter((s) => s.status !== 'ok');
      return { ok: !bad.length, message: bad.length ? `仍有 ${bad.length} 个入口脚本异常` : '入口脚本已全部重建为纯 ASCII + CRLF' };
    }
    default:
      return { ok: false, message: `未知模式 ${mode}` };
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}
function send(res, code, data, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}
// 令牌可来自自动化用的请求头，或首次打开时种下的 HttpOnly cookie。
function requestToken(req) {
  const header = req.headers['x-launcher-token'];
  if (typeof header === 'string' && header) return header;
  const m = /(?:^|;\s*)launcher_token=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

async function runGui(cfg, opts) {
  if (!fs.existsSync(path.join(UI_DIR, 'index.html'))) {
    log('FAIL', '缺少 launcher-ui/index.html，无法打开可视化窗口');
    return 1;
  }
  const token = crypto.randomBytes(24).toString('hex');
  let cfgNow = { ...cfg };
  let lastBeat = Date.now();
  let closed = false;
  let timer = null;
  let finish = null;
  const done = new Promise((resolve) => { finish = resolve; });

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(res, 400, { error: 'bad request' }); }
    const p = url.pathname;

    // 地址栏里的一次性令牌立刻换成 HttpOnly cookie 并重定向到干净的 /。
    // 普通标签页的地址栏、历史记录、书签里都不会留下身份令牌。
    if (req.method === 'GET' && p === '/' && url.searchParams.has('token')) {
      if (url.searchParams.get('token') !== token) return send(res, 403, { error: 'token 无效，请重新双击「启动器.bat」' });
      res.writeHead(302, {
        'location': '/',
        'set-cookie': `launcher_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && STATIC[p]) {
      const [file, mime] = STATIC[p];
      const target = path.join(UI_DIR, file);
      if (!fs.existsSync(target)) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
      return send(res, 200, fs.readFileSync(target), mime);
    }
    if (requestToken(req) !== token) {
      return send(res, 403, { error: '会话无效，请重新双击「启动器.bat」打开' });
    }
    try {
      if (p === '/api/heartbeat' && req.method === 'POST') {
        lastBeat = Date.now();
        return send(res, 200, { ok: true });
      }
      if (p === '/api/status' && req.method === 'GET') {
        return send(res, 200, await collectStatus(cfgNow));
      }
      if (p === '/api/check' && req.method === 'GET') {
        return send(res, 200, await collectCheck(cfgNow));
      }
      if (p === '/api/logs' && req.method === 'GET') {
        const file = path.join(LOG_DIR, `launcher-${stamp()}.log`);
        // 身份令牌只在窗口地址栏里，日志与页面都不回显
        const lines = fs.existsSync(file)
          ? fs.readFileSync(file, 'utf8').trim().split('\n').filter((l) => !l.includes('token=')).slice(-60)
          : [];
        return send(res, 200, { lines });
      }
      if (p === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const next = { ...cfgNow };
        const changed = [];
        if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
          next.baseUrl = normalizeBase(body.baseUrl);
          changed.push(`baseUrl=${next.baseUrl}`);
        }
        for (const k of ['localWorldDir', 'browser']) {
          if (typeof body[k] === 'string') { next[k] = body[k].trim(); changed.push(k); }
        }
        if (typeof body.openMode === 'string' && ['tab', 'app', 'none'].includes(body.openMode)) {
          next.openMode = body.openMode;
          changed.push(`openMode=${body.openMode}`);
        }
        if (!changed.length) return send(res, 400, { error: '没有需要保存的字段' });
        fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        cfgNow = next;
        log('OK', `配置已保存（${changed.join('，')}）`);
        return send(res, 200, { ok: true, baseUrl: next.baseUrl, openMode: next.openMode });
      }
      if (p === '/api/brain' && req.method === 'GET') {
        return send(res, 200, await collectBrain(cfgNow));
      }
      if (p === '/api/brain/probe' && req.method === 'POST') {
        return send(res, 200, await probeBrainDeep(cfgNow, await readBody(req)));
      }
      if (p === '/api/brain/log' && req.method === 'GET') {
        return send(res, 200, { lines: tailLog(brainLogFile(), 60) });
      }
      if (p === '/api/brain/save' && req.method === 'POST') {
        return send(res, 200, saveBrainFields(await readBody(req)));
      }
      if (p === '/api/brain/register' && req.method === 'POST') {
        return send(res, 200, await registerBrain(cfgNow, await readBody(req)));
      }
      if (p === '/api/brain/stop' && req.method === 'POST') {
        return send(res, 200, stopBrain());
      }
      if (p === '/api/action' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await handleAction(String(body.mode || ''), cfgNow, body);
        log(result.ok ? 'OK' : 'WARN', `[窗口] ${body.mode} → ${result.message}`);
        return send(res, 200, result);
      }
      if (p === '/api/shutdown' && req.method === 'POST') {
        send(res, 200, { ok: true });
        setTimeout(shutdown, 200);
        return;
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      log('FAIL', `窗口请求 ${p} 异常：${err.message}`);
      return send(res, 500, { error: err.message });
    }
  });

  function shutdown() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    try { server.close(); server.closeAllConnections?.(); } catch { /* 已关闭 */ }
    finish(0);
  }

  let port = 0;
  for (let i = 0; i < GUI_PORT_TRIES; i++) {
    try { port = GUI_PORT_START + i; await listen(server, port); break; }
    catch { port = 0; }
  }
  if (!port) { log('FAIL', `${GUI_PORT_START}~${GUI_PORT_START + GUI_PORT_TRIES - 1} 端口都被占用`); return 1; }

  const url = `http://127.0.0.1:${port}/?token=${token}`;
  log('OK', `可视化启动器服务已就绪（127.0.0.1:${port}，仅本机可访问）`);
  if (!opts.noOpen) openBrowser(cfgNow, url, '可视化启动窗口');
  // 完整地址含一次性身份令牌：只打印到控制台供手动打开 / 自动化读取，绝不写入日志文件。
  process.stdout.write(`[窗口地址] ${url}\n`);
  log('INFO', `打开方式 openMode=${cfgNow.openMode || 'tab'}（tab=系统默认浏览器标签页 / app=独立无边框窗口 / none=不自动打开）`);

  // 只有独立应用窗口才用心跳判定关闭；普通标签页会被浏览器节流定时器，
  // 后台放一会儿不应把服务误杀，此时由页面里的「退出启动器」或 Ctrl+C 结束。
  const heartbeatEnabled = (cfgNow.openMode || 'tab') === 'app' && !opts.noOpen;
  if (heartbeatEnabled) {
    timer = setInterval(() => {
      if (Date.now() - lastBeat > HEARTBEAT_TIMEOUT) {
        log('INFO', '窗口已关闭（心跳超时），启动器服务退出');
        shutdown();
      }
    }, 5000);
  }
  process.once('SIGINT', () => { log('INFO', '收到 Ctrl+C，启动器服务退出'); shutdown(); });
  return done;
}

// ---------- 主流程 ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  ensureShells(false);            // 每次启动都先把被改坏的入口壳修回来
  const { cfg } = loadConfig();
  if (opts.repair) { log('OK', '入口脚本已重建（纯 ASCII + CRLF + 无 BOM）'); return 0; }
  try {
    if (opts.check) return await runCheck(cfg, opts);
    if (opts.base) cfg.baseUrl = normalizeBase(opts.base);
    switch (opts.mode) {
      case 'gui': case '': return await runGui(cfg, opts);
      case 'menu': return await runMenu(cfg, opts);
      case 'observe': return await runObserve(cfg, opts);
      case 'electron': return await runElectron(cfg, opts);
      case 'brain': return await runBrain(cfg, opts);
      case 'local': return await runLocal(cfg, opts);
      default:
        log('FAIL', `未知模式 --mode=${opts.mode}`, '可用：gui / menu / observe / electron / brain / local');
        return 1;
    }
  } catch (err) {
    log('FAIL', `未捕获异常：${err.message}`, err.stack);
    log('TIP', '先运行「验证启动器.bat」或 node pc-launcher.mjs --check 看诊断结果');
    return 1;
  }
}

process.exitCode = await main();
