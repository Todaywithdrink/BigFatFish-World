# 01 - 架构诊断与技术债审查 (Architecture Diagnosis)

## 1. 现有代码资产审查 (Code Review)

经过对当前核心代码模块（[`sim/src/world.mjs`](../sim/src/world.mjs)、[`sim/src/map.mjs`](../sim/src/map.mjs)、[`sim/src/economy.mjs`](../sim/src/economy.mjs)、[`sim/agents/brain.mjs`](../sim/agents/brain.mjs)、[`sim/server.mjs`](../sim/server.mjs)）的深度审查，从工业级游戏引擎视角给出评定：

### 1.1 架构亮点（极其优秀的工程决策）

1. **逻辑内核与渲染彻底分离（Headless Core）**
   - 服务端仅依赖标准 Node.js ES Modules，无任何 DOM 或渲染包依赖。
   - `World` 采用严格的 10Hz（100ms）离散 Tick 步进循环，状态演进具备确定性。
   - 前端通过纯只读 SSE `/api/stream` 和 `/api/world` 消费数据，支持任意前端（Canvas/网页/OBS/多端）接入。

2. **服务端物理强校验（Authoritative Server）**
   - 绝不相信客户端或大模型提议的任意状态改变。
   - 动作系统封装了视距（8格）、视锥角度（120° FOV）、门墙阻隔、高度差限制、动作冷却（CD）。模型提议不合法直接打回并给出 `reason`，杜绝模型幻觉造成世界状态破坏。

3. **微观经济机制的高度沙盒化**
   - 摒弃官方统一物价，采用面对面双向报价撮合（`quote` -> `accept` / `decline`）。
   - 支持 `allowCredit`，将债务直接沉淀在双方内存记账本中，为后续的违约、讨债与社会秩序演化预留了底层原语。

---

## 2. 三大系统级隐患与技术债 (Critical Architectural Risks)

尽管底层理念先进，但当前实现仍有几处单点瓶颈，若直接推向多人/数十个 AI 并行，将触发系统级雪崩：

### 隐患一：全量广播导致的网络与 CPU 序列化雪崩（O(N × M) 瓶颈）

* **现状代码**：
  [`sim/server.mjs`](../sim/server.mjs) 每 100ms 调用一次广播：
  ```javascript
  const payload = JSON.stringify(world.snapshot());
  for (const client of sseClients) {
    client.res.write(`data: ${payload}\n\n`);
  }
  ```
* **瓶颈剖析**：
  1. `world.snapshot()` 包含了全镇所有村民坐标、朝向、状态、背包、最近 40 条日志。
  2. 若有 $N$ 个活跃村民和 $M$ 个网页/OBS 观众，每秒触发序列化与发送达 $10 \times M$ 次，数据量为 $10 \times M \times \text{Size}(N)$。
  3. 当地图长出多个 Chunk，村民扩充至 50 人、观众达 20 人时，仅 JSON 字符串拼接就会将单个 Node.js 进程的 Event Loop 占满，引发严重掉帧和延迟。
* **重构方案**：转为 **增量差异推流（Delta Sync）** 与 **视口兴趣区域划分（AOI）**。

---

### 隐患二：异步 I/O 阻塞主循环与状态竞争（Async Race Conditions）

* **现状代码**：
  在 [`sim/agents/brain.mjs`](../sim/agents/brain.mjs) 的 `update()` 中，直接执行了异步 `await this.maybeSpeak(partnerId)`，其中包含向远程大模型 API 发起 HTTP fetch。
* **瓶颈剖析**：
  1. 大模型的响应时间是不可控的（通常 800ms ~ 3000ms），而游戏物理世界的 Tick 是 100ms。
  2. 当一个 AI 处于 `await fetch()` 挂起阶段时，主循环继续行进了 20 个 Tick。在此期间：
     - 对话目标可能已经走开或倒地；
     - AI 自身可能已经被攻击或饥饿值耗尽；
     - 回调返回后直接写入可能发生逻辑时空错乱。
* **重构方案**：将认知决策彻底异步化，采用 **Tick 驱动的命令队列模式（Command Queue）**。

---

### 隐患三：内存无界扩张与同步落盘抖动（Persistence Stutter）

* **现状代码**：
  [`sim/src/world.mjs`](../sim/src/world.mjs) 中：
  - `this.patches`、`this.board`、`this.quotes`、`this.pairs` 随时间增长无限制累积；
  - `saveState()` 直接将整棵状态树转为 JSON 写入磁盘。
* **瓶颈剖析**：
  同步 `writeFileSync` 或大体积 JSON 序列化在 Windows NTFS 上写入数百 KB 文件时，耗时可达 10~50ms，必然导致单帧卡顿（Jank）。
* **重构方案**：采用 **环形缓冲区（Ring Buffer）裁剪** + **预写日志（WAL）/ 异步增量写入**。
