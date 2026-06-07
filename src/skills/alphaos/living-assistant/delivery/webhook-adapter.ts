import type { ContactDecision } from "../contact-policy";
import type { VoiceBrief } from "../voice-brief";

export interface WebhookNotifierPayload {
  text: string;
  mode: "now";
}

export function formatWebhookDelivery(
  decision: ContactDecision,
  brief?: VoiceBrief,
): WebhookNotifierPayload {
  const contact = decision.shouldContact ? "yes" : "no";
  const snippet = brief
    ? ` brief=${brief.text.length > 140 ? `${brief.text.slice(0, 140)}...` : brief.text}`
    : "";
  return {
    mode: "now",
    text: `[living-assistant][${decision.attentionLevel}] contact=${contact} reason=${decision.reason}${snippet}`,
  };
}
