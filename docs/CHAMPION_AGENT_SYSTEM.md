# Champion Agent System — Vigil as a Living BNB-Native Assistant

This document defines the **champion-level product direction** for Vigil.

It is not just a stronger arbitrage demo.
It is a plan to turn Vigil into a **living BNB-native assistant system** that:

- continuously senses the Binance / BNB ecosystem
- judges relevance and urgency on behalf of the user
- decides whether the user should be interrupted
- chooses a human-like contact method
- closes the loop through paper simulation, approval, execution, memory, and follow-up

In one line:

> Vigil should feel less like a bot that waits for commands, and more like a real human assistant who knows when to quietly observe, when to brief you, and when to urgently call you.

---

## 1. Champion standard

To be judged as a champion-level system, Vigil should target **three simultaneous 10/10s**:

### 1. Creativity = 10/10

Not just “an arbitrage module” and not just “an agent that calls skills.”

The creative leap is:

- official Binance skills become the assistant’s **senses**
- strategy modules become the assistant’s **judgment**
- OpenClaw becomes the assistant’s **presence and memory**
- human contact becomes a first-class system, not an afterthought

### 2. Ecosystem contribution = 10/10

The project should contribute reusable patterns to the BNB ecosystem:

- official-skill compatibility adapters
- normalized context contracts
- strategy-module orchestration pattern
- explainable reason taxonomy
- human-contact policy model for agent systems
- demo-safe event replay and summary packaging

### 3. Experience = 10/10

The system should feel like a **real assistant**:

- proactive, but not noisy
- expressive, but not verbose
- human-like, but controllable
- bold enough to interrupt, but smart enough to know when not to

---

## 2. The product definition

Vigil should evolve into:

## **A BNB Ecosystem Living Assistant**

A living assistant is different from a normal chat agent.

A normal chat agent waits for messages.
A living assistant:

- monitors its environment continuously
- notices signals before the user asks
- evaluates whether something matters to the user
- chooses how to contact the user
- proposes action with context and judgment
- records the outcome and learns the pattern

This means Vigil is not only:

- a strategy engine
- a compatibility layer
- a demo shell

It becomes a **cross-channel proactive assistant system**.

---

## 3. The core breakthrough

The main breakthrough is not just “better trading.”

The main breakthrough is:

> an agent that knows **when to interrupt you** and **how to interrupt you**.

That is the missing layer in most agent products.

Most projects focus on:

- getting data
- calling tools
- producing an answer

Champion-level Vigil should also solve:

- when to stay silent
- when to send a short alert
- when to send a voice brief
- when to demand attention
- when to degrade from urgent to silent follow-up
- when to stop trying and summarize later

That is what makes it feel human.

---

## 4. Four-layer champion architecture

## Layer 1 — BN Signal Radar

Purpose: make the assistant aware of the BNB ecosystem.

This layer ingests signals from official and ecosystem-facing sources such as:

- Binance official announcements
- Binance official social / tweets
- Binance Square
- `binance/spot`
- `binance/assets`
- `binance/alpha`
- `binance-web3/query-token-info`
- `binance-web3/query-token-audit`
- `binance-web3/query-address-info`
- `binance-web3/trading-signal`
- `binance-web3/crypto-market-rank`
- `binance-web3/meme-rush`
- ecosystem-specific feeds

This radar should not forward raw data directly.
It should produce normalized **events** such as:

- market opportunity event
- risk warning event
- ecosystem announcement event
- narrative shift event
- user-portfolio relevance event
- agent-to-agent collaboration event

The output of this layer is not “content.”
The output is **machine-judgable significance**.

---

## Layer 2 — Butler Judgment Engine

Purpose: decide what matters, for whom, and why.

The judgment engine evaluates three questions:

### A. Is this a meaningful opportunity or risk?

Examples:

- arbitrage candidate worth simulating
- token risk event worth warning about
- new Binance announcement with strategy implications
- Square narrative worth monitoring

### B. Is it relevant to this user right now?

Relevance should depend on:

- balance or readiness context
- watchlist and strategy preferences
- previously shown interest
- trust / policy configuration
- local time and interruption window
- recent notification history

### C. Should the assistant contact the user?

This is the most important judgment.

The assistant should choose among:

- say nothing
- log silently
- include in digest
- send short message
- send voice brief
- trigger urgent contact
- request explicit approval

This layer turns an event into a **human contact decision**.

---

## Layer 3 — Human Contact Orchestrator

Purpose: deliver the right interruption through the right channel in the right style.

This is the “break the fourth wall” layer.

### Attention Ladder

#### Level 0 — Silent memory

Use when:

- the event is low urgency
- the event is weakly relevant
- the user should not be interrupted

Behavior:

- save to memory / digest
- maybe include in later summary

#### Level 1 — Short text nudge

Use when:

- the event matters, but does not justify voice
- the user can decide quickly from one sentence

Shape:

- one-line conclusion
- one-line why-it-matters
- one clear CTA

#### Level 2 — Micro voice brief

Use when:

- the event is meaningful and time-sensitive
- the user may be mobile or unable to read
- human-like presence matters more than a paragraph

Shape:

- 10–20 seconds
- 3 sentences maximum
- must include:
  1. what happened
  2. why it matters
  3. what the user can do next

#### Level 3 — Strong interrupt

Use when:

- the opportunity or risk is high value
- a decision is likely needed soon
- the assistant wants an explicit yes/no path

Shape:

- concise message
- optional voice brief
- explicit choices such as:
  - simulate now
  - remind later
  - ignore
  - brief me

#### Level 4 — Call-style escalation

Use when:

- urgency is unusually high
- confidence is high
- user policy allows hard interruption
- the assistant believes silence would be a bigger failure than interruption

Important note:

A true Telegram bot voice call may not be the safest MVP assumption.
So the design should separate:

### MVP implementation

- high-priority message
- immediate voice brief
- quick-reply buttons
- optional repeated escalation within policy guardrails

### Advanced implementation

- telephony / SIP bridge
- call-out workflow
- speech-to-text + text-to-speech loop
- assistant-led short voice interaction

This keeps the vision bold while preserving demo realism.

---

## Layer 4 — Action and Closure Layer

Purpose: ensure the assistant does not merely alert; it closes loops.

After contacting the user, the system should support:

- paper simulation
- request for approval
- downgrade to monitor-only mode
- schedule a follow-up reminder
- generate a judge / operator / ecosystem summary
- publish a Square-ready draft
- store the result in long-term memory

This creates a full assistant loop:

```text
sense → judge → interrupt → discuss → decide → act → summarize → remember
```

That loop is what makes the system feel alive.

---

## 5. The flagship module inside the living assistant

The arbitrage module remains the first flagship module.

But in the champion framing, arbitrage is not the whole story.
It is the **first proof** that the living assistant can:

- sense ecosystem signals
- enrich them with official-skill context
- simulate and explain outcomes
- decide whether to interrupt the user
- present the result in a safe paper-mode flow

Later modules can extend the same architecture:

- smart-money follow
- risk sentinel
- alpha capture
- portfolio rebalance
- event-driven strategy activation

The point is not “many bots.”
The point is **many strategy behaviors under one living assistant identity**.

---

## 6. The experience breakthrough

The assistant should feel human in three ways.

### 1. It chooses timing

Examples:

- weak signal at 2 AM → silent memory
- strong official announcement tied to active strategy → short voice brief
- non-actionable event → digest only
- high-confidence paper-simulated opportunity → strong interrupt

### 2. It speaks in assistant form, not model form

Bad:

- long report
- giant table
- overexplained chain-of-thought style text

Good:

- “老大，BN 刚出了和你关注路径直接相关的信号，我已经 paper 跑过了。”
- “结论：可跟。风险：可解释。要我现在给你 10 秒结论，还是稍后再提醒？”

### 3. It escalates like a person with judgment

Bad pattern:

- ping repeatedly until answered

Good pattern:

- first contact: short alert
- second contact: only if still relevant
- final step: downgrade to summary if ignored
- if event expires: say it is no longer actionable

This is where the assistant stops feeling robotic.

---

## 7. Voice as a first-class interaction surface

Voice should not be treated as “text read aloud.”

It should be treated as an **assistant briefing protocol**.

## One-Breath Voice Brief Protocol

Rules:

- under ~15 seconds by default
- under 3 sentences
- no dense numeric dump
- one core recommendation
- easy response options

Template:

1. **What happened**
2. **Why it matters to you**
3. **What I suggest next**

Example:

> 老大，BN 广场和公告同时出现一个新信号，和你关注的 ETH/USDC 套利路径相关。  
> 我已经用 paper 模式模拟过，收益为正，风险可解释。  
> 你要我现在给你 10 秒结论，还是先发卡片给你看？

This format is memorable, demo-friendly, and product-worthy.

---

## 8. What makes the ecosystem contribution 10/10

To reach ecosystem-contribution 10/10, the project must produce reusable assets, not just a single polished app.

### Contribution A — Strategy-module compatibility pattern

A reusable pipeline:

```text
official skill → normalized context → strategy decision → escalation policy → summary packaging
```

This can help other BNB-native agent builders.

### Contribution B — Human Contact Policy Engine

A reusable model for:

- when to interrupt
- how strongly to interrupt
- whether to use text or voice
- when to request approval
- when to downgrade or stop

This is a missing building block in most agent ecosystems.

### Contribution C — Voice Brief Protocol

A reusable specification for short assistant-led voice updates.

This helps agents communicate more like assistants and less like dashboards.

### Contribution D — Replayable Event Capsules

Create replayable demo-safe event packages such as:

- official announcement event
- Square narrative event
- token risk event
- strategy opportunity event

This supports:

- stable demos
- benchmarkable agent behavior
- shared testing material for the ecosystem

### Contribution E — Explainable, demo-safe judgment chain

By standardizing:

- normalized contexts
- reason codes
- decision summaries
- paper-safe mode handling

the project contributes a trustworthy way to present autonomous decisions.

---

## 9. Demo story for judges

A championship demo should feel like watching a real assistant at work.

### Scene 1 — The ecosystem moves

A Binance announcement / Square post / market condition arrives.

### Scene 2 — The assistant notices before the user does

The system builds normalized context from official-skill-compatible adapters.

### Scene 3 — The assistant judges relevance

It decides this is relevant to the user because of strategy, readiness, and risk context.

### Scene 4 — The assistant contacts the user like a person

It sends a short, high-signal voice or text brief.

### Scene 5 — The assistant shows decision quality

It presents:

- candidate
- market context
- readiness context
- enrichment context
- decision
- reason codes
- paper-mode-safe execution summary

### Scene 6 — The assistant closes the loop

It records the event, prepares next actions, and can optionally package the story for Binance Square.

The emotional takeaway should be:

> this is not a bot waiting in a chat window — this is a living assistant that inhabits the ecosystem.

---

## 10. Implementation stages

## Stage 1 — Core foundation (Living Assistant + execution baseline)

- arbitrage contract
- decision taxonomy
- adapter-backed normalized contexts
- production approval flow with explicit paper/live mode
- signal radar with normalized events (`NormalizedSignal`)
- contact policy engine with 3-level attention model (`log` → `notify` → `call`)
- one-breath voice brief generation (`zh` / `en`)
- loop orchestration (`signal -> policy -> brief`) with `demoMode`
- delivery adapters (`Telegram` + `Aliyun voice call` + webhook)
- API routes: `/api/v1/living-assistant/evaluate`, `/api/v1/living-assistant/demo/:scenarioName`, `/api/v1/living-assistant/capsules`
- demo scenario fixtures (`proactive-arbitrage-alert`, `quiet-hours-downgrade`, `critical-risk-escalation`)
- signal capsule fixtures for replayable demos

## Stage 2 — Production enhancements

- live API polling integration
  - Binance announcements
  - Binance Square
- real TTS audio generation
- digest batching scheduler
- second-batch enrichment adapters
  - `query-address-info`
  - `trading-signal`

## Stage 3 — Advanced capabilities

- telephony / SIP bridge
- multi-user support
- persistent user preference storage
- Square-ready summary packaging

---

## 11. Design principles

### Principle 1 — Proactive, not noisy

The assistant should feel alive, not spammy.

### Principle 2 — Human-like, not theatrical

The goal is not to pretend to be human.
The goal is to behave with human-quality judgment and timing.

### Principle 3 — Paper-safe first

Bold experience does not require reckless execution.
A champion demo should be safe, stable, and credible.

### Principle 4 — Reusable by the ecosystem

Every important layer should be exportable as a pattern, not trapped inside one demo.

### Principle 5 — Product story over capability pile

A strong story with clear loops beats a giant list of disconnected integrations.

---

## 12. Non-goals

The champion direction should not degrade into:

- a random skill marketplace
- a noisy notification bot
- a fake live-trading stunt
- a wall of dashboards with no assistant behavior
- a purely internal engine story with no human experience layer

---

## 13. One-sentence summary

**Vigil should become a living BNB-native assistant system that senses the Binance ecosystem, judges what matters, decides when to interrupt the user, and closes the loop through safe, explainable, human-like action.**
