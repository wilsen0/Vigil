import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramVoiceSender } from "../src/skills/alphaos/living-assistant/delivery/telegram-voice-sender";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("telegram voice sender", () => {
  it("sendVoice builds multipart/form-data request", async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 101 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const sender = new TelegramVoiceSender({
      botToken: "bot-token",
      chatId: "owner-chat-id",
    });

    const result = await sender.sendVoice(Buffer.from("ogg-opus-audio"), {
      caption: "Brief ready",
      parseMode: "HTML",
      disableNotification: true,
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(101);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://api.telegram.org/botbot-token/sendVoice");
    expect(init?.method).toBe("POST");

    const headers = init?.headers as Record<string, string>;
    const contentType = headers["Content-Type"];
    expect(contentType).toContain("multipart/form-data; boundary=");

    const boundary = contentType.split("boundary=")[1];
    const body = init?.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);

    const payload = Buffer.from(body).toString("utf8");
    expect(payload).toContain(`--${boundary}`);
    expect(payload).toContain('name="chat_id"');
    expect(payload).toContain("owner-chat-id");
    expect(payload).toContain('name="caption"');
    expect(payload).toContain("Brief ready");
    expect(payload).toContain('name="parse_mode"');
    expect(payload).toContain("HTML");
    expect(payload).toContain('name="disable_notification"');
    expect(payload).toContain("true");
    expect(payload).toContain('name="voice"; filename="brief.ogg"');
    expect(payload).toContain("Content-Type: audio/ogg");
  });

  it("sendText builds JSON request", async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 202 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const sender = new TelegramVoiceSender({
      botToken: "bot-token",
      chatId: "owner-chat-id",
    });

    const result = await sender.sendMessage("Heads up", {
      parseMode: "Markdown",
      disableNotification: true,
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(202);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(init?.method).toBe("POST");

    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: "owner-chat-id",
      text: "Heads up",
      parse_mode: "Markdown",
      disable_notification: true,
    });
  });

  it("sendVoiceWithFollowUp sends voice first and text second", async () => {
    const mockFetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 1 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: 2 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const sender = new TelegramVoiceSender({
      botToken: "bot-token",
      chatId: "owner-chat-id",
    });

    const result = await sender.sendVoiceWithFollowUp(
      Buffer.from("ogg-opus-audio"),
      "Voice caption",
      "Follow-up details",
      { parseMode: "HTML" },
    );

    expect(result.voice.ok).toBe(true);
    expect(result.voice.messageId).toBe(1);
    expect(result.followUp.ok).toBe(true);
    expect(result.followUp.messageId).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0][0])).toContain("/sendVoice");
    expect(String(mockFetch.mock.calls[1][0])).toContain("/sendMessage");
  });

  it("handles HTTP and network errors gracefully", async () => {
    const sender = new TelegramVoiceSender({
      botToken: "bot-token",
      chatId: "owner-chat-id",
    });

    const httpErrorFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            description: "Bad Request: voice file is invalid",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    globalThis.fetch = httpErrorFetch as unknown as typeof fetch;

    const voiceResult = await sender.sendVoice(Buffer.from("bad-audio"));
    expect(voiceResult.ok).toBe(false);
    expect(voiceResult.error).toContain("Bad Request");

    const networkErrorFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => {
        throw new Error("network down");
      },
    );
    globalThis.fetch = networkErrorFetch as unknown as typeof fetch;

    const textResult = await sender.sendMessage("hello");
    expect(textResult.ok).toBe(false);
    expect(textResult.error).toContain("network down");
  });
});
