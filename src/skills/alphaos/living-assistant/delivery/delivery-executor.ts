import type { AttentionLevel, ContactDecision } from "../contact-policy";
import type { TTSResult } from "../tts";
import type { VoiceBrief } from "../voice-brief";
import type { AliyunVoiceConfig, AliyunVoiceResult } from "./aliyun-voice-sender";
import { AliyunVoiceSender } from "./aliyun-voice-sender";
import type { TelegramVoiceSendResult, TelegramVoiceSenderConfig } from "./telegram-voice-sender";
import { TelegramVoiceSender } from "./telegram-voice-sender";

export interface DeliveryExecutorConfig {
  telegramSender?: TelegramVoiceSender;
  aliyunSender?: AliyunVoiceSender;
  dryRun?: boolean;
}

export interface DeliveryResult {
  channel: string;
  sent: boolean;
  dryRun: boolean;
  voiceResult?: TelegramVoiceSendResult;
  textResult?: TelegramVoiceSendResult;
  callResult?: AliyunVoiceResult;
  error?: string;
}

function hasAudioBytes(audio?: TTSResult): audio is TTSResult & { audio: Buffer } {
  return Boolean(audio?.audio && audio.audio.length > 0);
}

function hasAudioUrl(audio?: TTSResult): audio is TTSResult & { audioUrl: string } {
  return Boolean(audio?.audioUrl && audio.audioUrl.trim().length > 0);
}

async function resolveAudioBytes(audio?: TTSResult): Promise<Buffer | undefined> {
  if (hasAudioBytes(audio)) return audio.audio;
  if (hasAudioUrl(audio)) {
    try {
      const response = await fetch(audio.audioUrl);
      if (!response.ok) return undefined;
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function toInlineKeyboard(decision: ContactDecision): import("./telegram-voice-sender").TelegramInlineKeyboardButton[][] {
  return [
    [
      { text: "act now", callback_data: "la:act_now" },
      { text: "defer 5m", callback_data: "la:defer_5m" },
      { text: "ignore", callback_data: "la:ignore_once" },
    ],
  ];
}

export async function executeDelivery(
  decision: ContactDecision,
  brief?: VoiceBrief,
  audio?: TTSResult,
  config?: DeliveryExecutorConfig,
): Promise<DeliveryResult> {
  if (decision.attentionLevel === "log") {
    return { channel: "none", sent: false, dryRun: false };
  }

  if (config?.dryRun) {
    return { channel: decision.attentionLevel === "call" ? "aliyun" : "telegram", sent: false, dryRun: true };
  }

  const sender = config?.telegramSender;
  const briefText = brief?.text ?? decision.reason;

  if (decision.attentionLevel === "notify") {
    if (!sender) {
      return { channel: "telegram", sent: false, dryRun: true };
    }

    const audioBytes = await resolveAudioBytes(audio);
    if (audioBytes) {
      const voiceResult = await sender.sendVoice(audioBytes, { caption: briefText });
      return {
        channel: "telegram",
        sent: voiceResult.ok,
        dryRun: false,
        voiceResult,
        ...(voiceResult.ok ? {} : { error: voiceResult.error }),
      };
    }

    const textResult = await sender.sendMessage(briefText);
    return {
      channel: "telegram",
      sent: textResult.ok,
      dryRun: false,
      textResult,
      ...(textResult.ok ? {} : { error: textResult.error }),
    };
  }

  // call level: Telegram voice/text + phone call
  const keyboard = toInlineKeyboard(decision);
  let voiceResult: TelegramVoiceSendResult | undefined;
  let textResult: TelegramVoiceSendResult | undefined;
  let callResult: AliyunVoiceResult | undefined;

  if (sender) {
    const audioBytes = await resolveAudioBytes(audio);
    if (audioBytes) {
      const combined = await sender.sendVoiceWithFollowUp(
        audioBytes,
        `URGENT: ${briefText}`,
        buildEscalationText(decision),
        { inlineKeyboard: keyboard },
      );
      voiceResult = combined.voice;
      textResult = combined.followUp;
    } else {
      voiceResult = await sender.sendMessage(`URGENT: ${briefText}`);
      textResult = await sender.sendMessage(buildEscalationText(decision), { inlineKeyboard: keyboard });
    }
  }

  if (config?.aliyunSender) {
    callResult = await config.aliyunSender.callWithTts({ content: briefText });
  }

  const telegramOk = voiceResult?.ok && textResult?.ok;
  const callOk = callResult?.ok;
  const sent = Boolean(telegramOk || callOk);
  const errors = [
    voiceResult?.ok === false ? voiceResult.error : undefined,
    textResult?.ok === false ? textResult.error : undefined,
    callResult?.ok === false ? callResult.error : undefined,
  ].filter(Boolean);

  return {
    channel: callOk ? "aliyun" : "telegram",
    sent,
    dryRun: false,
    voiceResult,
    textResult,
    callResult,
    ...(sent ? {} : { error: errors.join(" | ") || "delivery failed" }),
  };
}

function buildEscalationText(decision: ContactDecision): string {
  const cooldownLine = decision.cooldownUntil
    ? `Cooldown until: ${decision.cooldownUntil}`
    : "Cooldown until: immediate reassessment";
  return [
    "Escalation plan:",
    "1. Acknowledge this message now.",
    "2. Open the strategy console and verify risk controls.",
    "3. Execute the safest mitigation path or pause the strategy.",
    cooldownLine,
  ].join("\n");
}
