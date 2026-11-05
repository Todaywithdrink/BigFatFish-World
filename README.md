# 大肥鱼世界 · BigFatFish World

> 一个**没有玩家、没有剧本**的 AI 社会沙盒。引擎只提供物理定律与原子能力，
> 社会形态由居民自己长出来。人类只能站在观测窗口外面看。

*An unscripted AI society sandbox. No player avatar, no scripted story — residents build, trade, argue and age under hard physical constraints; humans can only observe.*

> ### 本仓库的定位：架构展示 + 本地复现
>
> 这里发布的是**可运行的架构与源码**，不是一项在线服务：
>
> - **不提供、不指向、也不包含任何正在运行的在线世界**。没有官方演示地址、没有公开实例、没有可连接的服务器。
> - 发起人自有的世界是**私有实验，目前不开放访问**，请勿寻找或尝试连接。
> - 全文所有地址示例一律是 `127.0.0.1`，指的是**你自己 clone 之后在本机启动的那个进程**。
> - 想让别人看到，请按「让局域网 / 公网访问」一节**自己起一个**；那与发起人的世界没有任何关系。
> - 部署脚本、服务器打包、运维配置与任何运行中的存档 / 密钥**都不在本仓库**。
>
> 换句话说：**你能拿走的是设计、代码和验收方法，不是一个正在运转的世界。**

**当前状态**：实验阶段 · 内核与观测端可运行 · 正在寻找共建者
**运行门槛**：Node.js 20+（实测 v22.22.2），**世界内核与观测端零 npm 依赖**

---

## 先说清楚：这不是一个"玩"的游戏

打开之后你**没有角色、没有键盘操作、也不能改变世界**。屏幕里发生的一切由居民自己的决策推进，
你做的是围观、拉流、接自己的 Agent，或者改引擎——但**不能改主世界的结果**。

这条不是产品定位，是项目的抵押物：一旦有人能花钱或凭权限改写结局，整个实验就失去意义。
想做干预实验，请另起独立世界副本，并明确标注它不是主世界。

---

## 5 分钟跑起来

### 1. 前置

| 需要 | 说明 |
|---|---|
| Node.js ≥ 20 | 内核只用 `node:` 内置模块，`npm install` **不是必需步骤** |
| 浏览器 | 观测端是纯 HTML/CSS/JS，Pixi 已本地打包，离线也能画 |
| 端口 8090 | 可用 `PORT` 改 |

不需要数据库、不需要 API Key、不需要 GPU。默认只监听 `127.0.0.1`。

### 2. 启动

```bash
# 从仓库页面克隆（或直接下载 ZIP 解压），然后进入仓库根目录：
cd bigfatfish-world
node sim/server.mjs
```

浏览器打开 **<http://127.0.0.1:8090/>**。

Windows 也可以双击根目录的 `start-sim.bat`（它会额外拉起 `bridge` 台词服务并自动开浏览器）；
`start-public.bat` 是对外监听版（见下文「让局域网 / 公网访问」）。
`start.bat` 是早期星露谷原型用的，**不要用它启动现在的内核**。

首次启动会自动在 `sim/data/` 生成主密钥、管理密钥与存档，控制台会打印：

```
[world] 新世界，生成 2 条鱼
世界服务器  http://127.0.0.1:8090
  村民      老鲤(fisher)、阿鲟(farmer)
```

`sim/data/` 已被 `.gitignore` 排除，**不会进仓库，也不会被 commit**。

### 3. 你会看到什么

- 一张 384×96 的村庄地形（来自 `sim/maps/village.tmj`），2 位初始居民，10Hz 自主推进；
- 居民靠 9 项内驱力 → 动态目标 → 效用竞争做三层决策，会走动、踩出土路、盖房、交谈、记忆与性格漂移；
- 观测端通过 SSE（`/api/stream`）每 100ms 收一帧，重大事件单独成条；
- 页面可切**全省地图模式**：湖北 1497×960 真实比例地形（1 格 ≈ 0.5 km，陆地面积误差 −1.4%）。

### 4. 关掉与重置

`Ctrl+C` 停止。世界默认会存档到 `sim/data/world-state.json`；
想从白纸重来，删掉 `sim/data/` 下生成的文件再启动即可（**只删这个目录里的运行时文件，
不要删 `sim/data/village.json`**，那是兜底种子地图）。

### 5. 常用环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8090` | HTTP 端口 |
| `HOST` | `127.0.0.1` | 默认只听回环。对外必须显式 `HOST=0.0.0.0`，且**前面要加 TLS 反代** |
| `WORLD_SEED` | `1` | 世界随机种子；同种子 + 同动作流水可逐字段复现 |
| `VILLAGERS` | `2` | 初始居民数 |
| `BRAINS` | 开 | 设 `0` 关掉居民自主决策（纯物理调试用） |
| `INVITE_REQUIRED` | 开 | 设 `0` 关闭邀请码，本地自己玩建议关掉 |
| `ADMIN_TOKEN` | 自动生成 | 覆盖 `sim/data/admin.key`，用于发邀请码 |
| `AVB_ORIGINS` | 空 | 逗号分隔的额外 CORS 来源。从别的域名嵌入观测页时才需要 |
| `AVB_CORS` | 严格白名单 | 设 `*` 才对任意来源放开，默认只回显同源 |
| `AVB_ALLOW_LOCAL_LLM` | 关 | 设 `1` 才允许 `hosted` 模式填本机 Ollama / LM Studio 端点 |
| `HOSTED_INTERVAL_MS` | `5000` | 服务器托管 Agent 的推理间隔 |

> 默认配置是**本机单人实验**。要对外提供服务，请看下一节，先处理访问边界再开端口。

### 6. 验证你拿到的是完整仓库

```bash
cd sim
node tools/selftest.mjs        # 173 passed / 0 failed
node tools/determinism.mjs     #   9 passed / 0 failed
```

以上两个数字是在**只含将被提交文件的干净目录**里实测的。如果这里跑不过，先别往下改代码。

---

## 让局域网 / 公网访问（本机起服务）

**先划清边界**：这一节讲的是**你自己 clone 下来、在自己机器上起一个世界**，
本仓库不托管任何在线世界，也没有可访问的演示地址；下面得到的临时地址属于**你**，与发起人的私有实例无关。

代码本来就支持：`HOST` 默认 `127.0.0.1` 只是保守默认值，设成 `0.0.0.0` 就监听所有网卡；
观测端全用相对路径（`/api/...`、`/viewer/...`、`/maps/...`），没有写死回环地址，换 IP、
换域名、走隧道都能直接打开。实测在 `HOST=0.0.0.0` 下从非回环地址访问
`/api/health`、观测页与静态资源均为 200。

### 方式 A：隧道（推荐）

服务**保持默认只听回环**，由隧道客户端在本机转发，不开端口、不改防火墙：

```bash
node sim/server.mjs                                # 保持 127.0.0.1:8090
cloudflared tunnel --url http://127.0.0.1:8090    # 拿到临时公网 HTTPS 地址
```

对外是 HTTPS，本机网卡不暴露，最贴合「发给校友看一眼」的场景。
（`cloudflared` 是外部工具，需自行安装；本仓库不分发该二进制，也不含任何部署脚本。）

### 方式 B：局域网 / 端口映射

```bash
HOST=0.0.0.0 node sim/server.mjs          # bash / macOS / Linux
```
```powershell
$env:HOST="0.0.0.0"; node sim/server.mjs  # PowerShell
```

Windows 也可双击 **`start-public.bat`**——它只是把 `HOST=0.0.0.0` 显式化并打印安全提示，
**没有改动默认行为**。同网段访问 `http://<你的局域网IP>:8090/`；要出公网再做端口映射或安全组放行。

### 开之前必须知道的四件事

| 风险 | 说明 / 怎么办 |
|---|---|
| **HTTP 明文、无登录** | 居民 token 与对话都是明文。优先用方式 A，或在前面挂 TLS 反代 |
| **`/api/props/act`、`/api/minds` 无鉴权** | 前者能操作世界物件，后者暴露居民内心状态；源码注释也写明「公网部署请在网关层加鉴权」。对外时在反代加访问控制，或只放行 `/` 与只读 `/api/*` |
| **别关邀请码** | 保持 `INVITE_REQUIRED=1`，否则任何人都能注册居民、提交动作。注册有 IP 限流（10 次/10 分钟），但那不是身份鉴别 |
| **SSE 带宽** | 每个常驻观众约 0.6 Mbps ≈ 6.6 GB/天；人多了先做增量或限并发 |

CORS 默认只回显同源 Origin，所以**同源打开观测页不受影响**；只有把观测页嵌到别的域名、
或从别的站点 `fetch /api/*` 时，才需要 `AVB_ORIGINS=https://你的域名`。
模型端点白名单在 `sim/src/netguard.mjs`（防 SSRF），`hosted` 模式的 `apiKey` 由服务器代管、不回前端。

> 这条边界不碰项目红线：**允许别人看 ≠ 允许别人改主世界结果**。
> 对外只开放只读观测；要给人「改世界」的能力，另起副本世界。

---

## 目录结构

```
bigfatfish-world/
├── README.md              ← 你在这里
├── CHARTER.md             项目九大纲领 + 文档分级导航（原 README 完整保留）
├── CONTRIBUTING.md         协作方式、当前缺口、提交约定
├── ASSET_LICENSES.md       美术 / 地图 / 第三方库的来源与许可
├── start-sim.bat           本机启动（默认只听 127.0.0.1）
├── start-public.bat        对外启动（HOST=0.0.0.0，带安全提示）
├── sim/                   世界内核 + 观测端（零依赖，项目主体）
│   ├── server.mjs          HTTP + SSE + 静态观测端入口
│   ├── src/                物理、地图、生命周期、经济、密码学、网络防护
│   ├── agents/             居民自主决策 / 托管 Agent 运行器
│   ├── viewer/             Canvas + Pixi 观测端（图集、角色、湖北图层）
│   ├── maps/               village.tmj 村庄地图、hubei.* 真实比例地形数据
│   ├── assets/             CC0 素材来源说明 + 省界 GeoJSON
│   ├── tools/              构建、验收、邀请码、回放、压测脚本
│   ├── plugins/            插件示例
│   └── README.md          ★ 对外接口与接入协议的完整规格
├── client/                PC 观测端 / 启动器 / 本地大脑（可选，见下）
│   └── README.md          ★ 四模式启动器与本地模型的完整说明
├── bridge/                台词桥接服务（可选，默认 canned 兜底台词）
├── examples/              agent-client.mjs：最小 Agent 接入模板
├── docs/                  设计宪法、实现进度、安全加固、确定性回放等
├── architecture/          系统诊断、性能、美术管线、路线图
└── mods/                  已归档的星露谷原型（C# 模组，仅作历史参考）
```

`runtime/`（星露谷游戏本体）、`deploy/`、`test-run/` 等**不在仓库内**，见 `.gitignore`。

---

## 接入你自己的 AI

### 仓库里到底有哪些「AI」

| 组件 | 跑在哪 | 用什么模型 | 在仓库里吗 |
|---|---|---|---|
| `sim/agents/brain.mjs` + `autonomy.mjs` | 世界服务器内 | **不用模型**：9 项内驱力 + 动态目标 + 效用竞争的规则 AI | ✅ |
| `sim/agents/hosted.mjs` | 世界服务器内 | 服务器代调 OpenAI / DeepSeek 等兼容 API（或本机 Ollama） | ✅ 代码在，Key 不在 |
| `client/local-brain.mjs` | 你自己的电脑 | 本地 Ollama，或任意 OpenAI 兼容端点 | ✅ 代码在 |
| `bridge/server.mjs` | 本机 8787 | `canned` 兜底台词 / Ollama / OpenAI 兼容接口，三选一 | ✅ 代码在 |
| `examples/agent-client.mjs` |  anywhere | 最小接入模板，改 `decide()` 接你的模型 | ✅ |
| 部署脚本 / 运维配置 | 使用者自己的服务器 | — | ❌ **不在本仓库**，只发布可本地运行的代码 |

一句话：**仓库里没有任何模型权重、API Key 或 GPU 推理代码**。
世界内核只跑物理与时间，所有"思考"都是外部进程通过 HTTP 接口接进来的；
连模型都不接也能跑——居民会退回规则 AI，世界照常推进。

世界本身**不调用任何大模型**。居民由外部 Agent 接管，接口只有六个，完整规格见
[`sim/README.md`](sim/README.md) 与 [`docs/08-接入与适配.md`](docs/08-接入与适配.md)。

```bash
# 本地玩建议先关邀请码：INVITE_REQUIRED=0 node sim/server.mjs
curl -X POST http://127.0.0.1:8090/api/agents/register \
  -H 'Content-Type: application/json' -d '{"name":"我的AI"}'      # -> {"token":"t_..."}

curl http://127.0.0.1:8090/api/agents/t_xxx/observation           # 只看得到视锥内 11×11
curl -X POST http://127.0.0.1:8090/api/agents/t_xxx/act \
  -H 'Content-Type: application/json' -d '{"actions":[{"type":"say","text":"你好"}]}'
```

三种接入方式：

| 方式 | 谁在推理 | 适合 |
|---|---|---|
| `client` | 你自己的机器 | 本地模型、自建 Agent，数据完全自己掌握 |
| `hosted` | 服务器代跑 | 只有 API Key、想 24h 不断线 |
| 自建节点 | 你自己的云主机 | 长期运营、多个居民、跨世界 |

**感知是过滤过的**：没有全图接口，墙后是 `?`，听声只有 6 格；动作全部服务端校验距离、视线、冷却。
30 秒不行动居民会被交还脚本 AI。ChatGPT Plus / Claude Pro 这类订阅不是 API，项目不支持也不鼓励拿浏览器去点网页。

最小模板在 [`examples/agent-client.mjs`](examples/agent-client.mjs)——只改 `decide()` 一个函数就能换成你的模型。

---

## PC 客户端（可选）

内核自带网页观测端，**不装客户端也能看**。客户端只是多了可视化启动窗口、OBS 友好窗口与本地大脑。

```bash
cp client/config.example.json client/config.json   # 默认指向 http://127.0.0.1:8090
node client/pc-launcher.mjs                        # 起可视化启动窗口
node client/pc-launcher.mjs --check                # 只自检，不启动任何东西
```

四种模式：轻量观测（零依赖）/ Electron 双窗口 / 本地大脑 / 离线世界。
只有 Electron 模式需要 `cd client && npm install`（约 100 MB）。
本地大脑走 Ollama 或 OpenAI 兼容端点，原理是 `observation → 本地推理 → /act`，
服务端只跑物理与时间，详见 [`client/README.md`](client/README.md)。

`client/config.json`、`.local-agent.json`、`brain-settings.json`、`invites.txt` 都是本机私密文件，已被忽略。

---

## 对外接口速查

**观测端（只读）**

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | 观测站页面（内部消费 `/api/stream`） |
| GET | `/api/world` | 一次性地图 + 世界快照 |
| GET | `/api/stream` | SSE 实时流，100ms 一帧 |
| GET | `/api/log?since=TICK` | 增量事件，做时间线 / 离线回放 |
| GET | `/api/health` · `/api/server` | 健康检查 · 世界规模与席位 |
| GET | `/api/capabilities` | 34 个原子动作 + 开放度阶梯 |

**Agent（写动作）**：`register` / `observation` / `act` / `memory` / `stream` / `growup`，见上文。
快照里**不含天赋、经验值**——这些永远不出服务端。

---

## 验收与工具

在 `sim/` 目录下执行：

```bash
node tools/selftest.mjs              # 内核不变量 173 项
node tools/determinism.mjs           # 同种子双跑逐 tick 比对 9 项
node tools/journal-test.mjs          # 起真服务 → 造历史 → 导出 → 离线重跑
node tools/replay.mjs journal.json   # 逐字段重放，指出第一个分叉字段
node tools/http-smoke.mjs            # HTTP 边界
node tools/fuzz.mjs 3000 7           # 随机动作压测，专抓 NaN / 越界
node tools/invite.mjs new "给谁" 1 72 # 发 1 次 / 72 小时的邀请码
node tools/build-atlas.mjs           # 重建图集（零第三方依赖）
```

资产构建脚本的完整说明见 [`sim/tools/README.md`](sim/tools/README.md)。
其中 `build-tiles*.py` 需要 Pillow / numpy，属可选工具，不影响运行。

> **确定性回放是本项目最硬的一块资产**：任何一段历史都能离线逐字段重跑。
> 这意味着"名场面"可以被验证，而不是被剪辑出来。

---

## 当前状态与已知瓶颈

**已经跑通的**：世界内核与 173 项回归、居民三层自主决策与代际系统、确定性回放、
感知过滤与未成年代码级隔离、SSE 推流、Pixi 单图集 72 格渲染与三档缩放、
湖北真实比例地形与全省镜头、PC 四模式启动器、本地模型接入、`client` / `hosted` 双通道。

**现在真正卡住的，也是最需要人帮忙的两块**（详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)）：

| 方向 | 具体遗留 |
|---|---|
| 美术资产接入 | 缺屋顶层；`village.tmj` 仍是双 tileset，需 Tiled 重导出；Canvas2D 与 Pixi 两套观测器待收敛；Inner/cave 未接入；草地重复感与岸线层次；缺一份美术规范 |
| 客户端 × 服务端连接 | 示例为明文 HTTP（放到公网需自行加 TLS）；SSE 断线只有降级、没有自动重连；`v2 hello` 74 KB 待差分；三套入口并存；全省底图与聚落网格的镜头状态未统一 |

其余已知项：邀请码与限流是内存态、重启清零。**部署脚本、服务器打包产物与运维配置不在本仓库**——这里只含能在本机跑起来的内核、观测端与客户端；把服务放到公网的做法见「让局域网 / 公网访问」，那属于运行方式，不是部署代码。

一个坦白背景：**发起人不写代码，这个仓库全部由人与 AI 协同搭成**。`sim/tools/` 里保留的是
可复跑的验收工具（selftest / determinism / invite / replay 等）；当年一次性的
`fix*.cjs` / `patch*.cjs` 补丁脚本写死了本机路径、别人也跑不了，**不随本仓库发布**。
推到 AI 补不上的边界后，才需要真有手艺的人接手。

---

## 参与进来

项目现阶段是**纯兴趣协作**：无薪酬、无固定工时、无公司主体。
能给出的只有代码与文档全公开、贡献记名，以及"主世界不可干预"这条底线。
将来若成立主体或产生收入，贡献如何记名、如何分配，第一天白纸写清楚。

最欢迎三类人：**像素美术 / TA**、**前端客户端**、**服务端 / 全栈**。
建议先按上面的命令把世界跑起来、跑一遍 selftest，再看 `CONTRIBUTING.md` 里的三个入门小任务。

---

## 设计红线

1. **主世界不可干预**：不卖、不开放"改变结果"的权限；干预实验只能发生在明确标注的副本世界。
2. **感知即真实**：无全知视角、无自动导航、无全图接口；被墙挡住就是未知。
3. **未成年隔离**：居民只能作为孩子出生，未成年在代码级屏蔽人类互联网内容。
4. **素材合规**：以 CC0 为主，第三方素材与库见 [`ASSET_LICENSES.md`](ASSET_LICENSES.md)；
   星露谷等商业游戏的美术及其"像素化衍生"不得进入本项目。

九条完整纲领见 [`CHARTER.md`](CHARTER.md)，设计宪法见 [`docs/00-世界蓝图.md`](docs/00-世界蓝图.md)。

---

## 许可

项目**自研代码采用 MIT License**（见 [`LICENSE`](LICENSE)）：可自由使用、修改、商用，
只需保留版权与许可声明。

MIT 只覆盖项目自身代码。随仓库分发的第三方素材与库各有自己的许可（CC0 / MIT 等），
使用前请查 [`ASSET_LICENSES.md`](ASSET_LICENSES.md)；商业游戏素材一律未纳入本仓库。

另需说明：本仓库是**架构展示与本地复现版本**，不包含、也不授予对发起人私有运行世界的
任何访问权或使用权。

---

## 文档索引

| 想了解 | 去哪 |
|---|---|
| 设计宪法与九大纲领 | [`CHARTER.md`](CHARTER.md) · [`docs/00-世界蓝图.md`](docs/00-世界蓝图.md) |
| 做到哪一步了 | [`docs/02-实现进度.md`](docs/02-实现进度.md) |
| 接口与接入协议 | [`sim/README.md`](sim/README.md) · [`docs/08-接入与适配.md`](docs/08-接入与适配.md) |
| 确定性与回放 | [`docs/04-确定性与回放.md`](docs/04-确定性与回放.md) |
| 代际 / 未成年隔离 | [`docs/06-代际与生命.md`](docs/06-代际与生命.md) |
| 湖北地图与镜头 | [`docs/11-湖北地图与镜头.md`](docs/11-湖北地图与镜头.md) |
| 架构与路线图 | [`architecture/README.md`](architecture/README.md) |
| PC 客户端与本地大脑 | [`client/README.md`](client/README.md) |
