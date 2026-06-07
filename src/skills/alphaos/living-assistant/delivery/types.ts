export interface DeliveryAdapterInput {
  decision: import("../contact-policy").ContactDecision;
  brief?: import("../voice-brief").VoiceBrief;
  audio?: import("../tts").TTSResult;
}
