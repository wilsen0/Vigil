# Vigil — BNB 生态智能生活助手

> 这不是一个等你提问的助手，而是一个会主动感知信号、判断该不该打扰你、再用可验证流程替你执行的 BNB 生态生活代理。

---

## Why Vigil

| 传统 AI 助手 | Vigil |
|---|---|
| 被动等用户提问 | **主动感知** BNB 生态信号，判断是否值得打扰 |
| 直接执行，出错再说 | **Paper-first** 风控优先，先模拟再执行 |
| 依赖中心化 API 通信 | **Agent-Comm** 链上铭文协议，钱包即身份 |

**三个核心差异**：

1. **注意力管理** — 3 级打扰模型（`log / notify / call`），约 87% 降噪率
2. **Paper-first 执行** — 默认模拟模式，三层风控自动降级，不拿真金白银试错
3. **链上可信通信** — 钱包身份 + EIP-712 签名 + E2E 加密，零中心化基础设施依赖

---

## Quick Start

### 安装

```bash
git clone https://github.com/2078123478/Vigil.git
cd Vigil
npm install
cp .env.example .env
```

### 配置

编辑 `.env`，按需填写：

| 配置项 | 用途 | 必填 |
|--------|------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram 消息推送 | 推荐 |
| `TELEGRAM_CHAT_ID` | 你的 Telegram Chat ID | 推荐 |
| `LLM_API_KEY` | DashScope API Key（信号审核） | 推荐 |
| `TTS_API_KEY` | 语音合成 API Key | 可选 |
| `ALIYUN_ACCESS_KEY_ID` | 电话呼叫（阿里云语音通知） | 可选 |
| `COMM_RPC_URL` | Agent-Comm 链上通信 | 可选 |

### 运行

```bash
# 启动服务
npm run dev

# 或者先体验 demo（不需要任何外部服务）
npm run demo:living-assistant
```

### Agent 身份初始化（Agent-Comm）

```bash
# 创建钱包身份
VAULT_MASTER_PASSWORD=your-password npx tsx src/index.ts agent-comm:wallet:init

# 导出 HTML 名片（含 QR 码）
VAULT_MASTER_PASSWORD=your-password npx tsx src/index.ts agent-comm:card:export --html --output ./my-card.html
```

---

## 它能做什么

### 场景 1：新币上线预警

> Binance 公告新币 KAT 即将上线交易，带 Seed 高风险标签。

**触发**：Signal Radar 捕获公告 → LLM 判断为高优先级（新币 + 高风险标签）
**决策**：Contact Policy 选择 `notify`（重要但非紧急）
**执行**：CosyVoice 克隆音色生成 ≤15 秒语音简报 → Telegram 推送语音 + 一键操作按钮
**结果**：用户点击"加入观察列表" → 回调闭环 → 状态更新

### 场景 2：日常信号降噪

> 一天内收到 80 条 Binance 公告和 Square 动态。

**触发**：Signal Radar 批量采集 80 条信号
**决策**：LLM Triage 审核 → 8 条通知 / 12 条摘要 / 60 条跳过（87% 降噪）
**执行**：同类信号自动聚合（如 3 条 new_listing → 1 条摘要），quiet hours 自动降级
**结果**：用户只收到真正重要的 8 条通知，不被信息洪流淹没

### 场景 3：紧急风险警报

> 持仓代币审计发现合约安全漏洞，链上资金异常流出。

**触发**：Signal Radar 捕获安全审计异常 + 链上资金流监控
**决策**：Contact Policy 判断为 `call`（紧急 + 资金风险）
**执行**：阿里云电话直接呼叫用户，语音播报风险摘要
**结果**：用户在第一时间收到电话预警，而不是淹没在消息列表里

---

## 架构

```
Binance 公告/Square ──→ Signal Radar ──→ LLM Triage (80→8/12/60，~87%降噪)
                                              │
                                              ▼
                                     Contact Policy Engine
                                      (3级注意力模型)
                                              │
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                            log           notify            call
                       (静默/摘要)    (Telegram语音)    (阿里云电话+TG)
                                              │               │
                                              ▼               ▼
                                      Inline Keyboard    紧急电话呼叫
                                   (一键操作 → 闭环)
```

Vigil 基于 OpenClaw 平台构建，复用平台的多通道接入与会话编排能力。

---

## 四大模块

<details>
<summary>🔗 Agent-Comm — 链上铭文通信协议</summary>

把 BNB Chain 本身变成 Agent 消息总线，减少对中心化基础设施的依赖。

- 钱包 = 身份，EIP-712 签名名片
- secp256k1-ECDH + AES-256-GCM 端到端加密
- 完整连接生命周期：发现 → 邀请 → 信任 → 通信 → 撤销

![Agent-Comm 名片卡片 — 真实钱包身份](docs/assets/agent-comm-card-real.jpg)

</details>

<details>
<summary>💰 套利执行引擎 — 六维成本 + 三层风控</summary>

信息差套利 + 三层风控，不是延迟内卷。

- 六维成本模型（手续费 / 滑点 / MEV / Gas / 延迟 / 尾部风险）
- 三层风控（准入门控 → 熔断器 → 动态阈值）
- 自动 Paper ↔ Live 模式切换

![套利引擎 PnL Performance](docs/assets/pnl-performance.png)

</details>

<details>
<summary>📡 Living Assistant — 主动感知 + 智能判断</summary>

- Signal Radar 实时轮询 Binance 公告 + Square
- LLM Triage：80 → 8 notify / 12 digest / 60 skip，约 87% 降噪
- 3 级注意力模型：`log / notify / call`
- LLM 不可用时自动降级到规则引擎

</details>

<details>
<summary>📞 多渠道投递 — Telegram / 克隆音色 / 电话</summary>

- Telegram 文字 + Inline Keyboard 一键操作
- CosyVoice 克隆音色语音播报
- 阿里云电话呼叫（紧急升级路径）
- One-Breath Voice Brief（≤15 秒、≤3 句话、克隆音色）

</details>

<details>
<summary>🔌 Skills Hub — 官方能力深度融合</summary>

首批核心官方 Skills 已接入 Vigil 主路径。覆盖、阶段、runtime 状态与输出可见性详见 [`official-skills-manifest.json`](docs/official-skills-manifest.json)。

| 产品阶段 | 已接入官方能力 | 作用 |
|---|---|---|
| Signal | Binance Announcements / Binance Square | 生态信号输入 |
| Market | `binance/spot` | 套利引擎市场上下文 |
| Readiness | `binance/assets` | 执行前置检查 |
| Enrichment | `binance-web3/query-token-info` / `query-token-audit` | 决策上下文与安全审计 |

适配器模式下，新增 Skill 通常只需约百行适配代码。

</details>

---

## API

启动服务后，以下 API 可用：

```bash
# Living Assistant — 信号评估
POST /api/v1/living-assistant/evaluate

# Living Assistant — 场景演示
GET  /api/v1/living-assistant/demo/:scenarioName

# Living Assistant — 信号胶囊
GET  /api/v1/living-assistant/capsules

# Discovery — 套利发现
POST /api/v1/discovery/sessions/start
GET  /api/v1/discovery/sessions/active
POST /api/v1/discovery/sessions/:id/approve
```

---

## 测试

```bash
# 运行全部测试
npx vitest run

# 当前状态：53 文件 · 381 用例 · 100% 通过
```

---

## 技术栈

| 维度 | 数据 |
|------|------|
| 语言 | TypeScript |
| 运行时 | Node.js + Express |
| 测试 | Vitest（53 文件 · 381 用例 · 100% 通过） |
| 数据库 | SQLite（better-sqlite3） |
| 加密 | secp256k1-ECDH + AES-256-GCM |
| 签名 | EIP-712（viem） |
| TTS | CosyVoice / DashScope / OpenAI-compatible |
| 投递 | Telegram Bot API / 阿里云语音 |
| 代码规模 | 5,100+ 行 |

---

## 文档

| 文档 | 用途 |
|------|------|
| [项目介绍](项目介绍.md) | 完整技术细节与模块拆解 |
| [Agent-Comm 协议说明](docs/AGENT_COMM_EXPLAINED.md) | 通信协议技术细节 |
| [Agent-Comm 操作指南](docs/AGENT_COMM_V2_OPERATIONS.md) | CLI 命令与操作流程 |
| [套利引擎说明](docs/ARBITRAGE_ONE_PAGER.md) | 套利模块概览 |
| [执行算法](docs/ALGORITHM.md) | 成本模型与风控算法 |
| [BNB Chain 生态对齐](docs/BNBCHAIN_ONE_PAGER.md) | BNB 生态定位 |
| [系统架构](docs/CHAMPION_AGENT_SYSTEM.md) | 系统架构全景 |
| [Official Skills Manifest](docs/official-skills-manifest.json) | 官方技能覆盖与状态 |

---

*Vigil — 让 BNB 生态的每一个重要信号，都能用对的方式、在对的时间、找到对的人。*

## License

[MIT License](LICENSE)
