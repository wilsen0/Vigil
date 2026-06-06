# Champion Demo Story - How Vigil Wins the Room

This document defines how to present Vigil as a **champion-level BNB-native living assistant system**.

It is not a backend walkthrough.
It is not a feature checklist.
It is a **room-winning demo strategy**.

The goal is simple:

> make judges feel that they are not looking at another crypto bot, but at the first believable BNB-native assistant that knows when to notice, when to judge, and when to contact a human.

---

## 1. The judge's first question

Every judge will ask a version of this question within the first 20-40 seconds:

> Why is this special?

If the answer sounds like:

- "we have many APIs"
- "we support lots of data"
- "we do arbitrage"
- "we can integrate Binance skills"

then the project drops into the same bucket as many other entries.

The winning answer is:

> Vigil is a living BNB-native assistant. It continuously senses the ecosystem, judges what matters to a specific user, and decides when and how to contact them like a real assistant - while staying safe through paper-first execution and explainable decisions.

That answer reframes the whole room.

---

## 2. What judges should believe by the end

A championship demo should make the audience believe **three things**.

### Belief 1 - This is not a tool wrapper

The system is not just calling official skills.
It is turning official skills into:

- normalized contexts
- strategy decisions
- interruption decisions
- product-grade summaries

### Belief 2 - This belongs in the Binance / BNB ecosystem

The project should feel naturally anchored to:

- Binance official skills
- BNB-native market and social signals
- Binance Square / announcements / ecosystem narratives
- wallet-aware, trust-aware agent behavior

### Belief 3 - This feels like a real assistant

The standout experience should be:

- it notices before the user asks
- it decides whether the user should be interrupted
- it communicates in short, high-signal, human-like form
- it closes the loop instead of leaving a raw trace behind

If judges believe those three things, the project has championship energy.

---

## 3. The three highest-impact wow moments

Do not try to create ten moments.
Create **three unforgettable ones**.

## Wow Moment 1 - "It noticed before the human"

The assistant sees a BNB ecosystem event first.

Examples:

- an official Binance announcement
- a Binance Square narrative surge
- a strategy-relevant risk/event signal
- a paper-simulated arbitrage candidate triggered by ecosystem movement

What the judge should feel:

> This assistant is alive inside the ecosystem, not waiting in a chat box.

Key line:

> The user did not ask for this. The assistant decided this might matter first.

---

## Wow Moment 2 - "It knows whether to interrupt"

This is the real differentiator.

The assistant does not automatically blast a notification.
It evaluates:

- urgency
- user relevance
- readiness context
- risk context
- current contact policy

Then it decides the proper attention level:

- silent
- short text
- voice brief
- strong interrupt
- call-style escalation

### LLM-Powered Signal Triage (NEW)

The judgment engine is no longer just rules. It uses an LLM to batch-review signals like a real human assistant would:

- **80 Binance announcements come in** → the LLM reviews all of them in batches of 20
- **Result: 8 notify, 12 digest, 60 skip** - 87% noise reduction
- Similar signals are automatically grouped (e.g. 3 new_listing → "3 new token listings")
- Each decision comes with a human-readable reason

This is the difference between:
- ❌ "60 notifications because rules said high urgency"
- ✅ "8 notifications because the LLM judged only these matter to you"

When the LLM is unavailable, the system gracefully falls back to the rule engine - zero downtime, zero broken flows.

What the judge should feel:

> This is not automation. This is judgment.

Key line:

> The system's intelligence is not only in deciding what to do in the market - it is also in deciding whether a human should be interrupted at all.

---

## Wow Moment 3 — "It contacts the user like a real assistant"

This is the emotional peak.

The agent uses a short, human-style contact pattern:

- concise message
- optional voice brief
- clear next-step choices
- zero dashboard dump

### Natural Language Voice Briefs (NEW)

The voice brief is no longer a template-filled message like:

> ❌ "Hey, there is a new update tied to your Binance Margin Will Add New Pairs - 2026-03-17. This matters for your tracked strategy setup and is marked high urgency."

Instead, the LLM generates natural, conversational speech in Xiaoyin's voice:

> ✅ "老大，币安刚上了几个新的保证金交易对！高优先级信号，可能有新的杠杆机会，建议关注一下。"

The brief is:
- Max 3 sentences, fits in 15 seconds
- Conversational and natural — sounds like a real assistant, not a template
- Includes an actionable suggestion at the end
- Falls back to template if LLM is unavailable

Combined with CosyVoice cloned voice synthesis, the result is:

> A voice message that sounds like YOUR assistant telling you what matters, in natural language, with a unique voice.

Example flow:

> 老大，BN 刚出了和你关注路径直接相关的新信号。
> 我已经用 paper 模式跑过，结果是正收益而且风险可解释。
> 你要我现在给你 10 秒结论，还是先发卡片？

What the judge should feel:

> I can imagine actually using this.

That emotional realism matters more than one more API call.

---

## 4. The winning demo structure

The demo should feel like a short story, not a system tour.

Use this arc:

```text
The ecosystem moves → The assistant notices → The assistant judges relevance → The assistant contacts the user → The assistant shows safe, explainable action → The assistant closes the loop
```

---

## 5. The recommended 4-scene demo

This is the version I would actually run on stage.

## Scene 1 - "The world moves" (20-30 seconds)

Show a signal entering the system.

Best sources for stage value:

- Binance announcement-style event
- Square narrative event
- ecosystem-linked arbitrage opportunity event

Do not explain architecture first.
Start with motion.

Say:

> Here's the trigger: something changed in the BNB ecosystem before the user asked anything.

What to show:

- a replayable event capsule
- a live-ish demo input
- a signal ingestion snapshot

Judge reaction target:

> okay, this starts from a real event, not from a fake prompt.

---

## Scene 2 - "The assistant thinks before it speaks" (35-50 seconds)

Now show the judgment layer.

This is where the system combines:

- market context
- readiness context
- enrichment context
- strategy implications
- interruption policy

### Live triage demo

Run the live demo with LLM triage enabled:

```bash
LLM_API_KEY=sk-... npm run demo:living-assistant -- --live --dry-run
```

Show the triage summary line:

```
Triage summary: 80 signals -> 8 notify, 12 digest, 60 skip
Triage engine: llm
```

Then show one grouped notification vs one skipped signal. The contrast is powerful:

- **Grouped notify**: "New Spot, Margin & Futures Pairs Added - 2026-03-17" (2 signals merged)
- **Skipped**: "Binance Adds New Fiat Gateway" (low relevance to user's watchlist)

Say:

> 80 signals came in. A rule engine would blast 60 notifications. Our LLM triage reviewed them like a real assistant and decided only 8 deserve your attention. The rest are either batched for later or silently skipped.

Judge reaction target:

> that's different from a normal trading tool.

---

## Scene 3 - "The assistant contacts the human" (35-50 seconds)

This should be the signature scene.

### Preferred MVP stage version

Use:

- a short Telegram message
- plus a micro voice brief
- plus 2-4 explicit quick actions

For example:

- Brief me now
- Simulate now
- Remind me later
- Ignore

Say:

> The point is not just proactive notification. The point is human-quality interruption design.

Then explain that the assistant has an attention ladder.

### Important stage principle

Do not present voice as a novelty gimmick.
Present it as a **better assistant interface** for time-sensitive situations.

Judge reaction target:

> this is the first moment where it feels like a real assistant instead of a dashboard.

---

## Scene 4 - "Safe, explainable action" (40-60 seconds)

Now show the paper-mode result through the production approval route.

Use `/api/v1/discovery/sessions/:sessionId/approve` with `mode=paper` and show:

- moduleResponse
- requested vs effective mode
- decision summary
- reason codes
- simulation summary
- execution summary in paper mode

If a live request is shown, the runtime must use the same live gates and backend readiness checks used in production.

Say:

> We made the experience bold, but the operating model safe. That's why paper-first matters: the demo stays believable, and the assistant still shows real judgment and closure.

Judge reaction target:

> this team knows how to ship something real, not just risky.

---

## 6. How to present the voice / call-style idea without overreaching

This is important.
The idea is strong, but if explained badly it can sound fake or hand-wavy.

The correct framing is:

### What exists now

- proactive text alert
- micro voice brief path
- paper-safe execution flow
- contact decision logic

### Extended capabilities

- enhanced voice brief generation
- explicit contact policy engine
- digest vs interrupt routing

### Advanced capabilities

- telephony bridge
- call-out workflow
- speech loop for very high-priority escalation

This keeps the project grounded.

### Do not say

- "we already built full autonomous calling" if you have not
- "the bot literally phones you today" unless it truly does in production

### Do say

> We already have the assistant-interruption model and the demo-safe interaction pattern. The advanced extension is call-style escalation, where a very high-priority event would trigger a short voice-led conversation rather than another text message.

That sounds bold and credible at the same time.

---

## 7. The best way to make call-style escalation feel real

The winning trick is not building the hardest telephony integration first.
The winning trick is making judges **feel** the call-style behavior now.

### MVP illusion that is actually honest

Use:

- urgent message styling
- instant micro voice brief
- quick action buttons
- follow-up response path

This produces the feeling of:

- urgency
- personal attention
- assistant presence

without needing a fragile true phone call.

### Advanced story to describe

Explain that the same policy ladder can later drive:

- Telegram high-priority escalation
- SIP bridge / phone call
- wearable / speaker alert
- voice inbox handling

This makes the concept feel platform-expandable rather than channel-locked.

---

## 8. What to show on screen

Keep the stage asset set tight.

### Ideal screen set

1. one event capsule / signal snapshot
2. one judgment view
3. one human contact view
4. one paper-mode decision payload
5. one short summary / closure view

### Do not show

- too many logs
- too many tables
- too many endpoints
- deep backend traces
- long docs during the live flow

The docs support the story.
They should not replace the story.

---

## 9. Exact judge-facing language to use

These lines are worth memorizing.

### Opening line

> Vigil is not a bot waiting for prompts. It is a living BNB-native assistant that senses the ecosystem, judges what matters, and decides when to contact a human.

### Binance alignment line

> Binance official skills are the assistant's senses. Our product layer turns them into judgment, interruption policy, and explainable action.

### Safety line

> We deliberately use paper-safe execution in the demo, because the point is not reckless autonomy. The point is trustworthy assistant behavior.

### Experience line

> The breakthrough is not only that the system can act. It is that the system knows when it should interrupt you.

### Closing line

> This is what a real ecosystem-native assistant looks like: it notices, judges, contacts, and closes the loop.

---

## 10. Likely judge questions and the best answers

## Q1 - Isn't this just another trading agent?

Answer:

> No. The trading module is only the first flagship behavior. The actual product is a living assistant system that combines ecosystem sensing, decision quality, interruption policy, and safe action closure.

## Q2 - Why is Binance Skills compatibility important?

Answer:

> Because it makes the project ecosystem-native instead of isolated. We are building on the official open capability layer and adding strategy orchestration, explainability, and product-grade human contact on top.

## Q3 - Why paper mode? Why not live?

Answer:

> Because championship demos need credibility. Paper-safe mode proves judgment, simulation, safety gating, and human interaction without depending on fragile live conditions.

## Q4 - What is the ecosystem contribution?

Answer:

> We are contributing a reusable pattern: official skills → normalized contexts → strategy decisions → human-contact policy → summary packaging. That is a reusable building block for many BNB-native agent products.

## Q5 - What is the moat?

Answer:

> The moat is not API access. It is assistant-grade orchestration: sensing, relevance judgment, interruption control, explainable decisions, and closure.

---

## 11. What not to do in the championship demo

### Anti-pattern 1 - starting with architecture diagrams

Start with movement, not structure.
The room needs to feel the system first.

### Anti-pattern 2 - overexplaining backend names

AlphaOS 应该只作为实现细节出现，而不是 demo 的情绪中心。

### Anti-pattern 3 - acting like voice is a gimmick

Voice is not a toy feature.
It is the most human-efficient contact medium for time-sensitive assistant behavior.

### Anti-pattern 4 - overpromising full calling

Be bold in vision, precise in truth.
Show the ladder, show the present capability, explain the advanced extension.

### Anti-pattern 5 - letting the demo become a JSON reading session

The payload matters, but the room must remember the assistant behavior, not the field names.

---

## 12. The championship emotional arc

If the demo works, judges should feel this sequence:

1. **Curiosity** - "What is this event?"
2. **Interest** - "The system noticed it by itself?"
3. **Respect** - "It decides whether the human should be interrupted?"
4. **Believability** - "The contact style actually feels useful."
5. **Confidence** - "The action path is safe and explainable."
6. **Excitement** - "This could become a real assistant product."

That emotional climb matters as much as the technical proof.

---

## 13. The shortest championship pitch

If you only get one tight paragraph, use this:

> Vigil is a living BNB-native assistant built on Binance official skills. Instead of waiting for prompts, it senses ecosystem signals, judges whether they matter to a specific user, decides whether that user should be interrupted, and contacts them in a short, human-like way. It then closes the loop through safe paper-mode simulation, explainable decisions, and reusable summary packaging.

---

## 14. One-sentence summary

**The winning demo is the one where judges stop seeing "a crypto bot" and start seeing "a real assistant that knows when to notice, when to speak, and when to act."**
