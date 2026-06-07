import type { NormalizedSignal, SignalUrgency } from "../signal-radar";

export type AttentionLevel = "log" | "notify" | "call";

export interface ContactDecision {
  shouldContact: boolean;
  attentionLevel: AttentionLevel;
  reason: string;
  cooldownUntil?: string;
  degradeReason?: string;
}

export interface UserContext {
  localHour: number;
  recentContactCount: number;
  activeStrategies: string[];
  watchlist: string[];
  riskTolerance: "conservative" | "moderate" | "aggressive";
  quietHoursStart?: number;
  quietHoursEnd?: number;
}

export interface ContactPolicyConfig {
  quietHoursStart: number;
  quietHoursEnd: number;
  maxContactsPerHour: number;
  maxContactsPerDay: number;
  allowCallEscalation: boolean;
  digestWindowMinutes: number;
}

export const defaultContactPolicyConfig: ContactPolicyConfig = {
  quietHoursStart: 23,
  quietHoursEnd: 8,
  maxContactsPerHour: 3,
  maxContactsPerDay: 12,
  allowCallEscalation: true,
  digestWindowMinutes: 60,
};

const URGENCY_RANK: Record<SignalUrgency, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function normalizeWatchItem(value: string): string {
  return String(value).trim().toLowerCase();
}

function isWatchlistRelevant(signal: NormalizedSignal, watchlist: string[]): boolean {
  if (watchlist.length === 0) return false;
  const normalized = watchlist.map(normalizeWatchItem);
  const pair = signal.pair ? normalizeWatchItem(signal.pair) : "";
  const tokenAddress = signal.tokenAddress ? normalizeWatchItem(signal.tokenAddress) : "";

  if (pair && normalized.includes(pair)) return true;
  if (tokenAddress && normalized.includes(tokenAddress)) return true;

  return normalized.some((item) => {
    if (!item) return false;
    return pair.includes(item) || tokenAddress.includes(item);
  });
}

function isInQuietHours(localHour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return localHour >= start && localHour < end;
  return localHour >= start || localHour < end;
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function evaluateContactPolicy(
  signal: NormalizedSignal,
  userContext: UserContext,
  config: ContactPolicyConfig = defaultContactPolicyConfig,
): ContactDecision {
  const watchlistHit = isWatchlistRelevant(signal, userContext.watchlist);
  const relevant = watchlistHit || signal.relevanceHint === "likely_relevant";

  let level: AttentionLevel = "log";
  let reason = "Signal routed to log by default policy.";

  if (signal.urgency === "critical" && (relevant || config.allowCallEscalation)) {
    level = "call";
    reason = "Critical signal triggered call escalation.";
  } else if (signal.urgency === "critical" && !relevant) {
    level = "notify";
    reason = "Critical signal escalated despite low relevance confidence.";
  } else if ((signal.urgency === "high" || signal.urgency === "medium") && relevant) {
    level = "notify";
    reason = watchlistHit
      ? `Watchlist match with ${signal.urgency} urgency triggered notification.`
      : `Relevant ${signal.urgency}-urgency signal triggered notification.`;
  } else if (signal.urgency === "low" && !watchlistHit) {
    level = "log";
    reason = "Low-urgency signal outside watchlist; logging only.";
  } else if (!relevant) {
    level = "log";
    reason = "Signal not clearly relevant; logged.";
  } else {
    level = "log";
    reason = "Relevant low-urgency signal logged.";
  }

  if (level === "call" && !config.allowCallEscalation) {
    level = "notify";
    reason = "Call escalation disabled; downgraded to notify.";
  }

  let degradeReason: string | undefined;

  if (level !== "log" && signal.urgency !== "critical") {
    const quietStart = userContext.quietHoursStart ?? config.quietHoursStart;
    const quietEnd = userContext.quietHoursEnd ?? config.quietHoursEnd;
    if (isInQuietHours(userContext.localHour, quietStart, quietEnd)) {
      degradeReason = `Quiet hours (${quietStart}:00-${quietEnd}:00) active.`;
      level = "log";
      reason = "Notification suppressed during quiet hours.";
    }
  }

  if (level !== "log") {
    const exceeded =
      userContext.recentContactCount >= config.maxContactsPerHour ||
      userContext.recentContactCount >= config.maxContactsPerDay;
    if (exceeded) {
      degradeReason = degradeReason
        ? `${degradeReason}; Recent contacts exceed rate limits.`
        : "Recent contacts exceed rate limits.";
      level = "log";
      reason = "Notification suppressed due to rate limits.";
    }
  }

  const shouldContact = level !== "log";
  let cooldownUntil: string | undefined;
  if (level === "call") {
    cooldownUntil = minutesFromNow(5);
  } else if (shouldContact) {
    cooldownUntil = minutesFromNow(15);
  }

  return {
    shouldContact,
    attentionLevel: level,
    reason,
    cooldownUntil,
    ...(degradeReason ? { degradeReason } : {}),
  };
}
