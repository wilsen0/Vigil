import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  defaultContactPolicyConfig,
  type ContactPolicyConfig,
  type UserContext,
} from "../src/skills/alphaos/living-assistant/contact-policy";
import { DigestBatchScheduler, type DigestBatch } from "../src/skills/alphaos/living-assistant/digest-batching";
import {
  TelegramVoiceSender,
  type DeliveryExecutorConfig,
  type DeliveryResult,
} from "../src/skills/alphaos/living-assistant/delivery";
import { AliyunVoiceSender } from "../src/skills/alphaos/living-assistant/delivery/aliyun-voice-sender";
import { runLivingAssistantLoop } from "../src/skills/alphaos/living-assistant/loop";
import { normalizeSignal, pollBinanceAnnouncements, type NormalizedSignal } from "../src/skills/alphaos/living-assistant/signal-radar";
import {
  createTTSProvider,
  type TTSOptions,
  type TTSProvider,
  type TTSProviderConfig,
} from "../src/skills/alphaos/living-assistant/tts";

interface DemoScenarioFixture {
  name: string;
  description: string;
  signal: unknown;
  userContext: UserContext;
  policyConfig?: Partial<ContactPolicyConfig>;
}

interface DemoCliOptions {
  live: boolean;
  dryRun: boolean;
  send: boolean;
  call: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalENV(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalBoolean(name: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const value = readOptionalENV(name, env);
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function toSafeFileName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function formatDurationMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function printUsageAndExit(): never {
  console.log("Usage: npm run demo:living-assistant -- [--live] [--dry-run|--send|--call]");
  console.log("");
  console.log("Flags:");
  console.log("  --live     Poll real Binance announcements and run one loop per signal");
  console.log("  --dry-run  Print decision/brief only (default)");
  console.log("  --send     Run real Telegram delivery (requires TTS and Telegram env vars)");
  console.log("  --call     Run phone delivery via Aliyun (requires Aliyun env vars)");
  process.exit(0);
}

export function parseCliOptions(argv = process.argv.slice(2)): DemoCliOptions {
  const knownFlags = new Set(["--live", "--dry-run", "--send", "--call", "--help", "-h"]);
  for (const arg of argv) {
    if (!knownFlags.has(arg)) throw new Error(`Unknown CLI argument: ${arg}`);
  }
  if (argv.includes("--help") || argv.includes("-h")) printUsageAndExit();

  const send = argv.includes("--send");
  const call = argv.includes("--call");
  if (send && call) throw new Error("Cannot combine --send and --call");

  return {
    live: argv.includes("--live"),
    dryRun: !send && !call,
    send,
    call,
  };
}

function readTTSProviderType(env: NodeJS.ProcessEnv = process.env): TTSProviderConfig["type"] {
  const raw = readOptionalENV("TTS_PROVIDER", env);
  if (!raw) return "openai-compatible";
  if (raw === "openai-compatible" || raw === "dashscope-qwen" || raw === "cosyvoice") return raw;
  throw new Error(`Unsupported TTS_PROVIDER: ${raw}`);
}

function normalizeTTSFormat(format: string | undefined, fallback: TTSOptions["format"]): TTSOptions["format"] {
  if (!format) return fallback;
  const normalized = format.trim().toLowerCase();
  if (normalized === "wav" || normalized === "ogg") return normalized;
  return "mp3";
}

function buildOptionalTTS(env: NodeJS.ProcessEnv = process.env): { ttsProvider?: TTSProvider; ttsOptions?: TTSOptions } {
  const providerType = readTTSProviderType(env);
  const apiKey = readOptionalENV("TTS_API_KEY", env);
  const model = readOptionalENV("TTS_MODEL", env);
  const voice = readOptionalENV("TTS_VOICE", env);
  const CLONED_VOICE = "cosyvoice-v2-wilsen-078bd152fc744a33871a0c71b32a6025";
  const language = (readOptionalENV("TTS_LANGUAGE", env)?.toLowerCase() === "zh" ? "zh" : undefined) as TTSOptions["language"] | undefined;
  const instructions = readOptionalENV("TTS_INSTRUCTIONS", env);
  const optimizeInstructions = readOptionalBoolean("TTS_OPTIMIZE_INSTRUCTIONS", env);

  if (providerType === "dashscope-qwen") {
    if (!apiKey) return {};
    const endpoint = readOptionalENV("TTS_DASHSCOPE_ENDPOINT", env);
    const languageType = readOptionalENV("TTS_DASHSCOPE_LANGUAGE_TYPE", env);
    const format = normalizeTTSFormat(readOptionalENV("TTS_FORMAT", env), "wav");
    return {
      ttsProvider: createTTSProvider({
        type: "dashscope-qwen", apiKey,
        ...(endpoint ? { endpoint } : {}), ...(model ? { model } : {}),
        ...(voice ? { defaultVoice: voice } : {}), ...(languageType ? { languageType } : {}),
        ...(instructions ? { defaultInstructions: instructions } : {}),
        ...(typeof optimizeInstructions === "boolean" ? { optimizeInstructions } : {}),
        defaultFormat: format,
      }),
      ttsOptions: { format, ...(voice ? { voice } : {}), ...(language ? { language } : {}), ...(instructions ? { instructions } : {}) },
    };
  }

  if (providerType === "cosyvoice") {
    if (!apiKey) return {};
    const endpoint = readOptionalENV("TTS_DASHSCOPE_ENDPOINT", env);
    const format = normalizeTTSFormat(readOptionalENV("TTS_FORMAT", env), "wav");
    const cosyVoice = voice || CLONED_VOICE;
    return {
      ttsProvider: createTTSProvider({
        type: "cosyvoice", apiKey,
        ...(endpoint ? { endpoint } : {}), ...(model ? { model } : {}),
        defaultVoice: cosyVoice, defaultFormat: format,
      }),
      ttsOptions: { format, voice: cosyVoice, ...(language ? { language } : {}) },
    };
  }

  const baseUrl = readOptionalENV("TTS_BASE_URL", env);
  if (!baseUrl || !apiKey) return {};
  const format = normalizeTTSFormat(readOptionalENV("TTS_FORMAT", env), "mp3");
  return {
    ttsProvider: createTTSProvider({
      type: "openai-compatible", baseUrl, apiKey,
      ...(model ? { model } : {}), ...(voice ? { defaultVoice: voice } : {}),
      defaultFormat: format,
    }),
    ttsOptions: { format, ...(voice ? { voice } : {}), ...(language ? { language } : {}) },
  };
}

function buildSendRuntime(): { ttsProvider?: TTSProvider; ttsOptions?: TTSOptions; deliveryExecutor?: DeliveryExecutorConfig } {
  const tts = buildOptionalTTS();
  if (!tts.ttsProvider) throw new Error("--send requires TTS provider env");

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) throw new Error("--send requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");

  return {
    ...tts,
    deliveryExecutor: { telegramSender: new TelegramVoiceSender({ botToken, chatId }) },
  };
}

function buildCallRuntime(): { ttsProvider?: TTSProvider; ttsOptions?: TTSOptions; deliveryExecutor?: DeliveryExecutorConfig } {
  const tts = buildOptionalTTS();
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  const accessKeyId = readOptionalENV("ALIYUN_ACCESS_KEY_ID");
  const accessKeySecret = readOptionalENV("ALIYUN_ACCESS_KEY_SECRET");
  const calledShowNumber = readOptionalENV("ALIYUN_CALLED_SHOW_NUMBER");
  const calledNumber = readOptionalENV("ALIYUN_CALLED_NUMBER");
  const ttsCode = readOptionalENV("ALIYUN_TTS_CODE");
  const endpoint = readOptionalENV("ALIYUN_ENDPOINT");

  if (!accessKeyId || !accessKeySecret || !calledShowNumber || !calledNumber || !ttsCode) {
    throw new Error("--call requires ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET, ALIYUN_CALLED_SHOW_NUMBER, ALIYUN_CALLED_NUMBER, ALIYUN_TTS_CODE");
  }

  const aliyunSender = new AliyunVoiceSender({
    accessKeyId, accessKeySecret, calledShowNumber,
    defaultCalledNumber: calledNumber, ttsCode,
    ...(endpoint ? { endpoint } : {}),
  });

  return {
    ...tts,
    deliveryExecutor: {
      aliyunSender,
      ...(botToken && chatId ? { telegramSender: new TelegramVoiceSender({ botToken, chatId }) } : {}),
    },
  };
}

function loadDemoScenarios(
  fixtureDir = path.resolve(process.cwd(), "fixtures", "demo-scenarios"),
): Array<{ name: string; description: string; signal: NormalizedSignal; userContext: UserContext; policyConfig?: Partial<ContactPolicyConfig> }> {
  if (!fs.existsSync(fixtureDir)) return [];
  return fs
    .readdirSync(fixtureDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.resolve(fixtureDir, entry.name);
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) throw new Error(`Invalid scenario: ${entry.name}`);
      const fixture = parsed as unknown as DemoScenarioFixture;
      return {
        name: typeof fixture.name === "string" && fixture.name.trim() ? fixture.name.trim() : entry.name.replace(/\.json$/i, ""),
        description: typeof fixture.description === "string" ? fixture.description : "",
        signal: normalizeSignal(fixture.signal as never),
        userContext: fixture.userContext,
        policyConfig: fixture.policyConfig,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function printDigestBatch(digest: DigestBatch, label: string): void {
  console.log(`${label}: digestId=${digest.digestId}, signals=${digest.signalCount}`);
  for (const highlight of digest.highlights) {
    console.log(`Digest highlight: ${highlight}`);
  }
  console.log(`Digest summary:\n${digest.text}`);
}

function printDeliveryResult(delivery?: DeliveryResult): void {
  if (!delivery) { console.log("Delivery: skipped"); return; }
  console.log(`Delivery: sent=${delivery.sent}, channel=${delivery.channel}, dryRun=${delivery.dryRun}`);
  if (delivery.voiceResult) {
    console.log(`  Voice: ${delivery.voiceResult.ok ? "ok" : "failed"}${delivery.voiceResult.messageId ? `, messageId=${delivery.voiceResult.messageId}` : ""}`);
  }
  if (delivery.textResult) {
    console.log(`  Text: ${delivery.textResult.ok ? "ok" : "failed"}${delivery.textResult.messageId ? `, messageId=${delivery.textResult.messageId}` : ""}`);
  }
  if (delivery.callResult) {
    console.log(`  Call: ${delivery.callResult.ok ? "ok" : "failed"}${delivery.callResult.callId ? `, callId=${delivery.callResult.callId}` : ""}`);
  }
  if (delivery.error) console.log(`  Error: ${delivery.error}`);
}

async function main(): Promise<void> {
  console.log("Vigil — Living Assistant Demo");
  const cli = parseCliOptions();
  console.log(`Mode: source=${cli.live ? "live" : "fixture"}, execution=${cli.send ? "send" : cli.call ? "call" : "dry-run"}`);

  const demoMode = cli.dryRun;
  const runtime = cli.send ? buildSendRuntime() : cli.call ? buildCallRuntime() : buildOptionalTTS();
  const digestScheduler = new DigestBatchScheduler();
  const outputDir = runtime.ttsProvider ? path.resolve(process.cwd(), "demo-output") : undefined;
  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });

  const scenarios = loadDemoScenarios();
  let runScenarios: typeof scenarios = [];

  if (cli.live) {
    const announcementResult = await pollBinanceAnnouncements();
    if (announcementResult.error) { console.error(`Poll error: ${announcementResult.error}`); process.exit(1); }
    console.log(`Live poll: articleCount=${announcementResult.articleCount}, newSignals=${announcementResult.signals.length}`);
    if (announcementResult.signals.length === 0) { console.log("No new signals."); return; }
    runScenarios = announcementResult.signals.map((signal) => ({
      name: `live-${signal.source}-${signal.signalId}`,
      description: signal.title,
      signal,
      userContext: scenarios[0]?.userContext ?? { localHour: new Date().getHours(), recentContactCount: 0, activeStrategies: [], watchlist: [], riskTolerance: "moderate" as const },
      policyConfig: scenarios[0]?.policyConfig,
    }));
  } else {
    runScenarios = scenarios;
  }

  let briefsGenerated = 0;
  let audioFilesWritten = 0;
  let loopTotalMs = 0;
  let deliverySent = 0;
  let digestQueued = 0;

  for (const scenario of runScenarios) {
    console.log(`\nScenario: ${scenario.name}`);
    console.log(`Description: ${scenario.description}`);

    const loopOutput = await runLivingAssistantLoop({
      signal: scenario.signal,
      userContext: scenario.userContext,
      policyConfig: { ...defaultContactPolicyConfig, ...(scenario.policyConfig ?? {}) },
      digestScheduler,
      demoMode,
      ...(runtime.ttsProvider ? { ttsProvider: runtime.ttsProvider, ttsOptions: runtime.ttsOptions } : {}),
      ...(runtime.deliveryExecutor ? { deliveryExecutor: runtime.deliveryExecutor } : {}),
    });

    console.log(`Signal: source=${loopOutput.signal.source}, type=${loopOutput.signal.type}, urgency=${loopOutput.signal.urgency}`);
    console.log(`Decision: level=${loopOutput.decision.attentionLevel}, shouldContact=${loopOutput.decision.shouldContact}, reason=${loopOutput.decision.reason}`);

    if (loopOutput.brief?.text) { console.log(`Brief: ${loopOutput.brief.text}`); briefsGenerated++; }
    else { console.log("Brief: not generated"); }

    if (loopOutput.audio?.audio && outputDir) {
      const filePath = path.resolve(outputDir, `${toSafeFileName(`${scenario.name}-${loopOutput.signal.signalId}`)}.${loopOutput.audio.format}`);
      fs.writeFileSync(filePath, loopOutput.audio.audio);
      audioFilesWritten++;
      console.log(`Audio file: ${filePath}`);
    }

    if (!demoMode) printDeliveryResult(loopOutput.delivery);
    if (loopOutput.delivery?.sent) deliverySent++;

    if (loopOutput.digestFlushed) printDigestBatch(loopOutput.digestFlushed, "Digest flush");
    if (loopOutput.digestEnqueued) { digestQueued++; console.log(`Digest queue: size=${loopOutput.digestQueue?.size ?? 0}`); }

    console.log(`Timing: policy=${formatDurationMs(loopOutput.timings.policyMs)}, brief=${formatDurationMs(loopOutput.timings.briefMs)}, tts=${formatDurationMs(loopOutput.timings.ttsMs)}, delivery=${formatDurationMs(loopOutput.timings.deliveryMs)}, total=${formatDurationMs(loopOutput.timings.totalMs)}`);
    loopTotalMs += loopOutput.timings.totalMs;
  }

  const finalDigest = digestScheduler.flushNow();
  if (finalDigest) printDigestBatch(finalDigest, "Final digest flush");

  console.log(`\nSummary: ${runScenarios.length} loops, ${briefsGenerated} briefs, ${audioFilesWritten} audio files, ${deliverySent} sent, ${digestQueued} digested, loopTotal=${formatDurationMs(loopTotalMs)}`);
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
