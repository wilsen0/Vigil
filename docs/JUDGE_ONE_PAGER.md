# Vigil 执行能力一页说明

## 0) 核心能力：主动生活助手

在当前仓库里，Living Assistant 已经从蓝图变成可运行能力（Phase 1-6 代码与验证路径已落地）：

1. 不是等用户问，而是主动感知 BNB 生态信号（Signal Radar），并统一归一化为 `NormalizedSignal`。
2. 通过 3 级注意力模型决定是否打扰用户（`log` → `notify` → `call`），内置 quiet hours 降级、频率限制、watchlist 相关性判断。
3. **LLM 驱动的信号审核**：当前仓库样例为 80 条 Binance 公告 → 8 条通知 / 12 条摘要 / 60 条跳过（约 87% 降噪）。同类信号自动聚合（如 3 条 new_listing → 1 条摘要）。LLM 不可用时自动降级到规则引擎。
4. **自然语言语音简报**：核心路径不依赖模板拼接，由 LLM 生成口语化简报（目标约束：≤3 句话、15 秒内），配合 CosyVoice 克隆音色合成。
5. 仓库内验证路径已覆盖主链路：信号感知 → LLM 审核 → 自然语言简报 → CosyVoice 克隆音色语音播报 → Telegram 投递（语音+交互按钮）→ 用户响应 → 回调处理 → 消息状态更新。
6. API 路由已上线，可直接评测：

```text
POST /api/v1/living-assistant/evaluate
GET  /api/v1/living-assistant/demo/:scenarioName
GET  /api/v1/living-assistant/capsules
```

官方 skill 覆盖与阶段详见 `docs/official-skills-manifest.json`。

平台说明：Vigil 基于 OpenClaw 平台构建，复用平台的多通道接入、会话编排、提醒投递与回调处理能力。对终端用户而言，Telegram / 语音 / 电话就是实际入口。

---

## 1) 我们在解决什么长期问题

DeFi 里最稀缺的不是"策略想法"，而是**可信执行**：

- 很多系统能发现机会，但无法稳定成交。
- 很多系统能回测漂亮，但难以证明线上执行路径真实可用。
- 很多系统能做单点优化，但缺少可复用的"执行型 agent 底座"。

**Vigil 当前的执行层目标**，不是做一个短期套利脚本，而是把这条链路标准化：

```text
发现机会 -> 风险评估 -> 模拟验证 -> 执行 -> 记录 -> 传播
```

---

## 2) 为什么基于现有执行底座构建

当前实现建立在既有的**执行底座**之上，这是出于执行链路与工程效率的现实考虑：

1. 现有底座提供官方 v6 执行流（`quote -> swap -> simulate -> broadcast -> history`），
   让"从策略到成交"变成可验证链路，而不是黑盒调用。
2. 鉴权、链索引、token profile、模拟校验等底座能力统一后，
   团队可以把精力放在 alpha、风控与产品表达，而不是重复造接入轮子。
3. 我们把链路健康度暴露为接口（status / probe / path），
   让评估不止看收益，还能看"执行基础设施是否可靠"。

换句话说：**当前这套执行底座在仓库里承担的是执行基础设施层角色**，而 Vigil 面向外部呈现的是更完整的 agent 能力、执行能力与生态叙事。

---

## 3) 盈利原理（简洁版）

**当前执行策略** 是跨 DEX 价差兑现，不做方向预测：

```text
grossEdgeBps = ((sellBid - buyAsk) / buyAsk) * 10_000
grossUsd = notionalUsd * grossEdgeBps / 10_000
netUsd = grossUsd - totalCostUsd
```

执行前会做风险调整：

```text
riskAdjustedNetEdgeBps >= minNetEdgeBps(mode)
```

`mode` 为 `paper` 或 `live`。

---

## 4) 风控不是"附加项"，而是产品核心

1. 成本层
- 双边手续费
- 双边滑点（仓位 / 流动性 / 波动驱动）
- 延迟惩罚
- MEV 惩罚

2. 准入层（Live Gate，当前实现阈值）
- 24h 模拟净收益 > 0
- 24h 模拟胜率 >= 55%
- 24h 权限失败 = 0
- 拒单率 / 延迟 / 滑点偏差在动态阈值内

3. 熔断层（Circuit Breaker）
- 连续失败超限
- 日内回撤超限
- 权限失败累计
- 执行质量恶化
- 触发后自动降级 `paper`

---

## 5) 传播性设计：从技术结果到可验证表达

我们不把传播理解为营销包装，而是把执行证据尽量产品化表达（repo-validated/demo-backed）：

1. 实时观测：
- `/demo` + `/api/v1/stream/metrics` 展示机会、成交、PnL、模式、当前执行链路状态。

2. 可复盘证据：
- `/api/v1/backtest/snapshot` + `/api/v1/replay/sandbox` 形成"可追溯、可复验"闭环。

3. 可转发内容：
- `/api/v1/growth/share/latest` 输出战报。
- `/api/v1/growth/moments` 输出"日报 / 最新成交 / 最佳单 / 连胜 / 风控事件"等传播文案。

这个设计的意义是：让社区讨论从"你说你赚了"变成"我们都能复验你的执行质量"。

---

## 6) 对 BNB Chain / 生态伙伴的价值

如果这套执行层跑通，带来的不是单个策略收益，而是四层增量：

1. **基础设施层**：验证当前执行底座在真实策略循环里的稳定性与可用性。
2. **开发者层**：给后续 builder 提供可复用的 skill runtime 模板（可插拔策略、统一风控、统一观测）。
3. **市场层**：把"发现 alpha"升级为"兑现 alpha + 可传播 alpha"，提升生态信息透明度和开发者信心。
4. **体验 / 模式层**：Living Assistant（Signal Radar + Contact Policy + Voice Brief + 可控验证链路）已形成可复用范式，帮助更多 BNB agent 项目补齐"主动感知 -> 判断 -> 联系用户"的产品体验层。

对于 BNB Chain 叙事来说，重点不是"某个脚本跑通了"，而是：**一套可被复用、可被验证、可被继续扩展的 agent 执行底座正在形成。**

---

## 7) 下一阶段方向

1. 多策略插件化扩展（保持统一风控框架），当前主策略 `dex-arbitrage` 已验证闭环。
2. 更细颗粒执行质量画像（按链、按时段、按路由）。
3. 面向生态伙伴的标准化"执行可信报告"模板。
4. 更强的内容生成和可视化导出能力。

---

## 8) 核心组件路径

- 策略逻辑：`plugins/dex-arbitrage`
- 成本模型：`runtime/cost-model`
- 风险调整模拟：`runtime/simulator`
- 引擎与降级：`engine/alpha-engine`
- 门控与熔断：`runtime/risk-engine`
- 执行链路探针：`runtime/execution-client`
