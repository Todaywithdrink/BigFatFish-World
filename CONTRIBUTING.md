# 共建指南 · CONTRIBUTING

先按 [README](README.md) 的「5 分钟跑起来」把世界启动，再跑一遍
`cd sim && node tools/selftest.mjs`。能跑通再往下看——这一步能筛掉 90% 的环境问题。

## 现在的真实处境

- 项目是**纯兴趣协作**：无薪酬、无固定工时、无公司主体、没有例会。
- 发起人不写代码，仓库由人与 AI 协同搭成；代码里有一批一次性 `fix*.cjs` / `patch*.cjs`
  历史脚本，它们是当时的修复痕迹，不是推荐入口。
- 能给的只有：代码与文档全公开、**贡献记名**、以及一条底线（主世界不可干预）。
- 将来若成立主体或产生收入，贡献如何记名、如何分配，**第一天白纸写清楚**，不追溯改口。

参与门槛放得很低：**先花半小时看代码给个判断也算帮大忙**，不要求立即投入。

## 最需要人的三个方向

| 方向 | 接手什么 | 交给你的起点 |
|---|---|---|
| **像素美术 / TA** | 屋顶层补完、`village.tmj` 双 tileset 合单图集、草地重复感与岸线层次、Inner/cave 接入、出一份美术规范 | `sim/viewer/`、`sim/assets/README.md`、`sim/tools/build-atlas.mjs`（零依赖，改 `DECO` 清单一处即可）；素材全是 CC0 |
| **前端客户端** | Canvas2D 与 Pixi 双观测器收敛、全省底图与聚落网格的镜头状态统一、三套入口合一 | `sim/viewer/index.html` → `viewer.js` / `geo-layer.js` / `pixi-view.js`；`client/launcher-ui/` 是零构建纯前端 |
| **服务端 / 全栈** | TLS 与对外访问加固、SSE 断线自动重连 + 退避、`v2 hello` 74 KB 差分、多实例状态 | `sim/server.mjs` 的 SSE 段、`sim/src/netguard.mjs`、`client/pc-launcher.mjs`；接口契约见 `client/README.md` |

## 三个入门小任务（任选其一）

1. **环境复现**：在你自己机器上跑通 `node sim/server.mjs` 与 selftest，把遇到的坑写成 issue。
   这对项目很值钱——目前所有验证都只在发起人一台机器上做过。
2. **观测端补一层**：给屋顶或水岸加一组图集格，跑一次 `build-atlas.mjs`，贴前后对比图。
3. **连上不中断**：给 SSE 客户端加断线重连（指数退避 + 断线提示），用手动 kill 服务端验证。

## 协作约定

- **改动先说**：开 issue 或先聊清楚再动手，尤其涉及世界规则、感知过滤、代际与安全的部分。
- **每次改动跑验收**：`selftest.mjs` + `determinism.mjs` 必须全绿；碰过接口再跑 `http-smoke.mjs`。
- **不要提交这些**：`sim/data/` 下任何运行时文件、`client/config.json`、
  `.local-agent.json`、`brain-settings.json`、`invites.txt`、任何 `.key` / `.env`。
  它们都已在 `.gitignore` 里，但请顺手 `git status` 看一眼。
- **`.bat` 入口保持纯 ASCII + CRLF**：cmd 会按 ANSI 逐行读，中文正文 + LF 会让命令跳行。
  中文提示写进 `pc-launcher.mjs`，或跑 `node client/pc-launcher.mjs --repair` 让模板重建。
  详见 [`client/README.md`](client/README.md) 的「为什么以前一更新就打不开」。
- **文档先行**：设计意图落在 `docs/`，实现落地后更新 [`docs/02-实现进度.md`](docs/02-实现进度.md)。
- **英语/中文都行**，issue 与 PR 描述清楚「改了什么、怎么验的」即可。

## 不能碰的红线

1. **主世界不可干预**：不新增任何能改写主世界结果、历史或居民命运的后台权限。
   干预实验只能另起独立副本世界，并明确标注。
2. **感知过滤不能开后门**：不加全图接口、不绕过视线遮挡、不泄露天赋与经验值。
3. **未成年隔离**：居民只能作为孩子出生，未成年代码级屏蔽人类互联网内容。
4. **素材合规**：只用 CC0 或有明确许可并署名的素材；星露谷等商业游戏美术
   （含"像素化一下"的衍生）不得进入项目。见 [`ASSET_LICENSES.md`](ASSET_LICENSES.md)。

## 联系

最方便的方式是在本仓库开一个 **Issue**，或直接回复你收到本仓库链接的那个渠道。

讨论技术方案、提交补丁、素材许可与署名问题都欢迎走 Issue——便于留痕，
也方便后来的人看到同样的结论。发起人不承诺响应时间，但每条都会看。
