import type { ContactDecision } from "../contact-policy";
import type { NormalizedSignal } from "../signal-radar";
import { generateVoiceBrief } from "../voice-brief";
import { chatCompletion, isLLMEnabled, resolveLLMApiKey } from "./llm-client";
import type { LLMRuntimeOptions } from "./types";

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimToSentenceLimit(text: string, language: "zh" | "en", maxSentences = 3): string {
  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) return text;
  if (language === "zh") return sentences.slice(0, maxSentences).join("");
  return sentences.slice(0, maxSentences).join(" ");
}

function isWrappedInMatchingQuotes(text: string): boolean {
  return (text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"));
}

function normalizeCompletionText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const fencedMatch = trimmed.match(/```(?:text)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) return fencedMatch[1].trim();

  if (isWrappedInMatchingQuotes(trimmed)) return trimmed.slice(1, -1).trim();

  return trimmed;
}

function fallbackBriefText(
  signal: NormalizedSignal,
  decision: ContactDecision,
  language: "zh" | "en",
): string {
  return generateVoiceBrief(signal, decision, { language }).text;
}

function formatSignalContext(signal: NormalizedSignal): string {
  return JSON.stringify({
    signalId: signal.signalId,
    source: signal.source,
    type: signal.type,
    title: signal.title,
    body: signal.body,
    urgency: signal.urgency,
    pair: signal.pair,
    tokenAddress: signal.tokenAddress,
    chainId: signal.chainId,
    detectedAt: signal.detectedAt,
  });
}

function buildPrompt(signal: NormalizedSignal, decision: ContactDecision, language: "zh" | "en"): string {
  const context = formatSignalContext(signal);

  if (language === "zh") {
    return [
      "你是小音，老大的私人 AI 助理。你刚刚监测到一条信号，需要用语音简报的方式告诉老大。",
      "",
      `注意力级别：${decision.attentionLevel}`,
      `判断原因：${decision.reason}`,
      "信号详情：",
      context,
      "",
      "请用中文写一段语音简报，要求：",
      "- 像真人助理跟老板汇报一样，口语化、自然、有紧迫感",
      "- 严格 3 句话以内，15 秒能读完",
      "- 第 1 句：具体发生了什么（哪个币、什么操作、关键数字）",
      "- 第 2 句：为什么严重 / 跟老大有什么关系",
      "- 第 3 句：建议老大现在做什么（具体动作）",
      "- 禁止说「快去查看」「请关注」这种废话，你必须把关键信息直接说出来",
      "- 只输出纯文本，不要 markdown",
    ].join("\n");
  }

  return [
    `Decision attentionLevel: ${decision.attentionLevel}`,
    `Decision reason: ${decision.reason}`,
    "Signal context:",
    context,
    "",
    "Write a short voice brief:",
    "- natural, conversational, like a real assistant reporting to her boss",
    "- max 3 sentences, fits in 15 seconds",
    "- sentence 1: what exactly happened (specific token, action, key numbers)",
    "- sentence 2: why it matters",
    "- sentence 3: one concrete action to take now",
    "- NEVER say vague things like 'go check' without telling WHAT happened first",
    "- output plain text only",
  ].join("\n");
}

export async function generateNaturalBrief(
  signal: NormalizedSignal,
  decision: ContactDecision,
  language: "zh" | "en",
  options: LLMRuntimeOptions = {},
): Promise<string> {
  const fallback = fallbackBriefText(signal, decision, language);
  if (!isLLMEnabled(options.llmEnabled)) return fallback;

  const apiKey = resolveLLMApiKey(options.llmApiKey);
  if (!apiKey) return fallback;

  const systemPrompt = language === "zh"
    ? "你是小音，一个元气满满的 AI 助理。老大让你盯着 BNB 生态的动态，有重要事情要第一时间用语音简报汇报。你说话直接、有信息量、不废话。"
    : "You are Xiaoyin, an upbeat AI assistant. Produce concise, natural voice briefs about crypto signals.";

  const completion = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildPrompt(signal, decision, language) },
    ],
    {
      apiKey,
      model: options.llmModel,
      temperature: 0.6,
    },
  );

  if (!completion) return fallback;

  const normalized = normalizeCompletionText(completion);
  if (!normalized) return fallback;

  return trimToSentenceLimit(normalized, language, 3);
}
