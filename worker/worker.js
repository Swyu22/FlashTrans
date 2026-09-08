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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const base = corsHeaders(origin);

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
