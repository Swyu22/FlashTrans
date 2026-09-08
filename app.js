/* FlashTrans 前端逻辑 */

// 部署 Worker 后替换为实际地址
const WORKER_URL = "https://flashtrans-api.swyu17.workers.dev/";

const input = document.getElementById("input");
const output = document.getElementById("output");
const directionTag = document.getElementById("directionTag");
const charCount = document.getElementById("charCount");
const statusEl = document.getElementById("status");
const btnTranslate = document.getElementById("btnTranslate");
const btnPaste = document.getElementById("btnPaste");
const btnCopyInput = document.getElementById("btnCopyInput");
const btnClear = document.getElementById("btnClear");
const btnCopyOutput = document.getElementById("btnCopyOutput");
const toastEl = document.getElementById("toast");

let translated = ""; // 当前译文纯文本
let translating = false;
let toastTimer = null;

/* ---------- 工具 ---------- */

function showToast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("error", isError);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
}

// 与 Worker 端保持一致的方向检测：汉字占比 > 30% 判为中→英
function detectDirection(text) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  if (cjk + latin === 0) return null;
  return cjk / (cjk + latin) > 0.3 ? "zh2en" : "en2zh";
}

function refreshMeta() {
  const text = input.value;
  charCount.textContent = text.length + " 字";
  const dir = detectDirection(text);
  if (!dir) {
    directionTag.textContent = "自动检测";
    directionTag.classList.add("idle");
  } else {
    directionTag.textContent = dir === "zh2en" ? "中 → 英" : "EN → 中";
    directionTag.classList.remove("idle");
  }
}

function renderOutput(text) {
  if (text) {
    output.textContent = text;
  } else {
    output.innerHTML = '<span class="placeholder">译文将在此显示</span>';
  }
}

async function copyText(text, okMsg) {
  if (!text) {
    showToast("暂无可复制的内容", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg);
  } catch {
    // 降级：临时 textarea + execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast(okMsg);
    } catch {
      showToast("复制失败，请手动选择复制", true);
    }
    document.body.removeChild(ta);
  }
}

/* ---------- 翻译 ---------- */

function setLoading(on) {
  translating = on;
  btnTranslate.disabled = on;
  statusEl.textContent = on ? "翻译中…" : "";
}

async function translate() {
  if (translating) return;
  const text = input.value.trim();
  if (!text) {
    showToast("请先输入要翻译的内容", true);
    return;
  }
  setLoading(true);
  translated = "";
  renderOutput("");
  try {
    const resp = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      let msg = "请求失败（HTTP " + resp.status + "）";
      try {
        const j = await resp.json();
        if (j && j.error) msg = j.error;
      } catch { /* 保留默认错误信息 */ }
      throw new Error(msg);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const delta =
            json.choices && json.choices[0] && json.choices[0].delta
              ? json.choices[0].delta.content || ""
              : "";
          if (delta) {
            translated += delta;
            renderOutput(translated);
          }
        } catch { /* 忽略不完整的数据块 */ }
      }
    }
    if (!translated) {
      showToast("未收到译文，请重试", true);
    }
  } catch (e) {
    renderOutput(translated);
    showToast(e.message || "网络错误，请稍后重试", true);
  } finally {
    setLoading(false);
  }
}

/* ---------- 事件绑定 ---------- */

input.addEventListener("input", refreshMeta);

btnTranslate.addEventListener("click", translate);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    translate();
  }
});

btnPaste.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      showToast("剪贴板为空", true);
      return;
    }
    input.value = text;
    refreshMeta();
    input.focus();
  } catch {
    showToast("无法读取剪贴板，请使用 Ctrl + V 手动粘贴", true);
    input.focus();
  }
});

btnCopyInput.addEventListener("click", () => copyText(input.value, "已复制原文"));

btnCopyOutput.addEventListener("click", () => copyText(translated, "已复制译文"));

btnClear.addEventListener("click", () => {
  input.value = "";
  translated = "";
  renderOutput("");
  refreshMeta();
  input.focus();
});

refreshMeta();

// PWA：注册 Service Worker（仅 HTTPS 环境下生效）
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
