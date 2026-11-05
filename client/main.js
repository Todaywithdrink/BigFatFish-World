'use strict';

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  baseUrl: 'http://127.0.0.1:8090',
  alwaysOnTop: false,
  observerSize: { width: 1440, height: 900 },
};

let dashboardWin = null;
let observerWin = null;

function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('写入配置失败', err.message);
  }
  return next;
}

function normalizeBase(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('请填写服务器地址');
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  const url = new URL(withScheme);
  if (!url.hostname) throw new Error('地址里没有主机名');
  return url.origin;
}

function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(
      url,
      { headers: { 'user-agent': 'bigfatfish-pc/0.1', accept: 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4 * 1024 * 1024) req.destroy(new Error('响应过大'));
        });
        res.on('end', () => {
          const ms = Date.now() - startedAt;
          if (res.statusCode !== 200) {
            resolve({ ok: false, ms, error: `HTTP ${res.statusCode}` });
            return;
          }
          try {
            resolve({ ok: true, ms, data: JSON.parse(body) });
          } catch {
            resolve({ ok: false, ms, error: '返回内容不是合法 JSON' });
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', (err) => resolve({ ok: false, ms: Date.now() - startedAt, error: err.message }));
  });
}

async function probe(rawBase) {
  let baseUrl;
  try {
    baseUrl = normalizeBase(rawBase);
  } catch (err) {
    return { ok: false, baseUrl: null, error: err.message };
  }

  const health = await getJson(new URL('/api/health', baseUrl), 4000);
  if (!health.ok) {
    return { ok: false, baseUrl, error: health.error, latency: health.ms };
  }

  const server = await getJson(new URL('/api/server', baseUrl), 4000);
  return {
    ok: true,
    baseUrl,
    latency: health.ms,
    health: health.data,
    server: server.ok ? server.data : null,
    serverError: server.ok ? null : server.error,
  };
}

function createDashboard() {
  dashboardWin = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 480,
    minHeight: 620,
    backgroundColor: '#0d1117',
    title: '大肥鱼世界 · PC 观测端',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  dashboardWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  dashboardWin.on('closed', () => {
    dashboardWin = null;
  });
}

function createObserver(baseUrl) {
  const cfg = readConfig();
  if (observerWin && !observerWin.isDestroyed()) {
    observerWin.loadURL(`${baseUrl}/`);
    observerWin.show();
    observerWin.focus();
    return observerWin;
  }

  const size = cfg.observerSize || DEFAULT_CONFIG.observerSize;
  observerWin = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#000000',
    title: `观测窗 · ${baseUrl}`,
    autoHideMenuBar: true,
    alwaysOnTop: Boolean(cfg.alwaysOnTop),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  observerWin.loadURL(`${baseUrl}/`);
  observerWin.on('closed', () => {
    observerWin = null;
    notifyState();
  });
  observerWin.on('enter-full-screen', notifyState);
  observerWin.on('leave-full-screen', notifyState);

  return observerWin;
}

function notifyState() {
  if (!dashboardWin || dashboardWin.isDestroyed()) return;
  const alive = Boolean(observerWin && !observerWin.isDestroyed());
  dashboardWin.webContents.send('observer:state', {
    open: alive,
    alwaysOnTop: alive ? observerWin.isAlwaysOnTop() : false,
    fullscreen: alive ? observerWin.isFullScreen() : false,
  });
}

function buildMenu() {
  const template = [
    {
      label: '客户端',
      submenu: [
        {
          label: '重新加载控制台',
          accelerator: 'CmdOrCtrl+R',
          click: () => dashboardWin && dashboardWin.reload(),
        },
        {
          label: '重新连接观测窗',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => dashboardWin && dashboardWin.webContents.send('ui:reconnect'),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '观测窗',
      submenu: [
        {
          label: '窗口置顶（OBS 用）',
          type: 'checkbox',
          checked: readConfig().alwaysOnTop,
          click: (item) => {
            writeConfig({ alwaysOnTop: item.checked });
            if (observerWin && !observerWin.isDestroyed()) {
              observerWin.setAlwaysOnTop(item.checked);
            }
            notifyState();
          },
        },
        {
          label: '全屏',
          accelerator: 'F11',
          click: () => {
            if (observerWin && !observerWin.isDestroyed()) {
              observerWin.setFullScreen(!observerWin.isFullScreen());
            }
          },
        },
        { type: 'separator' },
        {
          label: '打开原始观测页',
          click: () => {
            const cfg = readConfig();
            shell.openExternal(`${cfg.baseUrl}/`).catch(() => {});
          },
        },
      ],
    },
    {
      label: '调试',
      submenu: [
        {
          label: '观测窗开发者工具',
          click: () => {
            if (observerWin && !observerWin.isDestroyed()) observerWin.webContents.openDevTools({ mode: 'detach' });
          },
        },
        {
          label: '控制台开发者工具',
          click: () => dashboardWin && dashboardWin.webContents.openDevTools({ mode: 'detach' }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createDashboard();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createDashboard();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('config:get', () => readConfig());

ipcMain.handle('config:set', (_event, patch) => writeConfig(patch || {}));

ipcMain.handle('probe', async (_event, baseUrl) => {
  const result = await probe(baseUrl);
  if (result.ok && result.baseUrl) writeConfig({ baseUrl: result.baseUrl });
  return result;
});

ipcMain.handle('connect', async (_event, baseUrl) => {
  try {
    const normalized = normalizeBase(baseUrl);
    createObserver(normalized);
    writeConfig({ baseUrl: normalized });
    setTimeout(notifyState, 300);
    return { ok: true, baseUrl: normalized };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('observer:togglePin', (_event, next) => {
  const value = Boolean(next);
  writeConfig({ alwaysOnTop: value });
  if (observerWin && !observerWin.isDestroyed()) observerWin.setAlwaysOnTop(value);
  notifyState();
  return value;
});

ipcMain.handle('observer:fullscreen', () => {
  if (observerWin && !observerWin.isDestroyed()) {
    observerWin.setFullScreen(!observerWin.isFullScreen());
  }
  notifyState();
});

ipcMain.handle('observer:close', () => {
  if (observerWin && !observerWin.isDestroyed()) observerWin.close();
});

ipcMain.handle('open:external', (_event, url) => {
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    shell.openExternal(target.toString());
    return true;
  } catch {
    return false;
  }
});
