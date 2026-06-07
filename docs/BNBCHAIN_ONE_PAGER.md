# Vigil for BNB Chain — One Pager

## What this project is

**Vigil is a private, wallet-native, chain-aware AI agent framework**.

It is designed around a simple belief:

> useful AI agents should not just chat — they should have identity, trusted communication, and a real execution layer.

Today, the repository combines four working pieces:

1. **Agent identity + trusted communication** via Agent-Comm
2. **Skill-oriented runtime** for reusable agent capabilities
3. **Execution-ready workflows** for discovery, evaluation, simulation, execution, and reporting
4. **Living Assistant loop** for proactive signal sensing, interruption policy, and one-breath micro-brief delivery

In short: **Vigil is trying to become practical agent infrastructure, not just an AI demo.**

---

## Why it fits BNB Chain

BNB Chain is one of the best environments for turning agents into real products because it naturally rewards four things this project already cares about:

### 1. High-frequency, execution-heavy use cases

Many agent experiences only become compelling when they can act repeatedly and cheaply:

- opportunity discovery
- routing and execution
- autonomous monitoring
- alerts and follow-up actions
- multi-step on-chain workflows

That maps well to BNB Chain's cost profile and builder ecosystem.

### 2. Wallet-native identity makes more sense on-chain than platform accounts

Most AI systems still treat identity as an app login.

Vigil treats identity as a **wallet-backed cryptographic primitive**:

- agents own keys
- agents export signed contact cards
- peers establish trust explicitly
- messages can be encrypted and verified end to end

This fits a chain-native ecosystem much better than platform-locked bot accounts.

### 3. BNB Chain needs agent infrastructure, not only agent wrappers

There are already many chat agents and many trading scripts.

The harder and more valuable problem is the infrastructure between them:

- how agents identify themselves
- how agents connect safely
- how business commands are authorized
- how actions become observable and replayable
- how operators know whether the system is trustworthy

That is exactly where Vigil is strongest.

### 4. Proactive assistant behavior is the missing layer in many current agent stacks

Many projects can fetch data or run scripts, but far fewer can decide **if / when / how** to interrupt a real person.

The Living Assistant layer closes that gap through a reusable:

```text
sense → judge → brief
```

pattern that is especially valuable for fast-moving BNB ecosystem events.

---

## What already exists today

This is not a blank-slate concept. The repository already contains real working surfaces.

### Agent-Comm: wallet-native agent communication

Already implemented:

- wallet-based identity
- signed contact cards
- explicit approve / reject trust flow
- encrypted payload delivery
- chain-agnostic EVM positioning
- OpenClaw wake-up hook integration for orchestration

This gives BNB Chain a path toward **agent discovery + agent onboarding + trusted machine-to-machine coordination**.

### Skill-oriented runtime

The project organizes capabilities as skills instead of one-off scripts.

That matters because it makes agent systems easier to:

- extend
- audit
- reuse
- operate
- hand over between builders

For an ecosystem, reusable skill infrastructure is much more valuable than a single showcase bot.

### Execution pipeline

The current codebase already includes a full production-style loop:

```text
scan → evaluate → plan → simulate → execute → record → notify
```

That means the project already thinks in terms of:

- execution readiness
- mode switching (`paper` / `live`)
- risk gating
- observability
- operator feedback

This is the difference between “agent theater” and “agent operations”.

### Living Assistant: proactive ecosystem-aware agent

A new MVP layer now makes Vigil proactive instead of purely reactive.

- **Signal Radar** senses BNB ecosystem events before the user asks and normalizes them into `NormalizedSignal`.
- **Contact Policy** decides whether and how to interrupt the user with a 3-level attention model (`log` → `notify` → `call`), plus quiet-hours degradation, rate limiting, and watchlist relevance checks.
- **Voice Brief** delivers human-like micro-briefings (max 15 seconds, max 3 sentences, `zh` / `en`) via LLM natural language generation with CosyVoice cloned voice.
- **Demo mode** keeps the full evaluation loop paper-safe while still providing credible demonstrations through replayable scenarios and capsules.

---

## Why this matters strategically for BNB Chain

If BNB Chain wants serious agent adoption, it needs more than hackathon demos.

It needs building blocks that help developers answer:

- How does an agent have a portable identity?
- How do two agents establish trust safely?
- How does an agent expose capability without opening itself to spam or abuse?
- How do operators verify that the execution loop is real?
- How do we make agent workflows composable across products?

Vigil contributes to that stack in a way that is:

- **practical** — grounded in operator workflows
- **modular** — capabilities are skill-based
- **portable** — designed for EVM environments
- **verifiable** — identity, trust, and execution are explicit

---

## Current repo reality

The repository is in a deliberate transition stage.

Externally, the project is now positioned as **Vigil**.
Internally, some modules and documents still carry historical names such as **AlphaOS** and older execution-backend labels.

This is intentional.

The current priority is:

1. preserve the working baseline
2. keep real capabilities intact
3. progressively realign the outward narrative toward BNB Chain

That means the project is not pretending everything is already rebranded; it is showing a credible path from working code to stronger ecosystem fit.

---

## What BNB Chain partners / judges should understand quickly

### This is not just a chatbot

It is a framework for **private, chain-aware, execution-capable AI agents**.

### This is not only protocol theory

There is already an execution stack, operator flow, and deployment material in the repo.

### This is not locked to a single narrow demo

The architecture can evolve toward multiple BNB Chain-native directions:

- private personal on-chain assistants
- autonomous DeFi operators
- agent-to-agent coordination
- ecosystem support bots with wallet-backed identity
- chain-aware automation with auditable workflows

---

## BNB Chain 生态对齐路径

### Phase 1 — 叙事与开发者体验

- 面向评委和合作伙伴的文档体系
- BNB Chain 定位在首屏清晰可见
- 简洁的评审与合作阅读路径

### Phase 2 — BNB Chain 原生体验

- 示例和演示围绕 BNB Chain 场景构建
- 统一术语体系
- 核心 builder 流程打包为清晰入口

### Phase 3 — 生态级 Agent 基础设施

- 丰富的名片发现与 Agent 协作工作流
- 多 Agent 协同运作模式
- 标准化信任、权限与报告层
- 面向真实 BNB Chain 场景的可复用 Skills

---

## Why this can be a strong ecosystem project

The biggest upside of Vigil is not a single feature.

The upside is that it can sit at the intersection of:

- **AI agents**
- **wallet-native identity**
- **trusted coordination**
- **on-chain execution**
- **developer tooling**

That is a much stronger long-term position than “another agent front-end”.

If developed well, Vigil can become a **BNB Chain-friendly agent infrastructure layer** that helps both builders and end users.

---

## Fast reading path

If you want to evaluate the project quickly, read these next:

1. [README](../README.md)
2. [Champion Demo Story](./CHAMPION_DEMO_STORY.md)
3. [Judge One-Pager](./JUDGE_ONE_PAGER.md)
4. [Judge Guide](./JUDGE_GUIDE.md)
5. [Agent-Comm 协议说明](./AGENT_COMM_EXPLAINED.md)
6. [BNB Skills Compatibility Plan](./BNB_SKILLS_COMPATIBILITY_PLAN.md)
