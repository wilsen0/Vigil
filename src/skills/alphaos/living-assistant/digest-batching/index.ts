import type { NormalizedSignal, SignalUrgency } from "../signal-radar";

export interface DigestQueueItem {
  itemId: string;
  signalId: string;
  signal: NormalizedSignal;
  reason: string;
  queuedAt: string;
}

export interface DigestSummaryItem {
  signalId: string;
  source: string;
  type: string;
  urgency: SignalUrgency;
  title: string;
  detectedAt: string;
  pair?: string;
  tokenAddress?: string;
}

export interface DigestBatch {
  digestId: string;
  signalCount: number;
  urgencyCounts: Record<SignalUrgency, number>;
  highlights: string[];
  text: string;
  items: DigestSummaryItem[];
  createdAt: string;
}

export interface DigestQueueSnapshot {
  size: number;
  nextFlushAt?: string;
  readyToFlush: boolean;
}

export interface DigestBatchSchedulerOptions {
  now?: () => Date;
  defaultWindowMinutes?: number;
}

const URGENCY_RANK: Record<SignalUrgency, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export class DigestBatchScheduler {
  private readonly now: () => Date;
  private readonly defaultWindowMinutes: number;
  private queue: DigestQueueItem[] = [];
  private seq = 0;
  private nextFlushAt?: string;

  constructor(options: DigestBatchSchedulerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.defaultWindowMinutes = options.defaultWindowMinutes ?? 60;
  }

  enqueue(signal: NormalizedSignal, reason: string, windowMinutes?: number): { item: DigestQueueItem; queue: DigestQueueSnapshot } {
    const queuedAt = this.now().toISOString();
    if (this.queue.length === 0) {
      const minutes = windowMinutes ?? this.defaultWindowMinutes;
      this.nextFlushAt = new Date(Date.now() + minutes * 60_000).toISOString();
    }

    const item: DigestQueueItem = {
      itemId: `digest-${++this.seq}`,
      signalId: signal.signalId,
      signal,
      reason,
      queuedAt,
    };
    this.queue.push(item);
    return { item, queue: this.getSnapshot() };
  }

  getSnapshot(now?: Date): DigestQueueSnapshot {
    const current = now ?? this.now();
    const nextFlushMs = this.nextFlushAt ? Date.parse(this.nextFlushAt) : NaN;
    return {
      size: this.queue.length,
      nextFlushAt: this.nextFlushAt,
      readyToFlush: this.queue.length > 0 && Number.isFinite(nextFlushMs) && current.getTime() >= nextFlushMs,
    };
  }

  flushDue(now?: Date): DigestBatch | undefined {
    const snapshot = this.getSnapshot(now);
    if (!snapshot.readyToFlush) return undefined;
    return this.flushInternal();
  }

  flushNow(): DigestBatch | undefined {
    if (this.queue.length === 0) return undefined;
    return this.flushInternal();
  }

  private flushInternal(): DigestBatch {
    const items = [...this.queue];
    this.queue = [];
    this.nextFlushAt = undefined;

    const summaryItems: DigestSummaryItem[] = items
      .map((item) => ({
        signalId: item.signalId,
        source: item.signal.source,
        type: item.signal.type,
        urgency: item.signal.urgency,
        title: item.signal.title,
        detectedAt: item.signal.detectedAt,
        ...(item.signal.pair ? { pair: item.signal.pair } : {}),
        ...(item.signal.tokenAddress ? { tokenAddress: item.signal.tokenAddress } : {}),
      }))
      .sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency]);

    const urgencyCounts: Record<SignalUrgency, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const item of summaryItems) urgencyCounts[item.urgency]++;

    const highlights = summaryItems.slice(0, 3).map(
      (item) => `[${item.urgency}] ${item.title} (${item.pair ?? item.tokenAddress ?? item.type})`,
    );

    const text = [
      `${summaryItems.length} signal(s) batched.`,
      `Urgency mix: critical=${urgencyCounts.critical}, high=${urgencyCounts.high}, medium=${urgencyCounts.medium}, low=${urgencyCounts.low}.`,
      highlights.length > 0 ? `Highlights: ${highlights.join(" | ")}` : "Highlights: none.",
    ].join("\n");

    return {
      digestId: `digest-${Date.now()}`,
      signalCount: summaryItems.length,
      urgencyCounts,
      highlights,
      text,
      items: summaryItems,
      createdAt: this.now().toISOString(),
    };
  }
}
