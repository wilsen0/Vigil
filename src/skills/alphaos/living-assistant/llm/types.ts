export type LLMRole = "system" | "user" | "assistant";

export interface Message {
  role: LLMRole;
  content: string;
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  response_format?: {
    type: "json_object";
  };
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
}

export interface LLMRuntimeOptions {
  llmApiKey?: string;
  llmModel?: string;
  llmEnabled?: boolean;
}

export interface NaturalBriefOptions extends LLMRuntimeOptions {
  language: "zh" | "en";
}
