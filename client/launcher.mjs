#!/usr/bin/env node
'use strict';

// 轻量启动器：不装任何依赖，探测世界服务后用 Edge/Chrome 的「应用模式」开一个无浏览器边框的窗口。
// 用法：
//   node launcher.mjs                 使用 config.json 里的地址
//   node launcher.mjs http://1.2.3.4  临时指定地址
//   node launcher.mjs --check         只探测，不开窗口

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath：import.meta.url 会把路径里的空格编码成 %20，
// 直接用 .pathname 会让含空格的工作区目录（...\Game product\）读不到 config.json。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'config.json');

const DEFAULT_BASE = 'http://127.0.0.1:8090';

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeBase(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('缺少服务器地址');
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  return new URL(withScheme).origin;
}

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'bigfatfish-launcher/0.1' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        try {
          resolve({ ok: true, data: JSON.parse(body), ms: Date.now() - startedAt });
        } catch {
          resolve({ ok: false, error: '响应不是 JSON' });
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('超时')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

function findBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const explicit = args.find((a) => !a.startsWith('--'));

  const cfg = readConfig();
  let baseUrl;
  try {
    baseUrl = normalizeBase(explicit || cfg.baseUrl || DEFAULT_BASE);
  } catch (err) {
    console.error(`[错误] ${err.message}`);
    process.exit(1);
  }

  const health = await getJson(new URL('/api/health', baseUrl));
  if (!health.ok) {
    console.error(`[失败] 连不上 ${baseUrl} —— ${health.error}`);
    console.error('       检查：地址是否正确 / 实例是否在运行 / 防火墙是否放通 80');
    process.exit(2);
  }

  const server = await getJson(new URL('/api/server', baseUrl));
  const s = server.ok ? server.data : {};
  console.log(`[在线] ${baseUrl}  延迟 ${health.ms}ms`);
  console.log(`       世界 ${s.map?.width ?? '?'}×${s.map?.height ?? '?'} 格 · 村民 ${s.villagers ?? '?'} · tick ${health.data?.tick ?? '?'}`);

  if (checkOnly) return;

  const browser = findBrowser();
  if (!browser) {
    console.error('[提示] 没找到 Edge/Chrome，直接用浏览器打开：');
    console.log(`${baseUrl}/`);
    return;
  }

  const profileDir = path.join(process.env.LOCALAPPDATA || HERE, 'bigfatfish-client');
  const size = cfg.observerSize || { width: 1440, height: 900 };
  const child = spawn(
    browser,
    [
      `--app=${baseUrl}/`,
      `--window-size=${size.width},${size.height}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  console.log(`[启动] 观测窗已打开（${path.basename(browser)} 应用模式）`);
}

main().catch((err) => {
  console.error(`[异常] ${err.message}`);
  process.exit(1);
});
