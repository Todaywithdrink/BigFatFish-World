# 美术资源

两条规矩：**能 CC0 就 CC0**，**同一屏里不混风格**（Kenney Tiny 系列是粗描边、平涂 16px；
没有描边的包放进来，一眼就能看出来不是一套）。

## 已接进游戏

| 包 | 许可 | 稿件 | 用在哪 |
|---|---|---|---|
| Kenney **Tiny Town** 1.1 | CC0 | `tiny-town/Tilemap/tilemap_packed.png` | 草地、小路、树、围栏、石头、墙、地板、门、屋顶 |
| Kenney **Tiny Battle** | CC0 | `tiny-battle/...` | 水面（Tiny Town 没有水） |
| Kenney **Tiny City** | CC0 | `tiny-city/...` | 路灯、长椅、木桶 |

图集由 `sim/tools/build-tiles.py` 生成（`viewer/tiles.png` + `viewer/tiles.js`），
改素材只要跑这一条命令。

渲染逻辑在 **`viewer/art.js`**（独立模块，不依赖 viewer.js），按原生低分辨率画布设计：
每格 16px、1:1、坐标取整、只放大画布不放大图元。自检页 `viewer/art-preview.html`。
viewer.js 的接入点见 **`assets/INTEGRATION.md`**（5 处调用，不需要在里面写美术代码）。

树的颜色是在 `build-tiles.py` 里把橙树 TT15/TT3 转色相得到的绿色版本——
Tiny Town 的纯树冠图（TT5）在 1:1 下看着像个灰绿色拱门，带树干的那张才认得出是树。

## 已下载、还没接线

| 包 | 许可 | 里面有什么 | 打算怎么用 |
|---|---|---|---|
| Kenney **Tiny Dungeon** | CC0 | 同一套画风的地牢墙地、门、货架、宝箱、木桶、火把、角色、武器药水 | 屋内家具（床/柜/灶台的替身）、地窖 |
| Kenney **Pirate Pack** | CC0 | 沙滩岛、水、石头、码头、船、炮、爆炸 | **风格不匹配**（无描边、晕染感），只适合单独一个"海边"场景，别和 Tiny 系列混 |
| OGA **16x16 Pigeon, Shrimp, Bee, Snail** | **CC-BY 4.0** | 鸽子/虾/蜜蜂/蜗牛各几帧 | 镇上飞的海鸥、码头上的鸟。**必须署名**，见 `oga-birds/` |

## 还没拿到（这台机器上 itch.io 连不上）

| 包 | 许可 | 说明 |
|---|---|---|
| Ninja Adventure Asset Pack（Pixel-Boy） | CC0 | 量大：动物、树木、花草、房子、人物、道具，16px。**最值得补的一个** |
| Sprout Lands（Cup Nooble） | 免费版仅个人/非商用 | 最像星露谷的一套，商用要买 |
| Mystic Woods（Game Endeavor） | 免费版需看条款 | 森林、动物、UI |
| LPC 合集（OpenGameArt） | CC-BY-SA 3.0 | 32px，量大，但**传染**：改了要同许可 |
| Kenney Animal Pack | CC0 | 是 3D 模型，要自己渲染成像素图 |

结论：**16px 的 CC0 动物素材是缺口**。三条路——Ninja Adventure（最省事，但要能上 itch.io）、
LPC 动物（32px，要署名+同许可）、或者用 Kenney 的 3D 动物渲染成 16px 精灵（一次性投入，之后随便扩）。

## 下一步的接线清单（照现在的写法）

1. `build-tiles.py` 加条目 → `viewer/tiles.js` 自动多出名字。
2. 平铺在地面的（草/路/水/地板）→ 在 `groundSprite()` 里映射。
3. 有高度的（树/围栏/石头/摊位）→ `isHouse()` 那种判断交给 `drawProp()`，进 y 排序层。
4. 需要自动拼边的（路、水岸）→ 学 `pathMask()` 预合成 16 种邻接块。

已经量好的候选（Tiny City 的编号，看 `tiny-city` 的 tilemap）：91/92 white awning（摊位顶棚）、
96 鱼形招牌（渔村正好）、105/106 木摊、110~113 长椅、118 木箱、67~71 各种树。

## 许可红线

星露谷（`runtime/stardew`）的美术不能进这个项目，哪怕是"像素化一下"——那仍然是衍生作品。
见 `docs/架构与路线.md` 第 5 节。
