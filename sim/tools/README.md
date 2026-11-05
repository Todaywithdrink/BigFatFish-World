# sim/tools —— 资产与验收工具

## 世界地图构建（输出到 `sim/maps/`）

| 脚本 | 依赖 | 作用 |
|------|------|------|
| `world-build.mjs` | **无**（Node 内置） | 省界 GeoJSON → 真实比例群系网格 + 高程通道 + 预览图 |

```bash
node sim/tools/world-build.mjs
```

产出：

| 文件 | 内容 |
|------|------|
| `sim/maps/hubei.bin` | 群系码，1 字节/格（1497×960 = 1.37 MB） |
| `sim/maps/hubei.elev.bin` | 高程，1 字节/格，12 m 为单位（渲染层做山体阴影用） |
| `sim/maps/hubei.json` | 投影参数、图例、城市锚点、统计 |
| `sim/viewer/world-preview.png` | 1px/格 全图预览（小地图与审图用） |

**输入数据**：`sim/assets/geo/hubei-boundary.json`，来自阿里云 DataV GeoAtlas
（`https://geo.datav.aliyun.com/areas_v3/bound/420000.json`，官方审图口径，无需密钥）。
换省份只需把 `420000` 换成对应 adcode 并改 `world-build.mjs` 里的 `RIDGES` / `RIVERS` / `LAKES` / `CONTROL` 表。

**为什么是"群系 + 高程"两条通道**：只有群系码时，大面积山地只能靠随机噪点表示，视觉上永远是平涂；
补一路高程后渲染层能做真正的山体阴影（hillshade）与按海拔连续着色，山地才有起伏与立体感。

## 资产构建（输出到 `sim/viewer/`）

| 脚本 | 依赖 | 作用 | 何时跑 |
|------|------|------|--------|
| `build-atlas.mjs` | **无**（Node 内置 zlib） | 一次产出 `atlas.png` + `atlas.js`，含四个分区：地皮 / 道具 / **装饰（多格精灵）** / **水岸过渡（32 变体）** | 新增/替换任何地块、道具或装饰资源后 |
| `build-char.mjs` | **无**（Node 内置 fs） | 校验 `char.png` 帧几何，生成 `char.js`（帧宽高/朝向行/走路帧数） | 美术替换角色图后 |
| `build-tiles.py` | Pillow | 从 `assets/_src/kenney-*` 拼装 `tiles.png`（含 3×3 小路自动拼边） | 改动源素材或瓦片清单时 |
| `build-tiles2.py` | Pillow + numpy | 生成 `tiles2.png`（地皮：草地变体 / 水面 / 土路自动拼边） | 改动地皮配色或拼边规则时 |

> **本次踩过的坑**：`build-tiles*.py` 需要 Pillow/numpy，本机未装时脚本直接报 `ModuleNotFoundError`。
> 因此新增的 `build-atlas.mjs` / `build-char.mjs` 刻意写成**零第三方依赖**，
> 保证任何人 clone 下来都能复现图集与常量表。

### 图集分区结构（`atlas.png`）

```
行 0..3    地皮（原 tiles2.png，32 格）        ← 位置固定，Tiled 的 gid 依赖它
行 4..8    道具/建筑（原 tiles.png，40 格）    ← 同上
行 9..11   装饰资源（从任意源图按像素矩形裁剪，支持 48×47 这类多格精灵）
行 12..15  水岸过渡（16 邻接掩码 × 2 动画帧 = 32 格）
```

**加新资源只改 `build-atlas.mjs` 顶部的 `DECO` 清单**，不要手改 `atlas.png` / `atlas.js`：

```js
const DECO = [
  { name: "well", src: "zelda-like/gfx/Overworld.png", x: 352, y: 144, w: 48, h: 47 }
];
```

构建时会自动校验两件事，任一失败即中止：

1. **回读一致** —— 编码后的 PNG 重新解码必须与内存像素逐字节相同；
2. **地皮区未变** —— 行 0..3 必须与原 `tiles2.png` 完全一致，否则地图会整体错位。

### 水岸瓦片是怎么来的

不依赖源图里恰好有岸线素材，而是按"外圈 1px 实心泡沫 → 每 4px 向内凸一格浪尖 → 浪尖下方压暗一格"
的像素语言，从现有 `water_a` / `water_b` 派生 16 向邻接变体（掩码位：1=北 2=东 4=南 8=西）。
好处是与水色严格同源、永远对得齐；代价是它只是"泡沫线"，没有沙岸/礁石这类更丰富的地貌过渡。

## 资产勘察

| 脚本 | 作用 |
|------|------|
| `sheet-look.mjs` | 按格裁剪源图 → 整数放大 → 叠加红/蓝格线，直接把 CC0 源图当"带坐标的样张"看，用于确认"第几行第几列是什么" |
| `png-codec.mjs` | 共享 PNG 编解码（含 **8bit 调色板 + tRNS** —— Kenney Tiny 系列都是调色板 PNG，早期脚本只认 RGB/RGBA 会直接报错） |

```bash
# 看某张源图的第 22-31 列、第 7-12 行，放大 6 倍
node sim/tools/sheet-look.mjs sim/assets/_src/zelda-like/gfx/Overworld.png 22 7 11 6 6 out.png
```

## 验收

| 脚本 | 作用 |
|------|------|
| `verify-pixi.mjs` | 启动 headless Edge，读取 `window.__pixiDebug()`（FPS / 裁剪数 / 换装缓存 / 夜色 / 装饰数 / 插值状态）并截图，用于回归对比 |
| `determinism.mjs` / `replay.mjs` / `fuzz.mjs` 等 | 模拟内核的确定性与回放校验（与渲染无关） |

```bash
# 白天 / 夜晚 / 各缩放档位各截一张，肉眼比对 docs/review-YYYY-MM-DD/
node sim/tools/verify-pixi.mjs "http://127.0.0.1:8090/viewer/pixi.html?hour=11&zoom=2" docs/review-2026-11-05/day-2x.png
node sim/tools/verify-pixi.mjs "http://127.0.0.1:8090/viewer/pixi.html?hour=22&zoom=2" docs/review-2026-11-05/night-2x.png
```

## 渲染器可用 URL 参数（`/viewer/pixi.html`）

| 参数 | 说明 |
|------|------|
| `?zoom=1..4` | 屏幕像素倍率（只接受整数档，非整数值自动吸附到最近档） |
| `?cam=格x,格y` | 指定相机中心（截图取景用） |
| `?hour=22` | 强制时段色调（验收夜晚/黄昏效果，不影响世界时钟） |

`window.__pixiDebug()` 额外暴露 `deco: { count, well }`（装饰件数 / 水井是否放下），
用于确认装饰层在这张地图上真的生效、而不是被锚点条件全部筛掉。

## 世界观测器可用 URL 参数（`/viewer/world.html`）

| 参数 | 说明 |
|------|------|
| `?zoom=` | `0.0625 / 0.125 / 0.25 / 0.5 / 1 / 2 / 4`（分别对应 1/2/4/8/16px 每格与整数放大） |
| `?x=&y=` | 相机中心（**格**坐标，不是像素） |

验收时通过 `HOOK=__worldDebug node sim/tools/verify-pixi.mjs ...` 读取世界观测器指标
（`fps / zoom / cam / chunks / visibleChunks / bakedTotal / biomeAt`）。

## 安装 Python 依赖

```bash
pip install -r sim/tools/requirements.txt
```
