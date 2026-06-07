import crypto from "node:crypto";
import type { AttentionLevel, ContactDecision } from "../contact-policy";
import type { NormalizedSignal } from "../signal-radar";

export interface VoiceBrief {
  briefId: string;
  signalId: string;
  attentionLevel: AttentionLevel;
  text: string;
  language: "zh" | "en";
  generatedAt: string;
}

export interface GenerateVoiceBriefOptions {
  language?: "zh" | "en";
}

function truncateChars(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars)}...`;
}

function truncateWords(input: string, maxWords: number): string {
  const words = input.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function toLabel(signal: NormalizedSignal, language: "zh" | "en"): string {
  if (language === "zh") {
    return signal.pair ? `${signal.pair}新信号` : truncateChars(signal.title, 18);
  }
  return signal.pair ? `${signal.pair} signal` : truncateWords(signal.title, 9);
}

function mapUrgencyZh(urgency: NormalizedSignal["urgency"]): string {
  if (urgency === "critical") return "极高";
  if (urgency === "high") return "高";
  if (urgency === "medium") return "中";
  return "低";
}

function suggestedAction(attentionLevel: AttentionLevel, language: "zh" | "en"): string {
  if (language === "zh") {
    if (attentionLevel === "call") return "要我现在升级提醒，还是两分钟后再确认？";
    return "要我现在给你10秒结论，还是先发卡片？";
  }
  if (attentionLevel === "call") return "Should I escalate now, or check again in two minutes?";
  return "Want a 10-second summary now, or should I send a card?";
}

export function generateVoiceBrief(
  signal: NormalizedSignal,
  decision: ContactDecision,
  options: GenerateVoiceBriefOptions = {},
): VoiceBrief {
  const language = options.language ?? "en";
  const label = toLabel(signal, language);
  const target = signal.pair ?? signal.tokenAddress ?? (language === "zh" ? "当前策略" : "tracked strategy");

  let text: string;
  if (language === "zh") {
    const whatHappened = `老大，出现了和${label}相关的新动态。`;
    const whyItMatters = `这和你关注的${target}相关，当前是${mapUrgencyZh(signal.urgency)}优先级。`;
    const suggestedNext = suggestedAction(decision.attentionLevel, language);
    text = `${whatHappened}${whyItMatters}${suggestedNext}`;
  } else {
    const whatHappened = `Hey, there is a new update tied to your ${label}.`;
    const whyItMatters = `This matters for your ${target} setup and is marked ${signal.urgency} urgency.`;
    const suggestedNext = suggestedAction(decision.attentionLevel, language);
    text = `${whatHappened} ${whyItMatters} ${suggestedNext}`;
  }

  return {
    briefId: crypto.randomUUID(),
    signalId: signal.signalId,
    attentionLevel: decision.attentionLevel,
    text,
    language,
    generatedAt: new Date().toISOString(),
  };
}
