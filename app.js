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
  if (translating || voice || voiceStarting) return;
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
    if (!resp.body) {
      throw new Error("服务响应异常，请稍后重试");
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
      showToast((e && e.message) || "网络错误，请稍后重试", true);
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
let activePointerId = null; // 多点触控过滤：只响应第一根手指
let voiceStarting = false;
let cancelVoiceStart = false;
let voice = null; // 录音会话状态
let micStream = null; // 麦克风流常驻复用：授权一次，页面生命周期内不再重复弹权限
let sharedAudioCtx = null; // 常驻 AudioContext：在 pointerdown 手势内创建/恢复（iOS 要求）

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

// 仅在用户手势上下文（pointerdown）中调用：创建并 resume 常驻 AudioContext
function getSharedAudioCtx() {
  if (typeof AudioContext === "undefined") return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    try {
      sharedAudioCtx = new AudioContext({ sampleRate: 16000 });
    } catch {
      sharedAudioCtx = new AudioContext(); // 不支持指定采样率则原生采样率，后续重采样
    }
  }
  if (sharedAudioCtx.state === "suspended") {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

/* ---- 语音预热：pointerdown 即开始，争取 500ms 阈值到时直接进"聆听" ---- */
let voicePrep = null; // { ws, openP, workletP, error, cancelled }

function prepareVoice() {
  if (voicePrep || voice || voiceStarting || translating) return;
  const ws = new WebSocket(ASR_URL);
  ws.binaryType = "arraybuffer";
  voicePrep = {
    ws,
    openP: null,
    workletP: null,
    error: null,
    cancelled: false,
    wsReady: false,
  };
  voicePrep.openP = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  voicePrep.openP
    .then(() => { if (voicePrep) voicePrep.wsReady = true; })
    .catch((e) => { if (voicePrep) voicePrep.error = e; });

  // 麦克风：只有已授权过才预热（避免单击翻译的用户被权限弹窗打扰）
  (async () => {
    if (micStream) return; // 常驻流已在，零成本
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: "microphone" });
        if (st.state !== "granted") return;
      }
    } catch {
      return; // 查询能力缺失则不预热，按阈值时申请
    }
    try {
      await getMicStream();
    } catch (e) {
      if (voicePrep) voicePrep.error = e;
    }
  })();

  // worklet 模块预载（无副作用）
  const ctx = sharedAudioCtx;
  if (ctx && ctx.audioWorklet) {
    voicePrep.workletP = ctx.audioWorklet
      .addModule("recorder-worklet.js?v=20260922")
      .catch((e) => { if (voicePrep) voicePrep.error = e; });
  }
}

function discardVoicePrep() {
  if (!voicePrep) return;
  voicePrep.cancelled = true;
  try { voicePrep.ws.close(); } catch { /* 忽略 */ }
  voicePrep = null;
}

function setVoiceUI(active, label) {
  btnTranslate.classList.toggle("recording", active);
  btnTranslate.textContent = label || "翻 译";
  [btnPaste, btnCopyInput, btnClear, btnCopyOutput].forEach((b) => {
    b.disabled = active;
  });
  input.readOnly = active;
}

// 重采样并累积：跨块保留余量样本，避免逐块丢尾造成的时间压缩
function pushAudio(v, float32) {
  const merged = new Float32Array(v.pcmCarry.length + float32.length);
  merged.set(v.pcmCarry);
  merged.set(float32, v.pcmCarry.length);
  const outLen = Math.floor(merged.length / v.ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let s = merged[Math.floor(i * v.ratio)];
    s = Math.max(-1, Math.min(1, s));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  v.pcmCarry = merged.subarray(Math.floor(outLen * v.ratio));
  const bytes = new Uint8Array(out.buffer);
  v.pending.push(bytes);
  v.pendingLen += bytes.length;
  drainChunks(v, false);
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
  // 麦克风轨道与 AudioContext 均常驻复用，不在此关闭
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
    voice.cancelled = true;
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
  // 接管 pointerdown 时的预热成果（WS 建连 / 麦克风 / worklet）
  const prep = voicePrep;
  voicePrep = null;
  setVoiceUI(true, prep && prep.wsReady && !prep.error ? "正在聆听…" : "准备中…");
  try {
    // 1. 先取麦克风权限（拒绝则直接复位；流常驻，后续不再弹权限）
    let stream;
    try {
      stream = await getMicStream();
    } catch {
      setVoiceUI(false);
      showToast("无法访问麦克风，请检查浏览器权限设置", true);
      if (prep) { try { prep.ws.close(); } catch { /* 忽略 */ } }
      return;
    }
    if (cancelVoiceStart) {
      setVoiceUI(false);
      if (prep) { try { prep.ws.close(); } catch { /* 忽略 */ } }
      return;
    }

    // 2. 连接 ASR 代理：优先复用预热的连接，预热失败则新建
    let ws, openP;
    if (prep && !prep.cancelled && !prep.error) {
      ws = prep.ws;
      openP = prep.openP;
    } else {
      if (prep) { try { prep.ws.close(); } catch { /* 忽略 */ } }
      ws = new WebSocket(ASR_URL);
      ws.binaryType = "arraybuffer";
      openP = new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
    }
    voice = {
      ws, node: null, gain: null,
      pending: [], pendingLen: 0, latestText: "",
      pcmCarry: new Float32Array(0),
      finishing: false, done: false, cancelled: false, countTimer: null,
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
        // 服务端已达 60s：停止采集、进入收尾，等待最终结果
        if (!voice.finishing) {
          voice.finishing = true;
          btnTranslate.textContent = "识别中…";
          stopLocalAudio();
        }
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

    await openP; // 预热过的连接通常已完成握手，此处零等待
    // 启动窗口检查点：松手/取消/异常后不再继续搭建
    if (!voice || voice.done || cancelVoiceStart) {
      try { ws.close(); } catch { /* 忽略 */ }
      return;
    }

    // 3. 音频采集管线（AudioContext 常驻，已在 pointerdown 手势中创建/恢复）
    const audioCtx = sharedAudioCtx || getSharedAudioCtx();
    if (!audioCtx || !audioCtx.audioWorklet) {
      throw new Error("unsupported");
    }
    await audioCtx.resume(); // 幂等
    if (prep && prep.workletP) {
      await prep.workletP; // 预热过的模块加载通常已完成
      if (prep.error) throw prep.error;
    } else {
      await audioCtx.audioWorklet.addModule("recorder-worklet.js?v=20260922");
    }
    if (!voice || voice.done || cancelVoiceStart) {
      return;
    }
    const source = audioCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(audioCtx, "recorder");
    const gain = audioCtx.createGain(); // 静音挂载，驱动 worklet 运行
    gain.gain.value = 0;
    source.connect(node);
    node.connect(gain);
    gain.connect(audioCtx.destination);

    voice.node = node;
    voice.gain = gain;
    voice.ratio = audioCtx.sampleRate / 16000;
    voice.startTs = Date.now();

    node.port.onmessage = (e) => {
      if (!voice || voice.finishing || !voice.ws || voice.ws.readyState !== 1) return;
      pushAudio(voice, e.data);
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
    const hadVoice = voice && !voice.done && !voice.cancelled;
    if (voice) {
      try { voice.ws.close(); } catch { /* 忽略 */ }
      cleanupVoice();
    }
    setVoiceUI(false);
    if (err && err.message === "unsupported") {
      showToast("当前浏览器不支持语音输入，请升级浏览器", true);
    } else if (hadVoice && !cancelVoiceStart) {
      // 仅在确属用户可见故障时提示；启动窗口内主动取消不报错
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
  activePointerId = e.pointerId;
  // 在用户手势上下文内创建/恢复常驻 AudioContext（iOS 硬性要求）
  getSharedAudioCtx();
  // 按下即预热：WS 建连 + worklet 预载 +（已授权时）麦克风，与 500ms 阈值并行
  prepareVoice();
  try { btnTranslate.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  pressTimer = setTimeout(() => {
    pressTimer = null;
    startVoice();
  }, LONG_PRESS_MS);
});

btnTranslate.addEventListener("pointerup", (e) => {
  if (e.pointerId !== activePointerId) return; // 忽略第二根手指
  activePointerId = null;
  if (pressTimer) {
    // 未达到长按阈值：单击翻译（静默丢弃预热连接）
    clearTimeout(pressTimer);
    pressTimer = null;
    discardVoicePrep();
    translate();
    return;
  }
  stopVoice(false); // 长按松手：收尾并自动翻译
});

btnTranslate.addEventListener("pointercancel", (e) => {
  if (e.pointerId !== activePointerId) return;
  activePointerId = null;
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
    discardVoicePrep(); // 系统中断：静默丢弃预热
    return;
  }
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
    if (voice || voiceStarting) return; // 录音中不触发，避免吞掉语音结束后的自动翻译
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
