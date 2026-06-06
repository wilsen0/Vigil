import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import fs from "node:fs";

const DASHSCOPE_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const API_KEY = process.env.TTS_API_KEY!;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const XIAOYIN_VOICE = "cosyvoice-v2-wilsen-078bd152fc744a33871a0c71b32a6025"; // 小音专属声音，老大定做

const text = process.argv[2] || "老大晚安！";

async function synthesize(text: string): Promise<Buffer> {
  const taskId = randomUUID();
  const audioChunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DASHSCOPE_ENDPOINT, {
      headers: { Authorization: `bearer ${API_KEY}` },
    });

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("timeout"));
    }, 30000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: "cosyvoice-v2",
          parameters: { text_type: "PlainText", voice: XIAOYIN_VOICE, format: "mp3", sample_rate: 22050, volume: 50, rate: 1, pitch: 1 },
          input: {},
        },
      }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        audioChunks.push(Buffer.from(data as ArrayBuffer));
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.header?.event === "task-started") {
        ws.send(JSON.stringify({ header: { action: "continue-task", task_id: taskId, streaming: "duplex" }, payload: { input: { text } } }));
        ws.send(JSON.stringify({ header: { action: "finish-task", task_id: taskId, streaming: "duplex" }, payload: { input: {} } }));
      } else if (msg.header?.event === "task-finished") {
        clearTimeout(timeout);
        ws.close();
        resolve(Buffer.concat(audioChunks));
      } else if (msg.header?.event === "task-failed") {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(msg.payload?.message || "task failed"));
      }
    });

    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

async function sendVoice(audio: Buffer): Promise<void> {
  const boundary = `----xiaoyin-${Date.now()}`;
  const parts: Buffer[] = [];

  // chat_id field
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT_ID}\r\n`));

  // voice file
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="voice.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`));
  parts.push(audio);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVoice`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: new Uint8Array(body),
  });

  const result = await response.json();
  if (!result.ok) {
    throw new Error(result.description || "sendVoice failed");
  }
  console.log("Sent! Message ID:", result.result.message_id);
}

async function main() {
  console.log(`Synthesizing: "${text}"`);
  const audio = await synthesize(text);
  console.log(`Got ${audio.byteLength} bytes`);

  await sendVoice(audio);
}

main().catch(console.error);
