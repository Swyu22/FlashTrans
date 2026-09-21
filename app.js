/* FlashTrans 前端逻辑 */

// 部署 Worker 后替换为实际地址
const WORKER_URL = "https://api.flashtrans.xyz/";

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
  // 看门狗：20 秒无任何数据则中断，避免网络不通时永远卡在"翻译中"
  const ctrl = new AbortController();
  let watchdog = null;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => ctrl.abort(), 20000);
  };
  try {
    armWatchdog();
    const resp = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
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
      armWatchdog(); // 每收到数据块重置看门狗
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
    if (e && e.name === "AbortError") {
      showToast("连接超时：当前网络可能无法访问翻译服务，请切换网络或开启代理后重试", true);
    } else {
      showToast(e.message || "网络错误，请稍后重试", true);
    }
  } finally {
    clearTimeout(watchdog);
    setLoading(false);
  }
}

/* ---------- 语音输入（长按翻译按钮） ---------- */

const ASR_URL = WORKER_URL.replace(/^http/, "ws") + "asr";
const LONG_PRESS_MS = 500; // 超过即判定为长按
const VOICE_MAX_MS = 60000; // 与服务端 60s 硬顶一致
const CHUNK_BYTES = 6400; // 200ms @ 16kHz/16bit/单声道

let pressTimer = null;
let pressActive = false;
let voiceStarting = false;
let cancelVoiceStart = false;
let voice = null; // 录音会话状态
let micStream = null; // 麦克风流常驻复用：授权一次，页面生命周期内不再重复弹权限

async function getMicStream() {
  if (
    micStream &&
    micStream.active &&
    micStream.getAudioTracks().some((t) => t.readyState === "live")
  ) {
    return micStream;
  }
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  return micStream;
}

function setVoiceUI(active, label) {
  btnTranslate.classList.toggle("recording", active);
  btnTranslate.textContent = label || "翻 译";
  [btnPaste, btnCopyInput, btnClear, btnCopyOutput].forEach((b) => {
    b.disabled = active;
  });
  input.readOnly = active;
}

function floatTo16kPCM(float32, ratio) {
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let s = float32[Math.floor(i * ratio)];
    s = Math.max(-1, Math.min(1, s));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

// 把攒够的 PCM 以 200ms 一包发出；flushAll=true 时连尾包一起发
function drainChunks(v, flushAll) {
  while (v.pendingLen >= CHUNK_BYTES || (flushAll && v.pendingLen > 0)) {
    const take = flushAll && v.pendingLen < CHUNK_BYTES ? v.pendingLen : CHUNK_BYTES;
    const out = new Uint8Array(take);
    let off = 0;
    while (off < take) {
      const head = v.pending[0];
      const n = Math.min(head.length, take - off);
      out.set(head.subarray(0, n), off);
      off += n;
      if (n === head.length) v.pending.shift();
      else v.pending[0] = head.subarray(n);
    }
    v.pendingLen -= take;
    if (v.ws && v.ws.readyState === 1) v.ws.send(out);
  }
}

function stopLocalAudio() {
  if (!voice) return;
  clearInterval(voice.countTimer);
  try { voice.node && voice.node.disconnect(); } catch { /* 忽略 */ }
  try { voice.gain && voice.gain.disconnect(); } catch { /* 忽略 */ }
  // 注意：不停止麦克风轨道（micStream 常驻复用，避免重复弹权限）
  if (voice.audioCtx) voice.audioCtx.close().catch(() => {});
}

function cleanupVoice() {
  stopLocalAudio();
  voice = null;
}

// 结束：填入最终文本并自动翻译；abnormal=true 表示异常结束
function finalizeVoice(abnormal) {
  if (!voice || voice.done) return;
  voice.done = true;
  const text = (voice.latestText || "").trim();
  try { voice.ws.close(); } catch { /* 忽略 */ }
  cleanupVoice();
  setVoiceUI(false);
  if (text) {
    input.value = text;
    refreshMeta();
    translate();
  } else if (!abnormal) {
    showToast("未识别到语音，请长按后清晰说话", true);
  }
}

function stopVoice(cancelled) {
  if (voiceStarting && !voice) {
    cancelVoiceStart = true; // 启动流程中松手：标记取消
    return;
  }
  if (!voice || voice.finishing) return;
  voice.finishing = true;
  btnTranslate.textContent = "识别中…";
  stopLocalAudio();
  if (cancelled) {
    try { voice.ws.close(); } catch { /* 忽略 */ }
    cleanupVoice();
    setVoiceUI(false);
    return;
  }
  drainChunks(voice, true); // 尾包音频
  if (voice.ws.readyState === 1) {
    voice.ws.send(JSON.stringify({ type: "stop" }));
  } else {
    finalizeVoice(true);
  }
}

async function startVoice() {
  if (voice || voiceStarting || translating) return;
  voiceStarting = true;
  cancelVoiceStart = false;
  setVoiceUI(true, "准备中…");
  try {
    // 1. 先取麦克风权限（拒绝则直接复位；流常驻，后续不再弹权限）
    let stream;
    try {
      stream = await getMicStream();
    } catch {
      setVoiceUI(false);
      showToast("无法访问麦克风，请检查浏览器权限设置", true);
      return;
    }
    if (cancelVoiceStart) {
      setVoiceUI(false);
      return;
    }

    // 2. 连接 ASR 代理
    const ws = new WebSocket(ASR_URL);
    ws.binaryType = "arraybuffer";
    voice = {
      ws, stream, audioCtx: null, node: null, gain: null,
      pending: [], pendingLen: 0, latestText: "",
      finishing: false, done: false, countTimer: null,
      startTs: Date.now(), ratio: 1,
    };

    ws.onmessage = (e) => {
      if (!voice) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.error) {
        showToast(msg.error, true);
        finalizeVoice(true);
        return;
      }
      if (msg.type === "timeout") {
        stopLocalAudio(); // 服务端已达 60s，停采集等最终结果
        return;
      }
      if (typeof msg.text === "string" && msg.text) {
        voice.latestText = msg.text;
        input.value = msg.text; // 实时上屏
        refreshMeta();
      }
      if (msg.final) finalizeVoice(false);
    };
    ws.onerror = () => finalizeVoice(true);
    ws.onclose = () => finalizeVoice(true);

    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    if (cancelVoiceStart) {
      try { ws.close(); } catch { /* 忽略 */ }
      cleanupVoice();
      setVoiceUI(false);
      return;
    }

    // 3. 音频采集管线
    let audioCtx;
    try {
      audioCtx = new AudioContext({ sampleRate: 16000 });
    } catch {
      audioCtx = new AudioContext(); // 不支持指定采样率则原生采集后重采样
    }
    await audioCtx.resume(); // iOS 必须在用户手势中 resume
    if (!audioCtx.audioWorklet) {
      throw new Error("unsupported");
    }
    await audioCtx.audioWorklet.addModule("recorder-worklet.js");
    const source = audioCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioCtx, "recorder");
    const gain = audioCtx.createGain(); // 静音挂载，驱动 worklet 运行
    gain.gain.value = 0;
    source.connect(node);
    node.connect(gain);
    gain.connect(audioCtx.destination);

    voice.audioCtx = audioCtx;
    voice.node = node;
    voice.gain = gain;
    voice.ratio = audioCtx.sampleRate / 16000;
    voice.startTs = Date.now();

    node.port.onmessage = (e) => {
      if (!voice || voice.finishing || !voice.ws || voice.ws.readyState !== 1) return;
      const pcm = floatTo16kPCM(e.data, voice.ratio);
      voice.pending.push(pcm);
      voice.pendingLen += pcm.length;
      drainChunks(voice, false);
    };

    btnTranslate.textContent = "正在聆听…";
    voice.countTimer = setInterval(() => {
      if (!voice) return;
      const elapsed = Date.now() - voice.startTs;
      const remain = Math.max(0, Math.ceil((VOICE_MAX_MS - elapsed) / 1000));
      btnTranslate.textContent = remain <= 10 ? "松开发送 · " + remain + "s" : "正在聆听…";
      if (elapsed >= VOICE_MAX_MS) stopVoice(false);
    }, 250);
  } catch (err) {
    if (voice) {
      try { voice.ws.close(); } catch { /* 忽略 */ }
      cleanupVoice();
    }
    setVoiceUI(false);
    if (err && err.message === "unsupported") {
      showToast("当前浏览器不支持语音输入，请升级浏览器", true);
    } else if (!cancelVoiceStart) {
      showToast("语音服务连接失败，请稍后重试", true);
    }
  } finally {
    voiceStarting = false;
  }
}

/* ---------- 事件绑定 ---------- */

input.addEventListener("input", refreshMeta);

// 翻译按钮：单击=翻译，长按=语音输入（鼠标与触摸统一走 Pointer Events）
btnTranslate.addEventListener("pointerdown", (e) => {
  if (translating || voice || voiceStarting) return;
  e.preventDefault();
  pressActive = true;
  try { btnTranslate.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  pressTimer = setTimeout(() => {
    pressTimer = null;
    startVoice();
  }, LONG_PRESS_MS);
});

btnTranslate.addEventListener("pointerup", () => {
  if (pressTimer) {
    // 未达到长按阈值：单击翻译
    clearTimeout(pressTimer);
    pressTimer = null;
    pressActive = false;
    translate();
    return;
  }
  pressActive = false;
  stopVoice(false); // 长按松手：收尾并自动翻译
});

btnTranslate.addEventListener("pointercancel", () => {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
  pressActive = false;
  stopVoice(true); // 系统中断（来电/手势）：静默清理
});

btnTranslate.addEventListener("contextmenu", (e) => e.preventDefault());

btnTranslate.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    translate();
  }
});

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
