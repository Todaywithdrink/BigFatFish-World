# 05 - 技术落地路线图与工程里程碑 (Roadmap & Milestones)

以专业游戏主程与架构师的节奏，将整体演进划分为 4 个清晰交付的工程里程碑。

---

## 里程碑 M1：视觉丰满与荒野基础 (Visuals & Wild Exploration)
**核心目标**：彻底摆脱“空壳小镇”与“纯色几何块”，建立舒适的观赏感与基础拓荒感。

- [ ] **Task 1.1: 室内家具图集接入**
  - 在 [`sim/tools/build-tiles.py`](../sim/tools/build-tiles.py) 中接入 `_src/tiny-dungeon` 的床、灶台、储物箱；
  - 重新编译生成 `viewer/tiles.png` 和 `viewer/tiles.js`；
  - 在 [`sim/viewer/viewer.js`](../sim/viewer/viewer.js) 的房屋渲染层中绘制床铺与灶台。
- [ ] **Task 1.2: 踩踏成路算法实现**
  - 在 [`sim/src/world.mjs`](../sim/src/world.mjs) 的移动逻辑中累加地块 `trample` 计数；
  - 超过阈值后自动将地块切为 `dirt_path`；
  - 赋予泥路微量移速加成，观测村民自然踩出的路线网。
- [ ] **Task 1.3: 基础水文连贯算法**
  - 在 [`sim/src/grow.mjs`](../sim/src/grow.mjs) 中优化新 Chunk 生成逻辑，用梯度连贯水系替代孤立水块。

---

## 里程碑 M2：通信重构与性能飞跃 (High-Performance Sync)
**核心目标**：支撑 50+ 村民稳定运行，消除网络与 CPU 广播瓶颈。

- [ ] **Task 2.1: Delta 增量推流改造**
  - 重构 [`sim/server.mjs`](../sim/server.mjs) 的 `/api/stream`；
  - 仅在初次连接时下发全量，随后每帧计算并广播只包含 `moved`、`events`、`patches` 的 Delta 包；
  - 在前端 Canvas 引入 Lerp 位置平滑插值。
- [ ] **Task 2.2: 异步 Action 命令队列固化**
  - 在 [`sim/agents/brain.mjs`](../sim/agents/brain.mjs) 中将大模型调用与 Tick 解耦；
  - 实行“异步请求 -> 放入 pendingActions -> 10Hz Tick 逐帧消费”的标准流水线。

---

## 里程碑 M3：代际繁衍与双层网络 (Generations & Dual Network)
**核心目标**：实现生命闭环与人类-AI 信息桥接。

- [ ] **Task 3.1: 繁衍与生命周期数据层**
  - 扩充 `Entity` 属性：`ageStage`（infant/youth/adult）、`bornTick`、`affinity`；
  - 实现幼年期动作白名单限制（严禁持有手机、家庭活动圈）；
  - 青年期开放好感度累计与成年结婚建房。
- [ ] **Task 3.2: 双层虚拟论坛 (Cyber BBS)**
  - 建立与世界空间坐标解耦的虚拟论坛服务；
  - 提供 HTTP Webhook 供人类将外部热点帖子导入；
  - 成年村民开放 `browseForum` / `postForum` 交互。

---

## 里程碑 M4：社会契约与自组织政府 (Emergent Governance)
**核心目标**：实现原住民自发治理、信用违约与自制插件。

- [ ] **Task 4.1: 广场实体留言板与黑名单信用**
  - 建立广场物理留言板对象，支持走近 3 格读写；
  - 村民发生欠债不还或逃跑时，受害方写入留言板曝光。
- [ ] **Task 4.2: 原住民玩法插件组合系统**
  - 完善 [`sim/src/world.mjs`](../sim/src/world.mjs) 的 `defineProtocolKind`；
  - 支持拍卖会、拼团、契约等原语组合发布在委托板供全镇学习。
