# 大肥鱼世界 · PC 观测端

本地桌面客户端，连接你自己启动的世界服务（默认 `http://127.0.0.1:8090`）。启动器默认用**系统默认浏览器的网页标签页**打开控制台；
需要无边框独立窗口给 OBS 采集时，可切 `app` 模式或 Electron 控制台。

> **2026-11-05 更新：启动器已可视化，且默认用网页端打开。** 双击 **`启动器.bat`**
> 会用**系统默认浏览器的普通标签页**打开控制台（不再另起干净浏览器实例，插件不会被重置），
> 里面能看连接状态、改地址、点按钮启动四种模式、跑自检、看日志，
> 还有一栏**本地大脑的配置体检与四步首次配置向导**。
> 原来的三个 `.bat` 全部保留为快捷方式，命令行模式也仍可用。

## 可视化启动窗口（推荐）

双击 **`启动器.bat`** → 自动起本机服务 → 交给**系统默认浏览器开一个普通标签页**：

| 区域 | 能做什么 |
|---|---|
| 世界连接 | 在线/离线灯；六项指标；地址可直接改；**打开方式**下拉（`tab` / `app` / `none`） |
| 启动一个模式 | 四张卡片，点「启动」即拉起，带 loading 态与结果提示 |
| 本地大脑 · 配置与运行 | 6 项配置体检（逐项给「怎么办」）、身份与密钥来源、运行日志、**四步首次配置向导**、进程启动/停止 |
| 自检 | 核心阻断项与功能降级项分开列，可一键重建入口脚本 |
| 最近日志 | 最近 60 行，每次操作后自动刷新 |
| 退出启动器 | 关掉本机服务；已启动的观测窗 / 本地大脑不受影响 |

**打开方式**（页面里可随时切换，写入 `config.json`，下次启动生效）：

| `openMode` | 行为 | 适用 |
|---|---|---|
| `tab`（默认） | 系统默认浏览器的普通标签页，**不传 `--user-data-dir` / `--app` / `--no-first-run`** | 日常使用、不想动浏览器插件 |
| `app` | 独立无边框应用窗口，用干净 profile（`%LOCALAPPDATA%\bigfatfish-app`） | OBS 窗口采集；此实例**不加载日常扩展**是刻意行为 |
| `none` | 只打印地址，不自动开浏览器 | 远程 / 自动化 / 自己决定何时打开 |

**安全与生命周期**：服务只监听 `127.0.0.1`，端口从 17890 起自适应（最多试 12 个）；
每次启动生成一次性 48 位令牌。访问 `/?token=…` 时服务端立刻把它换成
**HttpOnly + SameSite=Strict cookie** 并 302 到干净的 `/`——地址栏、历史、书签里都不留令牌；
`/api/*` 接受该 cookie 或 `X-Launcher-Token` 请求头（自动化兼容），都不满足返回 403。
令牌只打印到控制台，**不写入日志、不在页面回显**。
心跳自动退出**只在 `app` 模式启用**：普通标签页会被浏览器节流定时器，靠心跳判断会把后台标签误杀；
`tab` 模式由页面「退出启动器」或 Ctrl+C 结束，黑色命令行窗口关掉也会结束服务。`--no-open` 场景常驻以便自动化。

| 接口 | 用途 |
|---|---|
| `GET /api/status` | Node 版本、服务探测、浏览器 / Electron / 本地内核、`openMode` |
| `GET /api/check` | 分层自检（核心 vs 功能降级，含服务连接项） |
| `GET /api/logs` | 最近 60 行日志（自动过滤含令牌的行） |
| `POST /api/config` | 修改并持久化地址 / `openMode` / 浏览器路径 / 本地内核目录 |
| `GET /api/brain` | 本地大脑**只读体检**：6 项检查、身份（脱敏）、设置来源、进程状态、日志尾部 |
| `POST /api/brain/probe` | 用户点「检测」时才发网络请求：世界 / 模型服务 / token 有效性 / 可用模型列表 |
| `POST /api/brain/save` | **仅保存用户显式提交的字段**；空提交不创建任何文件、不填默认值 |
| `POST /api/brain/register` | 用户点「领取村民」才真正注册并写 `.local-agent.json` |
| `POST /api/brain/stop`、`GET /api/brain/log` | 停止本次启动器拉起的进程 / 读运行日志（脱敏） |
| `POST /api/action` | 拉起 `observe / electron / brain / local / repair`；`brain` 带防重复与设置注入 |
| `POST /api/heartbeat`、`/api/shutdown` | 心跳保活与主动退出 |

静态资源在 **`launcher-ui/`**（`index.html` / `style.css` / `app.js`，纯 HTML/CSS/JS，零依赖、零构建）。
长驻进程（Electron / 本地大脑）以 detached 方式拉起并各自写 `logs/*.log`，不会阻塞页面请求。

快捷键（等价、可放进任务栏或脚本）：`启动客户端.bat` = 轻量观测、`启动客户端-Electron版.bat` = Electron、
`启动本地大脑.bat` = 本地大脑、`验证启动器.bat` = 命令行自检。

命令行：

```bash
node pc-launcher.mjs                       # 可视化启动窗口（默认）
node pc-launcher.mjs --mode=gui --no-open # 只起服务，不自动开窗（自动化 / 调试）
node pc-launcher.mjs --mode=menu          # 旧式命令行菜单
node pc-launcher.mjs --mode=observe       # 直接轻量观测
node pc-launcher.mjs --mode=local         # 直接离线世界
node pc-launcher.mjs --base=http://x      # 临时换服务地址
node pc-launcher.mjs --check              # 命令行自检，不启动任何东西
node pc-launcher.mjs --repair             # 重建全部入口脚本
```

退出码：`0` 正常 / `1` 启动器异常 / `2` 服务不可达 / `3` Electron 不可用 / `4` 本地大脑缺失 / `5` 本地内核缺失。

## 为什么以前一更新就打不开

| # | 根因 | 现在的处理 |
|---|---|---|
| 1 | 三个 `.bat` 是 UTF-8 无 BOM + **纯 LF** + 中文正文 + `chcp 65001`。cmd 按 ANSI 逐行读，切代码页后字节指针错位，中文一改就跳命令；Electron 版还有 `if (...)` 多行括号块，LF 下更易解析崩 | 入口壳**不含任何非 ASCII 字节**（纯 ASCII 在 UTF-8/GBK/ANSI 下字节完全一致）+ CRLF 换行；中文提示全部交给 Node 打印 |
| 2 | `ELECTRON_RUN_AS_NODE` 从宿主泄漏，`require('electron')` 返回字符串 → `app.whenReady` undefined（`smoke.log` 实证崩溃） | bat 里 `set "ELECTRON_RUN_AS_NODE="`，Node 侧 `cleanEnv()` 再删一次；直接 spawn `electron.exe`，不经过 `npx` |
| 3 | `launcher.mjs` 用 `import.meta.url.pathname` 取目录，工作区路径含空格 → `Game%20product`，`config.json` 静默读不到 | 改用 `fileURLToPath()`；统一启动器不再依赖旧 CLI |
| 4 | 服务 `/api/health` 一失败就 `exit(2)`，没有任何降级 | 探测失败给菜单：重试 / 换地址 / 切本地世界 / 仍开浏览器 / 退出 |
| 5 | 没有自检，改完不知道哪里坏了 | `验证启动器.bat` 一键体检；日志落在 `logs/launcher-YYYYMMDD.log` |
| 6 | `config.json` 写坏就整个启动失败 | 解析失败自动备份到 `logs/config.bad-*.json` 并重建默认配置 |

**自愈**：每次启动（含双击任意入口）都会校验 5 个 `.bat` 的字节，发现被改成 BOM / 含中文 / LF，
自动用内建模板重建，原文件备份在 `logs/`。实测把 `启动客户端.bat` 改坏后，
从完好的 `验证启动器.bat` 进入即自动恢复为纯 ASCII + CRLF。

**分层自检**：核心（入口壳、`pc-launcher.mjs`、`config.json`）才算阻断；
浏览器 / Electron / 本地大脑 / 本地内核 / 服务任一缺失只报「功能降级」，不影响其它模式启动。

## 为什么以前一打开就「重启一次插件起始页」

旧版两处打开浏览器（启动窗口 + 观测窗）都给 `msedge.exe` 传了 `--user-data-dir=`，
而且指向两个不同目录（`%LOCALAPPDATA%\bigfatfish-launcher` 与 `bigfatfish-client`）：

| 后果 | 原因 |
|---|---|
| 扩展反复弹首次运行 / 起始页 | 带独立 `--user-data-dir` = 每次都开一个全新干净 profile，扩展要重新初始化；`--no-first-run` 只压得住 Chromium 自带欢迎页，压不住扩展自己的 onboarding |
| 浏览器「闪一下又回到起始页」 | 同 profile 已有实例在跑时，新的 `--app=` 请求被转发给旧进程，旧窗口被拉到前台 |
| 一次操作开两个互不相干的 Edge | 启动窗口与观测窗用了两个不同 profile |

**现在**：默认 `openMode=tab`，用系统默认浏览器的普通标签页打开，
**完全不传任何浏览器参数**，你的扩展、登录态、插件设置原样保留；
只有显式选 `app` 才会使用独立干净实例（且两个入口共用同一个 profile，不再开两份）。

实测：以默认方式启动后，`bigfatfish-client` / `bigfatfish-launcher` 两个旧 profile 目录的时间戳**没有变化**，
日志显示「已交给系统默认浏览器（普通标签页，不新建浏览器 profile）」。

顺带解决的另一个网页端坑：令牌在地址栏里会进浏览器历史 → 现在访问 `/?token=…` 立即换成
HttpOnly cookie 并重定向到 `/`；后台标签的定时器节流不再触发误退出（心跳自动退出只在 `app` 模式启用）。

## 以后怎么更新才不会再坏

- ✅ **只改**：`config.json`、`launcher-ui/` 里的页面、`pc-launcher.mjs` 里的逻辑（它们都不会被 cmd 解析）
- ✅ 改页面样式/文案只需替换 `launcher-ui/style.css` / `index.html` / `app.js`，刷新窗口即生效，**不用碰任何 `.bat`**
- ❌ **不要在 `.bat` 里加中文提示或改成 LF 换行**：要加提示请写进 `pc-launcher.mjs`，或运行 `--repair` 让模板重建
- ✅ 每次更新后跑一次 `验证启动器.bat`（或 `node pc-launcher.mjs --check`），看到「核心通过」即可；也可在可视化窗口里点「重新检查」
- ✅ 入口壳被任何工具改坏都不用手动修，下次启动自动恢复

## 各模式细节

### 1. 轻量观测窗（零依赖）
- 不需要 npm，不需要 Electron
- 先探测 `/api/health` 与 `/api/server`，连通后用**系统默认浏览器普通标签页**打开（`openMode=app` 时才用无边框应用窗口）
- 只做只读观测，不向世界写任何数据
- 旧 CLI 仍可用：`node launcher.mjs [地址|--check]`（独立命令行工具，双击入口不依赖它）

### 2. Electron 版（控制台 + 观测窗双窗口）
双击 **`启动客户端-Electron版.bat`**；缺依赖时会询问是否执行 `npm install`（约 100MB）。

功能：

| 能力 | 说明 |
|---|---|
| 连接检测 | 输入地址即探测，显示延迟、tick、实体数、村民数、空闲席位、运行时长 |
| 自动心跳 | 每 3 秒自动重测，断线变红灯并记日志 |
| 独立观测窗 | 直接加载观测站页面，窗口可自由缩放 |
| 窗口置顶 | 菜单「观测窗 → 窗口置顶」，方便 OBS 窗口采集 |
| 全屏 | F11，或菜单/按钮 |
| 配置持久化 | 地址与置顶状态存 `config.json`，下次自动带上 |

## 配置

`config.json`：

```json
{
  "baseUrl": "http://127.0.0.1:8090",
  "alwaysOnTop": false,
  "observerSize": { "width": 1440, "height": 900 },
  "localWorldDir": "",
  "browser": "",
  "openMode": "tab"
}
```

| 字段 | 用途 |
|---|---|
| `baseUrl` | 服务地址，也可运行时用 `--base=` 临时覆盖 |
| `observerSize` | `app` 模式窗口尺寸 |
| `localWorldDir` | 离线模式 4 的世界内核目录（其下需有 `sim/server.mjs`）；留空则自动探测 |
| `browser` | 指定 Edge/Chrome 的 exe 全路径；留空自动查找（仅 `app` 模式需要） |
| `openMode` | `tab`（默认，系统默认浏览器标签页）/ `app`（独立无边框窗口）/ `none`（不自动打开） |

`config.json` 写坏不会导致启动失败：启动器会把它备份到 `logs/config.bad-*.json` 再重建默认配置。
**不写 `openMode` 也等于 `tab`**——默认值来自代码，不必改配置文件。

## 本地大脑（算力在本地，世界在服务端）

`local-brain.mjs` 让你的本地模型驱动世界里的一个村民。**双击 `启动本地大脑.bat` 即可常驻运行**（默认模型 `kaelri/qwen3.5-mt:2b`，约 0.6 秒/轮）。

### 新用户：怎么把本地大脑配起来

以前这件事全靠**环境变量 + 两个隐藏文件**，界面上只有一个「启动」按钮，
配没配好、哪个值生效了，都只能翻日志猜。现在可视化窗口里有「本地大脑 · 配置与运行」：

> **向导不会替你填任何值、不会自动生成配置文件、不会在你没点按钮时注册或启动。**
> 所有输入框初始为空（placeholder 只是格式示例），每一项都由你输入、你保存。
> 左侧 6 项体检实时显示「还差什么」和每一项的「怎么办」。

| 步 | 你要做什么 | 东西从哪来 | 点什么 | 结果写到哪 |
|---|---|---|---|---|
| **1 连世界** | 确认本地大脑连哪个世界 | 留空 = 跟随上方「世界连接」；服务不可达就先点「本地世界」，再填 `http://127.0.0.1:8090` | 保存地址 / 检测世界 | `brain-settings.json` 的 `cloud` |
| **2 领村民** | 拿邀请码，领一只自己的村民 | 在世界服务器 `sim/` 目录执行 `node tools/invite.mjs new "名字" 50 720`（页面有「复制命令」） | 加入邀请码池 → 领取村民 | 码进 `invites.txt`；身份进 `.local-agent.json` |
| **3 接模型** | 选 Ollama 或 OpenAI 兼容接口，填地址 / Key / 模型名 | Ollama：装好并启动，再 `ollama pull <模型名>`；兼容接口：服务商给的地址与 API Key | 保存设置 / 检测模型 | `brain-settings.json`（Key 只存本机，页面只显示「已存，不回显」） |
| **4 确认启动** | 跑一次「检测全部」，看缺口，再启动 | — | 检测全部 → 启动本地大脑 | 你保存的设置作为环境变量传给 `local-brain.mjs`，不用再手设系统环境变量 |

**体检 6 项**：连得上世界 / 有一只自己的村民 / 模型服务可用 / 选定的模型存在 /
已显式确认过设置（可选）/ 备用邀请码（可选）。前 4 项是门槛，后 2 项只提示不阻断。

- **「来源」一栏**区分每个变量来自 `向导保存` / `系统环境变量` / `程序内置默认`，不再出现「明明能跑却不知道是谁在生效」。
- **「检测」**逐项列出世界连通、Ollama `/api/tags`（或兼容接口 `/models`）、token 是否仍有效，并列出本机已装模型名。
- **身份与密钥都脱敏**：token 显示为 `t_2••••a1b`，API Key 只回显「已存」，日志也会过滤含令牌的行。
- **防重复启动**：同一轮启动器里已在运行就拒绝再起一个，并提供「停止进程」按钮。
  ⚠️ 边界：启动器只管理**它自己这一轮拉起**的进程；之前用 `启动本地大脑.bat` 或命令行手工启动的，请关掉它自己的窗口。

旧办法仍然完全可用（适合脚本 / 无界面环境）：

```bash
node local-brain.mjs --register --invite DFY-XXXX   # 首次：注册并领一只村民
node local-brain.mjs                                # 开始驱动（默认 Ollama）
node local-brain.mjs --dry                          # 只看观察结果，不行动
node local-brain.mjs --once                         # 只跑一轮
node bench-models.mjs "模型A" "模型B"               # 本地模型对照测试（延迟+JSON合法性）
```

原理：本地定期 `GET /api/agents/{token}/observation` → 本地模型推理 → `POST /act` 提交动作。
服务端只跑世界物理与时间，不做任何推理；本地模型不可用时会退回安全动作，不会卡死世界。

提示词已包含：生存数值（饥饿/体力，在 `self.needs` 里）、背包、心情/目标、
带前置条件的动作表（eat 要灶台旁、fish 要水边…）、上一轮动作成败反馈。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROVIDER` | `ollama` | 也可设为 `openai`（DeepSeek 等兼容接口） |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | 本地 Ollama |
| `MODEL` | `kaelri/qwen3.5-mt:2b` | 本机实测 0.6s/轮；`qwen3:8b` 更聪明但 ~12s/轮 |
| `NUM_CTX` | `2048` | 越小越容易整个塞进显存（8GB 卡重要） |
| `THINK` | `0` | qwen3 思考模式，开了会吃光输出额度导致 JSON 截断 |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | DeepSeek | openai 模式用 |
| `INTERVAL_MS` | `1200` | 决策间隔 |

身份 token 存在 `.local-agent.json`（本机，勿外传）。
⚠️ **客户端停止超过 3 分钟（1800 tick），服务端会把村民还给脚本 AI 并注销 token**——重启本地大脑前需要重新 `--register`（要新邀请码：在你自己的服务端执行 `node tools/invite.mjs new 名字 次数 小时`）。

本机（RTX 5060 8GB + Ollama 0.40.14）实测：

| 模型 | 单轮延迟 | JSON 合法率 | 结论 |
|---|---|---|---|
| kaelri/qwen3.5-mt:2b | ~0.6s | 高（think:false） | ✅ 默认，NPC 反应跟手 |
| qwen2.5vl:7b | ~2.3s | 高 | 可用，稍慢 |
| qwen3:8b | ~12s | 高（必须 think:false） | 质量好但太慢，适合离线复盘 |

8B 级在这台机器上只有 6–13 tok/s（显存被桌面占掉 5.8GB，WDDM 静默溢出到共享内存）；关掉吃显存的程序后会快一些。

## 依赖的服务端接口

| 接口 | 用途 |
|---|---|
| `GET /api/health` | 连通性 + 延迟 + tick/实体数 |
| `GET /api/server` | 世界尺寸、村民数、空闲席位、运行时长 |
| `GET /`（观测站页面） | 观测窗内容，页面内部自行消费 `/api/stream` SSE |

## 注意

- 客户端只读，不含任何写入/管理接口；对世界的操作仍走服务端能力接口。
- 默认示例是明文 HTTP；若要放到公网，请自行在前面加 TLS 反代并把地址改成 `https://`，客户端不做证书校验绕行。
- 世界数据由服务端持有，客户端不做本地存档。
- 服务地址由使用者自行配置（`config.json` 的 `baseUrl`，或 `--base=`）。发布版默认指向本机内核
  `http://127.0.0.1:8090`；连接你自己部署的服务时改这一处即可。
- 服务探测失败一律判为「功能降级」而不是启动失败，断线时可用模式 4 切到本地内核继续观测。

---

## 整盘进度

本目录只是 PC 观测端。世界内核、观测器、地图、SSE 协议与验收结果的统合视图，
见仓库根目录 [`README.md`](../README.md) 与 [`docs/02-实现进度.md`](../docs/02-实现进度.md)。
