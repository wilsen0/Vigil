/// <reference path="./ws-shim.d.ts" />

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { defaultContactPolicyConfig, evaluateContactPolicy, type ContactPolicyConfig, type UserContext } from "../src/skills/alphaos/living-assistant/contact-policy";
import { TelegramCallbackHandler } from "../src/skills/alphaos/living-assistant/delivery/callback-handler";
import { TelegramVoiceSender } from "../src/skills/alphaos/living-assistant/delivery/telegram-voice-sender";
import { runLivingAssistantLoop } from "../src/skills/alphaos/living-assistant/loop";
import { normalizeSignal } from "../src/skills/alphaos/living-assistant/signal-radar";
import { createTTSProvider } from "../src/skills/alphaos/living-assistant/tts/provider-factory";
import { generateVoiceBrief } from "../src/skills/alphaos/living-assistant/voice-brief";

const FIXTURE_PATH = path.resolve(process.cwd(), "fixtures", "demo-scenarios", process.argv[2] || "critical-risk-escalation.json");
const CLONED_VOICE = "cosyvoice-v2-wilsen-078bd152fc744a33871a0c71b32a6025";
const CALLBACK_TIMEOUT_MS = 60_000;

interface DemoFixture {
  name: string;
  description: string;
  signal: unknown;
  userContext: UserContext;
  policyConfig?: Partial<ContactPolicyConfig>;
}

function printHeader(title: string): void { console.log(`\n${title}`); }
function printLine(text: string): void { console.log(`   ${text}`); }
function formatMs(ms: number): string { return `${ms.toFixed(1)}ms`; }

function measure<T>(work: () => T): { value: T; ms: number } {
  const startedAt = performance.now();
  return { value: work(), ms: performance.now() - startedAt };
}

async function measureAsync<T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = performance.now();
  return { value: await work(), ms: performance.now() - startedAt };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadFixture(): DemoFixture {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  return JSON.parse(raw) as DemoFixture;
}

async function waitForSingleCallback(
  handler: TelegramCallbackHandler,
  targetMessageId: number | undefined,
): Promise<{ status: string; callbackData?: string; elapsedMs: number }> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let settled = false;

    const finish = (result: { status: string; callbackData?: string; elapsedMs: number }) => {
      if (settled) return;
      settled = true;
      handler.stopPolling();
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => finish({ status: "timeout", elapsedMs: performance.now() - startedAt }), CALLBACK_TIMEOUT_MS);

    handler.startPolling((event) => {
      if (settled) return;
      if (typeof targetMessageId === "number" && event.messageId !== targetMessageId) return;

      settled = true;
      clearTimeout(timeout);
      handler.stopPolling();

      void handler.handleCallback(event.callbackQueryId, event.callbackData, event.messageId)
        .then((result) => finish({ status: result.ok ? "handled" : "failed", callbackData: event.callbackData, elapsedMs: performance.now() - startedAt }))
        .catch(() => finish({ status: "error", callbackData: event.callbackData, elapsedMs: performance.now() - startedAt }));
    });
  });
}

async function main(): Promise<void> {
  const runStartedAt = performance.now();
  const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv("TELEGRAM_CHAT_ID");
  const ttsApiKey = requireEnv("TTS_API_KEY");

  printHeader("Living Assistant Hackathon E2E Demo");
  printLine(`Fixture: ${path.relative(process.cwd(), FIXTURE_PATH)}`);
  printLine(`Chat ID: ${chatId}`);

  printHeader("Step 1: Load Fixture");
  const fixture = loadFixture();
  printLine(`Loaded ${fixture.name}`);
  printLine(fixture.description);

  printHeader("Step 2: Normalize Signal");
  const normalized = measure(() => normalizeSignal(fixture.signal as never));
  const signal = normalized.value;
  printLine(`Signal ID: ${signal.signalId}, Urgency: ${signal.urgency}`);

  const policyConfig: ContactPolicyConfig = { ...defaultContactPolicyConfig, ...(fixture.policyConfig ?? {}), allowCallEscalation: false };

  printHeader("Step 3: Contact Policy Preview");
  const decision = measure(() => evaluateContactPolicy(signal, fixture.userContext, policyConfig));
  printLine(`Decision: ${decision.value.attentionLevel} (${formatMs(decision.ms)})`);
  printLine(decision.value.reason);

  printHeader("Step 4: Voice Brief Preview");
  const briefPreview = measure(() => generateVoiceBrief(signal, decision.value));
  printLine(`Brief (${formatMs(briefPreview.ms)}): ${briefPreview.value.text}`);

  printHeader("Step 5: Create TTS Provider");
  const ttsProvider = createTTSProvider({ type: "cosyvoice", apiKey: ttsApiKey, defaultVoice: CLONED_VOICE, defaultFormat: "mp3" });
  const telegramSender = new TelegramVoiceSender({ botToken, chatId });
  printLine(`TTS provider: ${ttsProvider.name}`);

  printHeader("Step 6: Run Living Assistant Loop");
  const loopRun = await measureAsync(() =>
    runLivingAssistantLoop({
      signal, userContext: fixture.userContext, policyConfig,
      ttsProvider, ttsOptions: { voice: CLONED_VOICE, format: "mp3", language: "zh" },
      deliveryExecutor: { telegramSender },
      llmEnabled: true,
    }),
  );
  const loopOutput = loopRun.value;
  printLine(`Loop completed in ${formatMs(loopRun.ms)}`);
  printLine(`Decision: ${loopOutput.decision.attentionLevel}`);
  printLine(`Voice message: ${loopOutput.delivery?.voiceResult?.ok ? "sent" : "not sent"}`);
  printLine(`Follow-up message: ${loopOutput.delivery?.textResult?.ok ? "sent" : "not sent"}`);

  if (!loopOutput.delivery?.sent) {
    throw new Error(loopOutput.delivery?.error || "Delivery failed.");
  }

  const followUpMessageId = loopOutput.delivery.textResult?.messageId;

  printHeader("Step 7: Wait For Telegram Callback");
  printLine("Polling started. Click one of the inline buttons.");
  const callbackHandler = new TelegramCallbackHandler({ botToken, chatId });
  const callbackWait = await waitForSingleCallback(callbackHandler, followUpMessageId);
  printLine(`Callback: status=${callbackWait.status}, data=${callbackWait.callbackData ?? "none"}, elapsed=${formatMs(callbackWait.elapsedMs)}`);

  printHeader("Summary");
  printLine(`Delivered: ${loopOutput.delivered ? "yes" : "no"}`);
  printLine(`Callback: ${callbackWait.status}`);
  printLine(`Total runtime: ${formatMs(performance.now() - runStartedAt)}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  printHeader("Demo Failed");
  printLine(message);
  process.exitCode = 1;
});
