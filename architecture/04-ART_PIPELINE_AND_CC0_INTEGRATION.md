# 04 - 开源美术资产工业级管线方案 (Art Pipeline & CC0 Assets)

针对当前项目最严峻的美术短缺与侵权风险问题，本篇给出资深技术美术（Tech Artist）级别的资产替代与自动化图集管线方案。

---

## 1. 资产合规与版权红线

* **绝对红线**：严禁直接或间接提取原版《星露谷物语》（`runtime/stardew`）中的任何贴图、Tilemap、角色 Sprite 或声音文件进行打包分发（包括二次像素化滤镜处理）。任何商用分发都会构成严重侵权。
* **唯一合规之路**：全线切换为 **CC0 (Creative Commons Zero / 公共领域)** 或明确商用友好的开源像素资产。

---

## 2. GitHub AI Town 资产同构解密

经深度技术调研，GitHub 热门项目 `a16z-infra/ai-town` 使用的美术底层：
1. **完全同构**：AI Town 的地图建筑、地块、道路、室内贴图全部采自著名开源资产创作者 **Kenney.nl** 的 **CC0 "Tiny" 系列**；
2. **尺寸对齐**：AI Town 与本项目当前使用的素材均基于 **16×16 像素网格**；
3. **法律许可**：全部为 **CC0**，允许免署名、允许自由商用、允许修改和再分发。

> **结论**：本项目与 AI Town 饮水同源，完全可以无缝吸纳其资产组织形式，无需承担任何版权包袱。

---

## 3. 当前资产缺口与现成开源替代矩阵

| 缺失功能场景 | 当前状态 | 推荐 CC0 / 开源替代资源 | 来源与引入方式 |
|---|---|---|---|
| **室内完整家具** (床/灶台/储物箱/货架/地窖) | 只有空壳木板地与墙体 | **Kenney Tiny Dungeon** (已存在于 `_src/tiny-dungeon`) | 立即将地牢/木制家具映射进图集，充当床铺与灶台 |
| **市集摊位与城镇设施** (告示板/水井/长椅/桶) | 部分具备 | **Kenney Tiny City** (已存在于 `_src/tiny-city`) | 引入 91/92 遮阳棚、105 木摊、118 货箱、87 告示牌 |
| **连贯水文与自然动植物** (河流/湖泊岸线/野兽) | 只有单一水色方块 | **Ninja Adventure Asset Pack (CC0)** | 拥有极高质量的 16px 连贯自然水系拼边、瀑布与野生动物 |
| **角色行走与工作动画** (8向/4向多动作行走图) | 只有单一纯色小鱼圆块 | **AI Town Character Spritesheets (CC0)** / **Pixel Frog Tiny RPG** | 引入带 4 帧循环的 16×16 / 32×32 像素小人动画序列 |

---

## 4. 自动化图集编译管线 (Automated Texture Pipeline)

代码库中已有极佳的自动化脚本 [`sim/tools/build-tiles.py`](../sim/tools/build-tiles.py)。后续扩展规范如下：

```
sim/assets/_src/
  ├── tiny-town/       (地面、树木、木屋建筑)
  ├── tiny-battle/      (水体底色)
  ├── tiny-city/        (城镇基础设施、摊位、路灯)
  └── tiny-dungeon/     (室内家具、床、火把、箱子) -- [待接入]
           │
           ▼  执行 python sim/tools/build-tiles.py
sim/viewer/
  ├── tiles.png        (由 8×5 扩容为 16×16 的统一全局图集)
  └── tiles.js         (自动生成全局常量表: TILE_BED, TILE_STOVE, TILE_CHEST...)
```

### 室内家具扩展清单（下一步接入）
在 `build-tiles.py` 中增加如下条目映射：
```python
# 来自 Tiny Dungeon
TILE_MAP["bed"] = td(42)       # 木床
TILE_MAP["stove"] = td(65)     # 烹饪石灶
TILE_MAP["chest"] = td(89)     # 储物箱
TILE_MAP["shelf"] = td(90)     # 货架
TILE_MAP["torch"] = td(112)    # 室内壁灯
```
仅需运行一次 Python 脚本，Canvas 观测器即可立即绘制带床铺与火炉的生动室内场景。
