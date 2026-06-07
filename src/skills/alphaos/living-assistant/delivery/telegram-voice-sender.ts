export interface TelegramVoiceSenderConfig {
  botToken: string;
  defaultChatId?: string;
  chatId?: string;
}

export interface TelegramVoiceSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  sentAt?: string;
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  result?: {
    message_id?: number;
  };
}

interface TelegramVoiceOptions {
  chatId?: string;
  caption?: string;
  format?: string;
  duration?: number;
  parseMode?: string;
  disableNotification?: boolean;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface TelegramMessageOptions {
  chatId?: string;
  parseMode?: string;
  disableNotification?: boolean;
  inlineKeyboard?: TelegramInlineKeyboardButton[][];
}

const CRLF = "\r\n";

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asMessageId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(prefix: string, error: unknown): string {
  if (error instanceof Error) {
    return `${prefix}: ${error.message}`;
  }
  return `${prefix}: ${String(error)}`;
}

function normalizeFormat(format?: string): "ogg" | "mp3" {
  return format?.toLowerCase() === "mp3" ? "mp3" : "ogg";
}

function nowIso(): string {
  return new Date().toISOString();
}

export class TelegramVoiceSender {
  private readonly botToken: string;
  private readonly defaultChatId: string;

  constructor(private config: TelegramVoiceSenderConfig) {
    this.botToken = (config.botToken ?? "").trim();
    this.defaultChatId = (config.defaultChatId || config.chatId || "").trim();
  }

  async sendVoice(audio: Buffer, options?: TelegramVoiceOptions): Promise<TelegramVoiceSendResult> {
    const sentAt = nowIso();
    if (!this.botToken) {
      return { ok: false, error: "sendVoice failed: bot token is missing", sentAt };
    }
    if (!this.resolveChatId(options?.chatId)) {
      return { ok: false, error: "sendVoice failed: chat id is missing", sentAt };
    }
    if (audio.byteLength === 0) {
      return { ok: false, error: "sendVoice failed: audio buffer is empty", sentAt };
    }

    const boundary = `----living-assistant-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    const body = this.buildVoiceMultipartBody(boundary, audio, options);

    try {
      const response = await fetch(this.apiUrl("sendVoice"), {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: new Uint8Array(body),
      });
      return this.toSendResult(response, "sendVoice", sentAt);
    } catch (error) {
      return { ok: false, error: errorMessage("sendVoice failed", error), sentAt };
    }
  }

  async sendMessage(text: string, options?: TelegramMessageOptions): Promise<TelegramVoiceSendResult> {
    const sentAt = nowIso();
    if (!this.botToken) {
      return { ok: false, error: "sendMessage failed: bot token is missing", sentAt };
    }

    const chatId = this.resolveChatId(options?.chatId);
    if (!chatId) {
      return { ok: false, error: "sendMessage failed: chat id is missing", sentAt };
    }

    const trimmedText = text.trim();
    if (!trimmedText) {
      return { ok: false, error: "sendMessage failed: text is empty", sentAt };
    }

    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: trimmedText,
    };
    if (asOptionalString(options?.parseMode)) {
      payload.parse_mode = asOptionalString(options?.parseMode)!;
    }
    if (typeof options?.disableNotification === "boolean") {
      payload.disable_notification = options.disableNotification;
    }
    if (options?.inlineKeyboard && options.inlineKeyboard.length > 0) {
      payload.reply_markup = {
        inline_keyboard: options.inlineKeyboard,
      };
    }

    try {
      const response = await fetch(this.apiUrl("sendMessage"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      return this.toSendResult(response, "sendMessage", sentAt);
    } catch (error) {
      return { ok: false, error: errorMessage("sendMessage failed", error), sentAt };
    }
  }

  async sendVoiceWithFollowUp(
    audio: Buffer,
    voiceCaption: string,
    followUpText: string,
    options?: TelegramVoiceOptions & { inlineKeyboard?: TelegramInlineKeyboardButton[][] },
  ): Promise<{ voice: TelegramVoiceSendResult; followUp: TelegramVoiceSendResult }> {
    const voice = await this.sendVoice(audio, {
      ...options,
      caption: voiceCaption,
    });
    const followUp = await this.sendMessage(followUpText, {
      chatId: options?.chatId,
      parseMode: options?.parseMode,
      disableNotification: options?.disableNotification,
      inlineKeyboard: options?.inlineKeyboard,
    });
    return { voice, followUp };
  }

  private buildVoiceMultipartBody(boundary: string, audio: Buffer, options?: TelegramVoiceOptions): Buffer {
    const chunks: Buffer[] = [];
    const chatId = this.resolveChatId(options?.chatId);
    const format = normalizeFormat(options?.format);
    const fileName = format === "mp3" ? "brief.mp3" : "brief.ogg";
    const mimeType = format === "mp3" ? "audio/mpeg" : "audio/ogg";

    const pushTextField = (name: string, value: string) => {
      chunks.push(
        Buffer.from(
          `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
            `${value}${CRLF}`,
          "utf8",
        ),
      );
    };

    pushTextField("chat_id", chatId);

    const caption = asOptionalString(options?.caption);
    if (caption) {
      pushTextField("caption", caption);
    }

    if (typeof options?.duration === "number" && Number.isFinite(options.duration) && options.duration > 0) {
      pushTextField("duration", String(Math.round(options.duration)));
    }

    const parseMode = asOptionalString(options?.parseMode);
    if (parseMode) {
      pushTextField("parse_mode", parseMode);
    }

    if (typeof options?.disableNotification === "boolean") {
      pushTextField("disable_notification", String(options.disableNotification));
    }

    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="voice"; filename="${fileName}"${CRLF}` +
          `Content-Type: ${mimeType}${CRLF}${CRLF}`,
        "utf8",
      ),
    );
    chunks.push(audio);
    chunks.push(Buffer.from(CRLF, "utf8"));
    chunks.push(Buffer.from(`--${boundary}--${CRLF}`, "utf8"));
    return Buffer.concat(chunks);
  }

  private resolveChatId(overrideChatId?: string): string {
    return (overrideChatId ?? this.defaultChatId).trim();
  }

  private apiUrl(method: "sendVoice" | "sendMessage"): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  private async toSendResult(
    response: Response,
    operation: "sendVoice" | "sendMessage",
    sentAt: string,
  ): Promise<TelegramVoiceSendResult> {
    const payload = await this.readPayload(response);
    if (response.ok && payload?.ok !== false) {
      return {
        ok: true,
        messageId: asMessageId(payload?.result?.message_id),
        sentAt,
      };
    }

    return {
      ok: false,
      error: this.apiError(operation, response, payload),
      sentAt,
    };
  }

  private async readPayload(response: Response): Promise<TelegramApiResponse | null> {
    try {
      return (await response.json()) as TelegramApiResponse;
    } catch {
      return null;
    }
  }

  private apiError(
    operation: "sendVoice" | "sendMessage",
    response: Response,
    payload: TelegramApiResponse | null,
  ): string {
    const description = asOptionalString(payload?.description);
    if (description) {
      return `${operation} failed: ${description}`;
    }

    const status = `${response.status} ${response.statusText}`.trim();
    return `${operation} failed: ${status || "unknown response"}`;
  }
}
