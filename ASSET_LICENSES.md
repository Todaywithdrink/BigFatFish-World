# 素材与第三方许可清单

本文件只说明**随仓库分发的第三方内容**。项目自身代码采用 MIT License，
见根目录 [`LICENSE`](LICENSE) 与 [`README.md`](README.md) 的许可章节。

总原则：**能 CC0 就 CC0，同一屏里不混风格**。仓库里 `sim/viewer/tiles*.png`、
`atlas.png` 等是由下列 CC0 素材拼装 / 程序化派生的图集，构建脚本在 `sim/tools/`。

## 1. 像素美术（CC0 / 公有领域）

| 素材包 | 作者 / 来源 | 许可 | 仓库内位置 | 状态 |
|---|---|---|---|---|
| Kenney Tiny Town 1.1 | Kenney (kenney.nl) | CC0 | `sim/assets/_src/tiny-town/` | 已接入：草地、路、树、围栏、墙、地板、门、屋顶 |
| Kenney Tiny Battle 1.0 | Kenney | CC0 | `sim/assets/_src/tiny-battle/` | 已接入：水面 |
| Kenney Tiny City 1.0 | Kenney | CC0 | `sim/assets/_src/tiny-city/` | 已接入：路灯、长椅、木桶 |
| Kenney Tiny Dungeon | Kenney | CC0 | `sim/assets/_src/tiny-dungeon/` | 已下载，待接入屋内家具 |
| Kenney Pirate Pack | Kenney | CC0 | `sim/assets/_src/pirate/` | 风格不匹配，单独场景备用 |
| Zelda-like Tilesets & Sprites | ArMM1998 / OpenGameArt | CC0 | `sim/assets/_src/zelda-like/` | 装饰资源用；无需署名，礼貌性致谢 ArMM1998 |

各包自带的 `License.txt` 随目录保留。CC0 允许再分发与商用，无需署名。

### 明确未随仓库分发

| 内容 | 原因 |
|---|---|
| OGA《16x16 Pigeon, Shrimp, Bee, Snail》 | **CC-BY 4.0**、尚未接线、且未附署名文件；若将来接入，必须先补署名 |
| 星露谷（Stardew Valley）美术 | 商业游戏资产，即使像素化也属衍生作品；`runtime/` 整体不进仓库 |
| Sprout Lands / Mystic Woods / LPC 等 | 免费版有个人/非商用限制或 CC-BY-SA 传染性，尚未采用 |

详见 [`sim/assets/README.md`](sim/assets/README.md) 的「许可红线」。

## 2. 地图与地理数据

| 内容 | 来源 | 说明 |
|---|---|---|
| 湖北省界 `sim/assets/geo/hubei-boundary.json` | 阿里云 DataV GeoAtlas，`areas_v3/bound/420000.json` | 官方审图口径，无需密钥 |
| `sim/maps/hubei*.bin` / `hubei.json` / `viewer/hubei-stardew*.png` | 由上述边界经 `sim/tools/world-build.mjs` 生成 | 1497×960 格，1 格 ≈ 0.5 km；项目自产数据 |
| `sim/maps/village.tmj` / `sim/data/village.json` | 项目自产 | 村落地图形态，默认启动地图 |

地形、群系与高程通道均由脚本生成，不含第三方栅格底图。

## 3. 第三方代码库

| 库 | 许可 | 位置 | 说明 |
|---|---|---|---|
| PixiJS | MIT | `sim/viewer/pixi.min.js` | 本地打包，离线可用；未做修改 |
| Node.js 内置模块 | — | `sim/src/**` | 世界内核零第三方运行时依赖 |
| Electron | MIT | `client/package.json`（devDependency） | **不随仓库分发**，仅 Electron 模式 `npm install` 时拉取 |

`mods/AiVillagers/` 是发起人自写的 C# 星露谷模组原型，仅作历史归档；
它依赖 SMAPI 与星露谷本体，但仓库**不含任何游戏本体文件**。

## 4. 不得再分发的参考材料

`docs/dst/*.lua` 是《饥荒：联机版》(Klei Entertainment) 的官方游戏脚本摘录，
当初只用于本地设计参考（睡眠、昼夜、数值调参）。**它们已在 `.gitignore` 中排除，
不得推到公开仓库**。若你本地还有这些文件，请勿取消忽略规则。

## 5. 新增素材时的检查

1. 许可是否允许再分发与商用？CC-BY / CC-BY-SA 需评估署名与传染性。
2. 画风是否与 Kenney Tiny 系列（粗描边、平涂 16px）一致？不混风格。
3. 是否把 `License.txt` 一并放进 `sim/assets/_src/<包名>/`？
4. 在 `sim/tools/build-atlas.mjs` 的 `DECO` 清单登记，别手改生成图。
5. 更新本文件与 `sim/assets/README.md`。
