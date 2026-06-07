import { evaluateContactPolicy } from "./contact-policy";
import type { AttentionLevel, ContactDecision, ContactPolicyConfig, UserContext } from "./contact-policy";
import type { DigestBatch, DigestBatchScheduler, DigestQueueItem, DigestQueueSnapshot } from "./digest-batching";
import { executeDelivery } from "./delivery/delivery-executor";
import type { DeliveryExecutorConfig, DeliveryResult } from "./delivery/delivery-executor";
import { generateNaturalBrief } from "./llm";
import type { NormalizedSignal } from "./signal-radar";
import type { TTSOptions, TTSProvider, TTSResult } from "./tts";
import { generateVoiceBrief } from "./voice-brief";
import type { VoiceBrief } from "./voice-brief";

export interface LivingAssistantLoopInput {
  signal: NormalizedSignal;
  userContext: UserContext;
  policyConfig: ContactPolicyConfig;
  ttsProvider?: TTSProvider;
  ttsOptions?: TTSOptions;
  deliveryExecutor?: DeliveryExecutorConfig;
  digestScheduler?: DigestBatchScheduler;
  demoMode?: boolean;
  llmApiKey?: string;
  llmModel?: string;
  llmEnabled?: boolean;
}

export interface LivingAssistantLoopOutput {
  signal: NormalizedSignal;
  decision: ContactDecision;
  brief?: VoiceBrief;
  audio?: TTSResult;
  delivery?: DeliveryResult;
  delivered: boolean;
  demoMode: boolean;
  digestQueue?: DigestQueueSnapshot;
  digestEnqueued?: DigestQueueItem;
  digestFlushed?: DigestBatch;
  timings: {
    policyMs: number;
    briefMs: number;
    ttsMs: number;
    deliveryMs: number;
    totalMs: number;
  };
  loopCompletedAt: string;
}

function shouldGenerateBrief(level: AttentionLevel): boolean {
  return level === "notify" || level === "call";
}

function resolveBriefLanguage(input: LivingAssistantLoopInput): "zh" | "en" {
  return input.ttsOptions?.language === "zh" ? "zh" : "en";
}

export async function runLivingAssistantLoop(
  input: LivingAssistantLoopInput,
): Promise<LivingAssistantLoopOutput> {
  const loopStart = performance.now();

  const policyStart = performance.now();
  const decision = evaluateContactPolicy(input.signal, input.userContext, input.policyConfig);
  const policyMs = performance.now() - policyStart;

  let digestQueue: DigestQueueSnapshot | undefined;
  let digestEnqueued: DigestQueueItem | undefined;
  let digestFlushed: DigestBatch | undefined;

  if (input.digestScheduler) {
    digestFlushed = input.digestScheduler.flushDue();
  }

  if (decision.attentionLevel === "log" && input.digestScheduler) {
    const result = input.digestScheduler.enqueue(input.signal, decision.reason, input.policyConfig.digestWindowMinutes);
    digestEnqueued = result.item;
  }

  if (input.digestScheduler) {
    digestQueue = input.digestScheduler.getSnapshot();
  }

  const briefStart = performance.now();
  let brief: VoiceBrief | undefined;
  if (shouldGenerateBrief(decision.attentionLevel)) {
    const language = resolveBriefLanguage(input);
    const naturalText = await generateNaturalBrief(
      input.signal,
      decision,
      language,
      {
        llmApiKey: input.llmApiKey,
        llmModel: input.llmModel,
        llmEnabled: input.llmEnabled,
      },
    );

    if (naturalText.trim()) {
      brief = {
        briefId: crypto.randomUUID(),
        signalId: input.signal.signalId,
        attentionLevel: decision.attentionLevel,
        text: naturalText.trim(),
        language,
        generatedAt: new Date().toISOString(),
      };
    } else {
      brief = generateVoiceBrief(input.signal, decision, { language });
    }
  }
  const briefMs = performance.now() - briefStart;

  const demoMode = Boolean(input.demoMode);
  let audio: TTSResult | undefined;
  let delivery: DeliveryResult | undefined;
  let ttsMs = 0;
  let deliveryMs = 0;

  if (brief && input.ttsProvider) {
    const ttsStart = performance.now();
    try {
      audio = await input.ttsProvider.synthesize(brief.text, input.ttsOptions);
    } catch {
      audio = undefined;
    } finally {
      ttsMs = performance.now() - ttsStart;
    }
  }

  if (!demoMode && input.deliveryExecutor) {
    const deliveryStart = performance.now();
    delivery = await executeDelivery(decision, brief, audio, input.deliveryExecutor);
    deliveryMs = performance.now() - deliveryStart;
  }

  const totalMs = performance.now() - loopStart;

  return {
    signal: input.signal,
    decision,
    brief,
    audio,
    delivery,
    delivered: demoMode ? false : Boolean(delivery?.sent),
    demoMode,
    digestQueue,
    digestEnqueued,
    digestFlushed,
    timings: { policyMs, briefMs, ttsMs, deliveryMs, totalMs },
    loopCompletedAt: new Date().toISOString(),
  };
}
