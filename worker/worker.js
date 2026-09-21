/**
 * FlashTrans API 代理 Worker
 * - 密钥与翻译提示词均以 Cloudflare Secrets 注入，源码中不含任何明文机密
 * - 按 IP 限流 + 输入截断 + Origin 校验，防止端点被滥用
 */

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-chat";
const TEMPERATURE = 0.8;

const MAX_TEXT_LEN = 8000; // 单次输入上限（字符）
const RATE_PER_MIN = 20; // 每 IP 每分钟上限
const RATE_PER_DAY = 200; // 每 IP 每天上限

const ALLOWED_ORIGINS = [
  "https://swyu22.github.io",
  "https://www.flashtrans.xyz",
  "https://flashtrans.xyz",
  "http://www.flashtrans.xyz",
  "http://flashtrans.xyz",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

// 每实例内存计数器（多实例下为近似限流，足够挡住常规滥用）
const rateMap = new Map();

function checkRate(ip) {
  const now = Date.now();
  let rec = rateMap.get(ip);
  if (!rec) {
    rec = { minStart: now, minCount: 0, dayStart: now, dayCount: 0 };
    rateMap.set(ip, rec);
  }
  if (now - rec.minStart > 60_000) {
    rec.minStart = now;
    rec.minCount = 0;
  }
  if (now - rec.dayStart > 86_400_000) {
    rec.dayStart = now;
    rec.dayCount = 0;
  }
  if (rec.minCount >= RATE_PER_MIN || rec.dayCount >= RATE_PER_DAY) return false;
  rec.minCount += 1;
  rec.dayCount += 1;
  return true;
}

// 汉字占比 > 30% 判为中→英，与前端 app.js 的规则一致
function detectDirection(text) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  if (cjk + latin === 0) return "en2zh";
  return cjk / (cjk + latin) > 0.3 ? "zh2en" : "en2zh";
}

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

function json(data, status, base) {
  const headers = new Headers(base);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

/* ---------------- 豆包流式 ASR 代理（/asr） ----------------
 * 浏览器发裸 PCM（16k/16bit/单声道）+ JSON 控制消息；
 * Worker 负责火山鉴权、二进制帧编解码（无压缩）、配额与收尾时序。
 */
const ASR_URL = "https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const ASR_MAX_SESSION_MS = 60_000; // 单会话硬顶 60s
const ASR_DAILY_SECONDS = 1_800; // 每 IP 每日 30 分钟

// ip -> { active, dayStart, daySeconds }（内存近似计数）
const asrMap = new Map();

// 构造火山二进制帧：4 字节头 + 4 字节大端长度 + payload
function asrFrame(headerByte1, headerByte2, payload) {
  const out = new Uint8Array(8 + payload.length);
  out[0] = 0x11; // version 1, header size 1
  out[1] = headerByte1;
  out[2] = headerByte2;
  out[3] = 0x00;
  new DataView(out.buffer).setUint32(4, payload.length);
  out.set(payload, 8);
  return out;
}

async function handleAsr(request, env, origin) {
  const base = corsHeaders(origin);
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return json({ error: "Expected WebSocket" }, 426, base);
  }
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return json({ error: "Forbidden origin" }, 403, base);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  let rec = asrMap.get(ip);
  if (!rec) {
    rec = { active: false, dayStart: now, daySeconds: 0 };
    asrMap.set(ip, rec);
  }
  if (now - rec.dayStart > 86_400_000) {
    rec.dayStart = now;
    rec.daySeconds = 0;
  }
  if (rec.active) {
    return json({ error: "已有进行中的语音会话，请稍后再试" }, 429, base);
  }
  if (rec.daySeconds >= ASR_DAILY_SECONDS) {
    return json({ error: "今日语音额度已用完，请明天再试" }, 429, base);
  }

  // 出站连接火山（鉴权头只在服务端出现）
  let vsResp;
  try {
    vsResp = await fetch(ASR_URL, {
      headers: {
        Upgrade: "websocket",
        "X-Api-Key": env.DOUBAO_API_KEY,
        "X-Api-Resource-Id": env.ASR_RESOURCE_ID || "volc.seedasr.sauc.duration",
        "X-Api-Connect-Id": crypto.randomUUID(),
        "X-Api-Request-Id": crypto.randomUUID(),
        "X-Api-Sequence": "-1",
      },
    });
  } catch {
    return json({ error: "语音识别服务暂不可用，请稍后重试" }, 502, base);
  }
  const volcano = vsResp.webSocket;
  if (!volcano) {
    return json({ error: "语音识别服务握手失败" }, 502, base);
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  rec.active = true;
  const startedAt = now;
  let ended = false;
  let finishing = false;

  const end = () => {
    if (ended) return;
    ended = true;
    rec.active = false;
    rec.daySeconds += Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    clearTimeout(hardTimer);
    try { volcano.close(1000); } catch { /* 已关闭 */ }
    try { server.close(1000); } catch { /* 已关闭 */ }
  };

  const sendClient = (obj) => {
    try { server.send(JSON.stringify(obj)); } catch { /* 已关闭 */ }
  };

  const finish = () => {
    if (finishing || ended) return;
    finishing = true;
    try { volcano.send(asrFrame(0x22, 0x00, new Uint8Array(0))); } catch { /* 已关闭 */ }
    setTimeout(end, 5_000); // 兜底：正常路径在收到最终包后 end()
  };

  // 60s 硬顶：通知前端后立即进入收尾
  const hardTimer = setTimeout(() => {
    sendClient({ type: "timeout" });
    finish();
  }, ASR_MAX_SESSION_MS);

  // 先挂火山侧监听，再 accept/send，避免竞态丢帧
  volcano.addEventListener("message", async (e) => {
    if (ended) return;
    let data = e.data;
    if (typeof data === "string") return;
    // workerd 新版运行时二进制帧以 Blob 投递（workerd#6615），需转 ArrayBuffer
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      try {
        data = await data.arrayBuffer();
      } catch {
        return;
      }
      if (ended) return;
    }
    const pl = new Uint8Array(data);
    if (pl.length < 8) return;
    const mtype = pl[1] >> 4;
    const flags = pl[1] & 0x0f;
    const view = new DataView(pl.buffer, pl.byteOffset, pl.byteLength);
    let off = (pl[0] & 0x0f) * 4;
    if (mtype === 0b1001) {
      if (flags & 0b01) off += 4; // sequence 字段条件存在
      const psize = view.getUint32(off);
      off += 4;
      let payload = {};
      try {
        payload = JSON.parse(new TextDecoder().decode(pl.subarray(off, off + psize)));
      } catch { /* 忽略损坏包 */ }
      const result = payload.result || {};
      const utt = result.utterances || [];
      sendClient({
        text: result.text || "",
        definite: utt.length ? !!utt[utt.length - 1].definite : false,
        duration: (payload.audio_info && payload.audio_info.duration) || 0,
        final: flags === 0b0011,
      });
      if (flags === 0b0011) end();
    } else if (mtype === 0b1111) {
      const code = view.getUint32(off);
      const esize = view.getUint32(off + 4);
      const msg = new TextDecoder().decode(pl.subarray(off + 8, off + 8 + esize));
      sendClient({ error: "语音识别错误（" + code + "）：" + msg });
      end();
    }
  });
  volcano.addEventListener("close", (e) => {
    if (!ended) {
      sendClient({
        error:
          "识别服务连接已关闭（code " +
          (e && e.code) +
          "）：" +
          ((e && e.reason) || "无原因"),
      });
      end();
    }
  });
  volcano.addEventListener("error", () => {
    sendClient({ error: "识别服务连接异常" });
    end();
  });

  volcano.accept();
  server.accept();

  // 首包：识别参数（无压缩 JSON）
  const initPayload = new TextEncoder().encode(
    JSON.stringify({
      user: { uid: "flashtrans-web" },
      audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 },
      request: { model_name: "bigmodel", enable_itn: true, enable_punc: true },
    })
  );
  try {
    volcano.send(asrFrame(0x10, 0x10, initPayload));
  } catch {
    return json({ error: "语音识别服务初始化失败" }, 502, base);
  }

  // 浏览器 -> 火山
  server.addEventListener("message", (e) => {
    if (ended) return;
    const data = e.data;
    if (typeof data === "string") {
      let msg = null;
      try { msg = JSON.parse(data); } catch { /* 非 JSON 忽略 */ }
      if (msg && msg.type === "stop") finish();
      return;
    }
    try {
      volcano.send(asrFrame(0x20, 0x00, new Uint8Array(data)));
    } catch {
      end();
    }
  });
  server.addEventListener("close", end);
  server.addEventListener("error", end);

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const base = corsHeaders(origin);

    if (new URL(request.url).pathname === "/asr") {
      return handleAsr(request, env, origin);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: base });
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "Forbidden origin" }, 403, base);
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, base);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!checkRate(ip)) {
      return json(
        { error: "请求过于频繁，请稍后再试（限流：每分钟 20 次，每天 200 次）" },
        429,
        base
      );
    }

    let text;
    try {
      const body = await request.json();
      text = typeof body.text === "string" ? body.text : "";
    } catch {
      return json({ error: "请求格式错误" }, 400, base);
    }
    if (!text.trim()) {
      return json({ error: "请输入要翻译的内容" }, 400, base);
    }
    if (text.length > MAX_TEXT_LEN) {
      text = text.slice(0, MAX_TEXT_LEN);
    }

    const systemPrompt =
      detectDirection(text) === "zh2en" ? env.PROMPT_ZH2EN : env.PROMPT_EN2ZH;

    // 用标签包裹待译文本，配合提示词防止原文被当作指令执行
    const userContent = "<source_text>\n" + text + "\n</source_text>";

    let dsResp;
    try {
      dsResp = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: TEMPERATURE,
          stream: true,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        }),
      });
    } catch {
      return json({ error: "翻译服务暂时不可用，请稍后重试" }, 502, base);
    }

    if (!dsResp.ok) {
      let msg = "翻译服务异常（HTTP " + dsResp.status + "）";
      try {
        const j = await dsResp.json();
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch { /* 保留默认错误信息 */ }
      return json({ error: msg }, dsResp.status, base);
    }

    const headers = new Headers(base);
    headers.set("Content-Type", "text/event-stream; charset=utf-8");
    headers.set("Cache-Control", "no-cache");
    return new Response(dsResp.body, { status: 200, headers });
  },
};
