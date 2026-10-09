"use strict";

/* global RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, VideoDecoder, EncodedVideoChunk */

// 用 Worker + OffscreenCanvas 解码渲染（不可用时回退到主线程）
const USE_WORKER_DECODE = typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" &&
  typeof HTMLCanvasElement !== "undefined" && !!HTMLCanvasElement.prototype.transferControlToOffscreen;

const $ = (id) => document.getElementById(id);

const els = {
  login: $("login"),
  loginForm: $("loginForm"),
  password: $("password"),
  connectBtn: $("connectBtn"),
  loginError: $("loginError"),

  viewer: $("viewer"),
  stage: $("stage"),
  video: $("video"),
  canvas: $("canvas"),
  placeholder: $("placeholder"),

  status: $("status"),
  lat: $("lat"),
  stats: $("stats"),
  diag: $("diag"),
  qualitySel: $("qualitySel"),
  bitrateSel: $("bitrateSel"),
  modeSel: $("modeSel"),
  relayChk: $("relayChk"),
  keyboardBtn: $("keyboardBtn"),
  disconnectBtn: $("disconnectBtn"),
  toast: $("toast"),
  build: $("build"),
};

window.onerror = (msg, src, line, col) => {
  try {
    els.toast.textContent = "JS 错误: " + msg + " @" + line + ":" + col;
    els.toast.classList.remove("hidden");
  } catch (_) {}
};

const state = {
  token: null,
  config: null,
  ws: null,
  inputWs: null,
  pc: null,
  dc: null,
  mode: "webrtc",
  connected: false,
  pendingMove: null,
  moveScheduled: false,
  bytesLast: 0,
  bytesTime: 0,
  rxFrames: 0,
  rxBytes: 0,
  wheelX: 0,
  wheelY: 0,
  switchTimer: null,
  lastFrameAt: 0,
  webrtcStartAt: 0,
  fallbackCodec: "h264",
  decoder: null,
  decoderConfig: null,
  h264StartedAt: 0,
  h264Codec: "",
  needKey: true,
  rxCount: 0,
  rtt: -1,
  pingSent: 0,
  inputPingSent: 0,
  lastError: "",
  baseW: 0,
  baseH: 0,
  hwDecode: false,
  fullscreen: false,
  desktopCombo: false,
  lastKey: "",
  decodeLatency: 0,
  worker: null,
  workerH264: false,
  forceRelay: false,
  jbProc: 0,
  offsetUs: null,
  pingSentEpoch: 0,
  e2e: null,
  lastSubmitAt: 0,
  vfcToken: 0,
  setupToken: 0,
  webrtcStallRetries: 0,
};

/* ----------------------------- 工具 ----------------------------- */
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add("hidden"), ms);
}

function setStatus(text, cls = "") {
  els.status.textContent = text;
  els.status.className = "pill " + cls;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function fallbackMsg(codec) {
  const w = parseInt(els.qualitySel ? els.qualitySel.value : "1024", 10) || 1024;
  return JSON.stringify({ type: "fallback", on: true, codec, w });
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  return proto + location.host + "/api/signal?token=" + encodeURIComponent(state.token);
}

/* ----------------------------- 时钟偏移 ----------------------------- */
// 用 ping/pong 估计「服务端时钟 - 客户端时钟」(µs)，用于计算真实端到端延迟
function updateClockOffset(serverMs) {
  if (!serverMs || !state.pingSentEpoch) return;
  const now = Date.now();
  const rtt = now - state.pingSentEpoch;
  state.offsetUs = Math.round(((serverMs + rtt / 2) - now) * 1000);
  if (state.worker) {
    try { state.worker.postMessage({ type: "offset", us: state.offsetUs }); } catch (_) {}
  }
}

/* ----------------------------- 登录 ----------------------------- */
// 鼠标进入查看器时尽量把键盘焦点拉回本窗口（多显示器下常丢焦点）
if (els.viewer) els.viewer.addEventListener("mouseenter", () => { try { window.focus(); } catch (_) {} });
els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.connectBtn.disabled = true;
  els.loginError.textContent = "";
  try {
    const res = await fetch("api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: els.password.value }),
    });
    const data = await res.json();
    if (!data.ok) {
      els.loginError.textContent = data.error || "登录失败";
      els.connectBtn.disabled = false;
      return;
    }
    state.token = data.token;
    state.config = data.config || {};
    await start();
  } catch (err) {
    els.loginError.textContent = "无法连接服务：" + err.message;
    els.connectBtn.disabled = false;
  }
});

/* ----------------------------- 启动 ----------------------------- */
async function start() {
  els.login.classList.add("hidden");
  els.viewer.classList.remove("hidden");
  setStatus("连接中…", "warn");
  syncModeSelect();

  openWebSocket();
  openInputSocket();
  // 默认优先中继：按工具栏「强制中继」当前状态建立连接
  await setupWebRTC({ forceRelay: !!(els.relayChk && els.relayChk.checked) });
  try { window.focus(); els.stage.focus(); } catch (_) {}
}

function openWebSocket() {
  const ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.onmessage = onSignalingMessage;
  ws.onerror = () => setStatus("信令错误", "err");
  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    if (!state.token) return;
    setTimeout(() => {
      if (!state.ws) reconnectWebSocket();
    }, 2000);
  };
}

function openInputSocket() {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  const ws = new WebSocket(proto + location.host + "/api/signal-in?token=" + encodeURIComponent(state.token));
  state.inputWs = ws;
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const m = JSON.parse(ev.data);
      if (m.type === "pong" && state.inputPingSent) {
        state.rtt = Math.round(performance.now() - state.inputPingSent);
      }
      if (m.type === "pong" && m.s) updateClockOffset(m.s);
    } catch (_) {}
  };
  ws.onclose = () => {
    if (state.inputWs === ws) state.inputWs = null;
    setTimeout(() => {
      if (state.token && !state.inputWs) openInputSocket();
    }, 3000);
  };
}

function reconnectWebSocket() {
  if (!state.token || state.ws) return;
  const ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.onmessage = onSignalingMessage;
  ws.onopen = () => {
    if (state.mode === "fallback") ws.send(fallbackMsg(state.fallbackCodec));
  };
  ws.onclose = () => {
    if (state.ws === ws) state.ws = null;
    setTimeout(() => {
      if (!state.ws) reconnectWebSocket();
    }, 2000);
  };
  ws.onerror = () => {};
}

async function onSignalingMessage(event) {
  if (typeof event.data !== "string") {
    if (state.decoder || state.workerH264) decodeH264(event.data);
    return;
  }
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch (_) {
    return;
  }
  if (msg.type === "answer") {
    try {
      await state.pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
    } catch (err) {
      toast("设置远端描述失败：" + err.message, 5000);
      enableFallback("媒体协商失败，已切换兼容模式");
    }
  } else if (msg.type === "h264") {
    setupH264(msg);
  } else if (msg.type === "candidate") {
    if (state.pc && msg.candidate) {
      try { await state.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (_) {}
    }
  } else if (msg.type === "pong") {
    if (state.pingSent) state.rtt = Math.round(performance.now() - state.pingSent);
    if (msg.s) updateClockOffset(msg.s);
  }
}

/* ----------------------------- WebRTC ----------------------------- */
function closePeer() {
  if (state.dc) { try { state.dc.close(); } catch (_) {} state.dc = null; }
  if (state.pc) { try { state.pc.close(); } catch (_) {} state.pc = null; }
  state.vfcToken++;  // 停止旧的 rVFC 回调循环
  if (els.video) { try { els.video.srcObject = null; } catch (_) {} }
}

// 反复压低接收端播放/抖动缓冲（仅直连有效；中继抖动大，强制 0 会导致解码器卡死）
function tuneReceiver() {
  if (!state.pc || state.forceRelay) return;
  try {
    state.pc.getReceivers().forEach((r) => {
      if ("jitterBufferTarget" in r) r.jitterBufferTarget = 0;
      if ("playoutDelayHint" in r) r.playoutDelayHint = 0;
    });
  } catch (_) {}
}

function hasTurnServer(iceServers) {
  try {
    return (iceServers || []).some((s) => {
      const u = s.urls;
      const arr = Array.isArray(u) ? u : [u];
      return arr.some((x) => typeof x === "string" && /^turns?:/i.test(x));
    });
  } catch (_) { return false; }
}

function sendBitrate(softStart) {
  if (!state.ws || state.ws.readyState !== 1) return;
  let bps = 2000000;
  if (els.bitrateSel) { const v = parseInt(els.bitrateSel.value, 10); if (v) bps = v; }
  let start = bps, max = bps, min = 300000;
  if (state.forceRelay) {
    // 中继：设最低 1 Mbps 地板，避免 REMB 卡在低码率；并低码率软启动
    max = bps;
    min = 1000000;
    start = softStart ? Math.min(bps, min) : bps;
  }
  try {
    state.ws.send(JSON.stringify({ type: "bitrate", bps: start, max, min, relay: state.forceRelay }));
  } catch (_) {}
}

async function setupWebRTC(opts) {
  opts = opts || {};
  const cfg = state.config || {};
  const iceServers = (cfg.ice_servers && cfg.ice_servers.length)
    ? cfg.ice_servers
    : [{ urls: "stun:stun.l.google.com:19302" }];

  if (state.pc) { try { state.pc.close(); } catch (_) {} state.pc = null; }
  if (state.switchTimer) { clearTimeout(state.switchTimer); state.switchTimer = null; }
  state.forceRelay = !!opts.forceRelay;
  updateModeControls();

  const rtcConfig = { iceServers };
  if (opts.forceRelay) rtcConfig.iceTransportPolicy = "relay";

  const pc = new RTCPeerConnection(rtcConfig);
  state.pc = pc;
  state.webrtcStartAt = performance.now();

  pc.onicecandidate = (ev) => {
    if (ev.candidate && state.ws && state.ws.readyState === 1) {
      try { state.ws.send(JSON.stringify({ type: "candidate", candidate: ev.candidate.toJSON() })); } catch (_) {}
    }
  };

  pc.addTransceiver("video", { direction: "recvonly" });
  tuneReceiver();

  const dc = pc.createDataChannel("ctrl", { ordered: true });
  state.dc = dc;
  dc.onopen = () => {
    if (state.pc !== pc) return;
    state.mode = "webrtc";
    syncModeSelect();
    setConnected(true);
    if (state.forceRelay) setStatus("已连接(中继)", "ok");
  };

  pc.ontrack = (ev) => {
    if (state.pc !== pc || state.mode === "fallback") return;
    els.video.srcObject = ev.streams[0];
    els.video.play().catch(() => {});
    els.video.classList.remove("hidden");
    els.canvas.classList.add("hidden");
    els.placeholder.classList.add("hidden");
    state.mode = "webrtc";
    syncModeSelect();
    tuneReceiver();
    const v = els.video;
    if (v.requestVideoFrameCallback) {
      const token = ++state.vfcToken;
      const cb = () => {
        if (state.vfcToken !== token) return;  // 已被新连接取代，停止旧循环
        state.lastFrameAt = performance.now();
        if (!state.connected) setConnected(true);
        if (state.switchTimer) { clearTimeout(state.switchTimer); state.switchTimer = null; }
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    }
  };

  pc.onconnectionstatechange = () => {
    if (state.pc !== pc) return;
    const s = pc.connectionState;
    if (s === "connected") { setStatus(state.forceRelay ? "已连接(中继)" : "已连接", "ok"); tuneReceiver(); }
    else if (s === "connecting") setStatus("连接中…", "warn");
    else if (s === "failed") setStatus("直连失败", "err");
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc, 2500);

  const myToken = ++state.setupToken;
  const send = () => {
    if (state.setupToken !== myToken) return;  // 已有更新的 setup，停止重试
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp }));
    } else {
      setTimeout(send, 200);
    }
  };
  send();

  // 中继：降码率并设上限，避免浏览器 REMB 把码率重新拉高冲垮中继链路；非中继恢复默认
  sendBitrate(true);

  state.switchTimer = setTimeout(() => {
    if (state.connected || state.pc !== pc) return;
    if (!opts.forceRelay && hasTurnServer(iceServers)) {
      toast("P2P 打洞失败，改用 TURN 中继");
      setupWebRTC({ forceRelay: true });
    } else {
      enableFallback("未能建立 WebRTC（含中继），已切换兼容模式");
    }
  }, opts.forceRelay ? 8000 : 5000);
}

function waitIceGathering(pc, timeout) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const done = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", done);
        clearTimeout(t);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", done);
    const t = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", done);
      resolve();
    }, timeout);
  });
}

function setConnected(v) {
  state.connected = v;
  if (v) state.webrtcStallRetries = 0;
  if (v && state.switchTimer) {
    clearTimeout(state.switchTimer);
    state.switchTimer = null;
  }
  if (v) {
    setStatus(state.mode === "fallback"
      ? "兼容模式(硬解)"
      : (state.forceRelay ? "已连接(中继)" : "已连接"), state.mode === "fallback" ? "warn" : "ok");
  }
}

/* ----------------------------- 兼容模式 ----------------------------- */
function enableFallback(msg, codec) {
  sendLog("enableFallback: " + (msg || ""));
  state.mode = "fallback";
  state.fallbackCodec = codec || "h264";
  syncModeSelect();
  const sendFallback = (tries) => {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(fallbackMsg(state.fallbackCodec));
    } else if (tries > 0) {
      setTimeout(() => sendFallback(tries - 1), 500);
    } else {
      toast("信令 WebSocket 未连接，无法取流", 8000);
    }
  };
  sendFallback(10);
  if (msg) toast(msg);
  setConnected(true);
}

function teardownDecoder() {
  if (state.decoder) {
    try { state.decoder.close(); } catch (_) {}
    state.decoder = null;
  }
  stopH264Worker();
}

function setupH264(msg) {
  teardownDecoder();
  state.fallbackCodec = "h264";
  syncModeSelect();
  state.lastFrameAt = performance.now();
  state.h264StartedAt = performance.now();
  els.video.classList.add("hidden");
  els.placeholder.classList.add("hidden");

  const config = {
    codec: msg.codec || "avc1.42E01E",
    optimizeForLatency: true,
    hardwareAcceleration: "prefer-hardware",
  };
  if (msg.description) config.description = b64ToBytes(msg.description);
  state.decoderConfig = config;
  state.h264Codec = config.codec;

  if (USE_WORKER_DECODE && startH264Worker(config)) {
    probeHwDecode(config);
    return;
  }
  els.canvas.classList.remove("hidden");
  if (!canvasCtx) canvasCtx = els.canvas.getContext("2d");
  if (!ensureDecoder()) {
    toast("H.264 配置失败：" + (state.lastError || ""), 5000);
    return;
  }
  setStatus("兼容模式(硬解)", "warn");
  probeHwDecode(config);
}

/* ---------- Worker 解码路径 ---------- */
function onWorkerMessage(e) {
  const m = e.data;
  if (!m) return;
  if (m.type === "frame") {
    if (m.changed) { state.baseW = m.w; state.baseH = m.h; }
    state.lastFrameAt = performance.now();
    if (m.e2e != null) state.e2e = m.e2e;
    state.rxFrames += 1;
  } else if (m.type === "needkey") {
    state.needKey = true;
  } else if (m.type === "clock") {
    state.workerClock = { msOfDay: m.msOfDay, t: m.t };
  } else if (m.type === "error") {
    state.lastError = "worker:" + m.message;
  }
}

function sizeH264Worker() {
  const el = els.h264canvas;
  if (!el || !state.worker) return;
  const w = el.clientWidth, h = el.clientHeight;
  if (w && h) state.worker.postMessage({ type: "size", w, h, dpr: window.devicePixelRatio || 1 });
}

function startH264Worker(config) {
  try {
    stopH264Worker();
    const el = document.createElement("canvas");
    el.id = "h264canvas";
    el.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;background:#000;";
    els.stage.appendChild(el);
    els.h264canvas = el;
    els.canvas.classList.add("hidden");
    els.video.classList.add("hidden");
    const off = el.transferControlToOffscreen();
    const worker = new Worker("h264worker.js?v=91");
    state.worker = worker;
    worker.onmessage = onWorkerMessage;
    worker.postMessage({ type: "canvas", canvas: off }, [off]);
    worker.postMessage({ type: "size", w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1 });
    worker.postMessage({ type: "config", codec: config.codec, description: config.description || null });
    worker.postMessage({ type: "offset", us: state.offsetUs || 0 });
    state.workerH264 = true;
    state.needKey = true;
    setStatus("兼容模式(硬解·W)", "warn");
    return true;
  } catch (e) {
    state.lastError = "worker启动失败:" + e.message;
    stopH264Worker();
    return false;
  }
}

function stopH264Worker() {
  if (state.worker) {
    try { state.worker.postMessage({ type: "close" }); } catch (_) {}
    try { state.worker.terminate(); } catch (_) {}
    state.worker = null;
  }
  state.workerH264 = false;
  if (els.h264canvas && els.h264canvas.parentNode) els.h264canvas.parentNode.removeChild(els.h264canvas);
  els.h264canvas = null;
}

window.addEventListener("resize", () => { if (state.workerH264) sizeH264Worker(); });

async function probeHwDecode(config) {
  try {
    const hw = await VideoDecoder.isConfigSupported({
      codec: config.codec, hardwareAcceleration: "prefer-hardware",
    });
    state.hwDecode = !!(hw && hw.supported);
  } catch (_) {
    state.hwDecode = false;
  }
}

function ensureDecoder() {
  if (state.decoder && state.decoder.state === "configured") return true;
  if (!state.decoderConfig) return false;
  try { if (state.decoder) state.decoder.close(); } catch (_) {}
  try {
    state.decoder = new VideoDecoder({
      output: (frame) => {
        state.decodeLatency = Math.round(performance.now() - state.lastSubmitAt);
        if (state.offsetUs != null) {
          state.e2e = Math.round((Date.now() * 1000 + state.offsetUs - frame.timestamp) / 1000);
        }
        drawVideoFrame(frame);
        frame.close();
      },
      error: (e) => { state.lastError = "解码:" + e.message; },
    });
    state.decoder.configure(state.decoderConfig);
    state.needKey = true;
    return true;
  } catch (e) {
    state.lastError = "配置:" + e.message;
    state.decoder = null;
    return false;
  }
}

function decodeH264(buffer) {
  const u8 = new Uint8Array(buffer);
  if (u8.length < 10) return;  // 1 字节标志 + 8 字节采集时间戳 + 负载
  const isKey = u8[0] === 1;
  const tsUs = Number(new DataView(buffer).getBigUint64(1));  // 服务端采集时间(epoch µs)
  const data = u8.subarray(9);

  if (state.workerH264 && state.worker) {
    if (state.needKey && !isKey) return;
    if (isKey) state.needKey = false;
    const chunk = data.slice();
    state.rxCount += 1;
    state.rxBytes += u8.byteLength;
    try {
      state.worker.postMessage({ type: "chunk", key: isKey, ts: tsUs, data: chunk }, [chunk.buffer]);
    } catch (_) {}
    return;
  }

  if (!ensureDecoder()) return;
  if (state.decoder.decodeQueueSize > 12) {
    try { state.decoder.close(); } catch (_) {}
    state.decoder = null;
    ensureDecoder();
    state.needKey = true;
  }
  if (state.needKey && !isKey) return;
  if (isKey) state.needKey = false;

  state.lastSubmitAt = performance.now();
  try {
    state.decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: tsUs, data }));
    state.rxFrames += 1;
    state.rxCount += 1;
    state.rxBytes += u8.byteLength;
    state.lastFrameAt = performance.now();
  } catch (e) {
    state.lastError = "chunk:" + e.message;
    state.needKey = true;
  }
}

function drawVideoFrame(frame) {
  try {
    const fw = frame.displayWidth || frame.codedWidth;
    const fh = frame.displayHeight || frame.codedHeight;
    state.baseW = fw;
    state.baseH = fh;
    // 直接绘制到显示画布（避免中间画布的整帧拷贝，降低主线程负担）
    drawScaled(frame, fw, fh);
    state.lastError = "";
  } catch (e) {
    state.lastError = "draw:" + e.message;
  }
}

/* ----------------------------- 兼容模式画布 ----------------------------- */
let canvasCtx = null;

function drawScaled(source, sw, sh) {
  const canvas = els.canvas;
  if (!sw || !sh) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvasCtx = null;
  }
  if (!canvasCtx) canvasCtx = canvas.getContext("2d");
  const ctx = canvasCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  const scale = Math.min(w / sw, h / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function activeMedia() {
  if (state.mode === "fallback") return (state.workerH264 && els.h264canvas) ? els.h264canvas : els.canvas;
  return els.video;
}

function intrinsicSize() {
  if (state.mode === "fallback") {
    if (state.baseW) return { w: state.baseW, h: state.baseH };
    return null;
  }
  const v = els.video;
  if (!v.videoWidth) return null;
  return { w: v.videoWidth, h: v.videoHeight };
}

function contentRect() {
  const el = activeMedia();
  const r = el.getBoundingClientRect();
  const size = intrinsicSize();
  if (!size) return { x: r.left, y: r.top, w: r.width, h: r.height };
  const scale = Math.min(r.width / size.w, r.height / size.h);
  const w = size.w * scale, h = size.h * scale;
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
}

function sendInput(ev) {
  if (!state.connected) return;
  if (state.mode === "webrtc" && state.dc && state.dc.readyState === "open") {
    state.dc.send(JSON.stringify(ev));
    return;
  }
  const iw = state.inputWs;
  if (iw && iw.readyState === 1) {
    iw.send(JSON.stringify({ type: "input", ev }));
    return;
  }
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: "input", ev }));
}

function sendLog(msg) {
  try { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: "log", msg })); } catch (_) {}
}

function normalized(e) {
  const r = contentRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.x) / r.w)),
    y: Math.min(1, Math.max(0, (e.clientY - r.y) / r.h)),
  };
}

els.stage.addEventListener("mousemove", (e) => {
  if (!state.connected) return;
  state.pendingMove = normalized(e);
  if (!state.moveScheduled) {
    state.moveScheduled = true;
    requestAnimationFrame(() => {
      state.moveScheduled = false;
      if (state.pendingMove) {
        sendInput({ t: "m", x: state.pendingMove.x, y: state.pendingMove.y });
        state.pendingMove = null;
      }
    });
  }
});

els.stage.addEventListener("mousedown", (e) => {
  if (!state.connected) return;
  if (e.button === 0) els.stage.focus();
  sendInput({ t: "b", b: e.button, d: 1 });
  e.preventDefault();
});
window.addEventListener("mouseup", (e) => {
  if (!state.connected) return;
  sendInput({ t: "b", b: e.button, d: 0 });
});

els.stage.addEventListener("contextmenu", (e) => e.preventDefault());

els.stage.addEventListener("wheel", (e) => {
  if (!state.connected) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : 1;
  state.wheelY += e.deltaY * unit;
  state.wheelX += e.deltaX * unit;
  if (Math.abs(state.wheelY) >= 40 || Math.abs(state.wheelX) >= 40) {
    sendInput({ t: "w", dx: -Math.round(state.wheelX), dy: -Math.round(state.wheelY) });
    state.wheelX = 0;
    state.wheelY = 0;
  }
}, { passive: false });

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

// 是否把该按键转发给被控机：非全屏时不接管 Win 等系统快捷键，交回本机系统
function shouldForwardKey(e) {
  if (!state.connected || isTyping(e.target)) return false;
  if (!state.fullscreen && e.metaKey) return false;
  return true;
}

// 引导键命令模式：先按 ` 再按功能键（普通按键，不受输入法/组合键拦截影响）
let shortcutMode = false;
let shortcutTimer = null;
// 当前物理按下的按键：用于识别长按重复/重复派发，避免“先按功能键再补 Ctrl+Alt”误触发
const downCodes = new Set();
// 最近转发给被控机的时间戳：同机测试时 Agent 注入的按键会“回声”回本页面，
// 这些回放事件不应再当作本地快捷键（否则 Ctrl+Alt 按下后回放的 F 会误触发全屏）
const recentlyForwarded = new Map();

function toggleRelay() {
  if (!els.relayChk) return;
  els.relayChk.checked = !els.relayChk.checked;
  els.relayChk.dispatchEvent(new Event("change"));
}

function handleShortcutMode(e, dup) {
  if (!state.token || dup) return false;  // dup：重复事件不作为命令
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.code === "Backquote") {
    shortcutMode = true;
    clearTimeout(shortcutTimer);
    shortcutTimer = setTimeout(() => { shortcutMode = false; }, 3000);
    toast("命令模式：1/2/3 画质 · M 模式 · F 全屏 · R 中继 · Q 断开");
    return true;
  }
  if (!shortcutMode) return false;
  shortcutMode = false;
  clearTimeout(shortcutTimer);
  const code = e.code || "";
  const key = (e.key && e.key.length === 1) ? e.key.toLowerCase() : "";
  if (code === "Digit1" || code === "Numpad1" || key === "1") { applyQuality(1024); return true; }
  if (code === "Digit2" || code === "Numpad2" || key === "2") { applyQuality(1440); return true; }
  if (code === "Digit3" || code === "Numpad3" || key === "3") { applyQuality(1920); return true; }
  if (code === "KeyM" || key === "m") { cycleMode(); return true; }
  if (code === "KeyF" || key === "f") { tryFullscreenAndLock(); return true; }
  if (code === "KeyR" || key === "r") { toggleRelay(); return true; }
  if (code === "KeyQ" || key === "q") { location.reload(); return true; }
  return false;
}

// 主控端本地快捷键（Ctrl+Alt+…）：始终在转发给被控机之前拦截
function handleLocalShortcut(e, dup) {
  // dup：长按重复或重复派发；此时若再按下 Ctrl+Alt 会带上当前修饰键状态，
  // 造成“先按 F 再补 Ctrl+Alt 也触发”。必须要求 Ctrl+Alt 先按下的首次 keydown。
  if (!state.token || dup || !e.ctrlKey || !e.altKey) return false;
  // 刚刚才转发给被控机的同一按键（同机回声）不算本地快捷键
  const fwd = recentlyForwarded.get(e.code);
  if (fwd && performance.now() - fwd < 500) return false;
  const code = e.code || "";
  const key = (e.key && e.key.length === 1) ? e.key.toLowerCase() : "";
  if (code === "Digit1" || code === "Numpad1" || key === "1") { applyQuality(1024); return true; }
  if (code === "Digit2" || code === "Numpad2" || key === "2") { applyQuality(1440); return true; }
  if (code === "Digit3" || code === "Numpad3" || key === "3") { applyQuality(1920); return true; }
  if (code === "KeyM" || key === "m") { cycleMode(); return true; }
  if (code === "KeyF" || key === "f") { tryFullscreenAndLock(); return true; }
  if (code === "KeyR" || key === "r") { toggleRelay(); return true; }
  if (code === "KeyQ" || key === "q") { location.reload(); return true; }
  return false;
}

window.addEventListener("keydown", (e) => {
  state.lastKey = "C" + (e.ctrlKey ? 1 : 0) + "A" + (e.altKey ? 1 : 0) + "S" + (e.shiftKey ? 1 : 0) + " " + (e.code || e.key);
  const dup = downCodes.has(e.code);
  downCodes.add(e.code);
  if (handleShortcutMode(e, dup)) { e.preventDefault(); return; }
  if (handleLocalShortcut(e, dup)) { e.preventDefault(); return; }
  if (!shouldForwardKey(e)) return;
  // 自定义快捷键：Ctrl+D -> 被控机 Win+D（显示桌面）
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyD") {
    if (!dup) {
      sendInput({ t: "k", c: "ControlLeft", d: 0 });  // 清掉此前已下发的 Ctrl
      sendInput({ t: "k", c: "MetaLeft", d: 1 });
      sendInput({ t: "k", c: "KeyD", d: 1 });
      state.desktopCombo = true;
    }
    e.preventDefault();
    return;
  }
  sendInput({ t: "k", c: e.code, k: e.key.length === 1 ? e.key : undefined, d: 1 });
  recentlyForwarded.set(e.code, performance.now());
  e.preventDefault();
}, true);

window.addEventListener("keyup", (e) => {
  downCodes.delete(e.code);
  if (state.desktopCombo && e.code === "KeyD") {
    sendInput({ t: "k", c: "KeyD", d: 0 });
    sendInput({ t: "k", c: "MetaLeft", d: 0 });
    state.desktopCombo = false;
    e.preventDefault();
    return;
  }
  if (!shouldForwardKey(e)) return;
  sendInput({ t: "k", c: e.code, k: e.key.length === 1 ? e.key : undefined, d: 0 });
  e.preventDefault();
}, true);

// 失焦时清空按键状态，避免按键“卡住”导致后续误判
window.addEventListener("blur", () => downCodes.clear());

/* ----------------------------- 全屏 / 键盘锁定 ----------------------------- */
// 全屏时用 Keyboard Lock 捕获系统按键（Win、Alt+Tab、Esc 等），转发给被控机
const LOCK_KEYS = [
  "Escape", "Tab", "ContextMenu",
  "MetaLeft", "MetaRight", "AltLeft", "AltRight",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
];

async function lockKeyboard() {
  try {
    if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock(LOCK_KEYS);
  } catch (_) {}
}

function unlockKeyboard() {
  try {
    if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  } catch (_) {}
}

async function tryFullscreenAndLock() {
  if (isFullscreen()) {
    try { await document.exitFullscreen(); } catch (_) {}
    return;
  }
  try {
    if (els.viewer.requestFullscreen) await els.viewer.requestFullscreen();
  } catch (_) {}
  state.fullscreen = isFullscreen();
  if (state.fullscreen) {
    await lockKeyboard();
    toast("已全屏：Win / Alt+Tab 等系统快捷键将转发给被控机");
  }
}

document.addEventListener("fullscreenchange", () => {
  state.fullscreen = isFullscreen();
  if (state.fullscreen) lockKeyboard();
  else unlockKeyboard();
});

els.keyboardBtn.addEventListener("click", tryFullscreenAndLock);

/* ----------------------------- 模式：直连 / 硬解码 ----------------------------- */
function currentMode() {
  return state.mode === "fallback" ? state.fallbackCodec : "webrtc";
}

function updateModeControls() {
  const fb = state.mode === "fallback";
  if (els.qualitySel) els.qualitySel.style.display = fb ? "" : "none";
  if (els.bitrateSel) els.bitrateSel.style.display = fb ? "none" : "";
  if (els.relayChk) {
    const label = els.relayChk.closest(".chk");
    if (label) label.style.display = fb ? "none" : "";
  }
}

function syncModeSelect() {
  if (!els.modeSel) return;
  const v = currentMode();
  if (els.modeSel.value !== v) els.modeSel.value = v;
  updateModeControls();
}

function setMode(target) {
  if (target === currentMode()) { syncModeSelect(); return; }
  sendLog("setMode: " + target);
  if (target === "webrtc") {
    state.mode = "webrtc";
    teardownDecoder();
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: "fallback", on: false }));
    els.canvas.classList.add("hidden");
    els.video.classList.remove("hidden");
    if (state.pc) { try { state.pc.close(); } catch (_) {} state.pc = null; }
    setupWebRTC({ forceRelay: !!(els.relayChk && els.relayChk.checked) });
    toast("切换到直连（WebRTC）");
    return;
  }
  teardownDecoder();
  closePeer();
  state.needKey = true;
  enableFallback("已切换到硬解码(H.264)", "h264");
}

function cycleMode() {
  const order = ["webrtc", "h264"];
  setMode(order[(order.indexOf(currentMode()) + 1) % order.length]);
}

els.modeSel.addEventListener("change", () => setMode(els.modeSel.value));

/* ----------------------------- 强制中继 ----------------------------- */
if (els.relayChk) {
  els.relayChk.addEventListener("change", () => {
    state.forceRelay = els.relayChk.checked;
    toast(state.forceRelay ? "强制 TURN 中继" : "优先直连（失败自动中继）");
    state.mode = "webrtc";
    teardownDecoder();
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: "fallback", on: false }));
    els.canvas.classList.add("hidden");
    els.video.classList.remove("hidden");
    setupWebRTC({ forceRelay: state.forceRelay });
  });
}

/* ----------------------------- 直连码率 ----------------------------- */
if (els.bitrateSel) {
  try {
    const saved = localStorage.getItem("rc_bitrate");
    if (saved && Array.prototype.some.call(els.bitrateSel.options, (o) => o.value === saved)) els.bitrateSel.value = saved;
  } catch (_) {}
  els.bitrateSel.addEventListener("change", () => {
    try { localStorage.setItem("rc_bitrate", els.bitrateSel.value); } catch (_) {}
    if (state.mode === "webrtc") sendBitrate();
    const opt = els.bitrateSel.options[els.bitrateSel.selectedIndex];
    toast((state.forceRelay ? "中继码率：" : "直连码率：") + (opt ? opt.textContent : els.bitrateSel.value));
  });
}

/* ----------------------------- 画质档位 ----------------------------- */
function applyQuality(width) {
  if (width) els.qualitySel.value = String(width);
  if (state.mode === "fallback" && state.ws && state.ws.readyState === 1) {
    state.ws.send(fallbackMsg(state.fallbackCodec));
  }
  const opt = els.qualitySel.options[els.qualitySel.selectedIndex];
  toast("画质：" + (opt ? opt.textContent : els.qualitySel.value));
}
els.qualitySel.addEventListener("change", () => applyQuality());

els.disconnectBtn.addEventListener("click", () => { sendLog("disconnect: reload"); location.reload(); });
window.addEventListener("beforeunload", () => sendLog("beforeunload"));

/* ----------------------------- 媒体看门狗 ----------------------------- */
setInterval(() => {
  if (state.mode === "fallback") {
    if (state.fallbackCodec === "h264" && state.h264StartedAt &&
        performance.now() - state.lastFrameAt > 6000) {
      ensureDecoder();
      state.needKey = true;
      state.lastFrameAt = performance.now();
      setStatus("兼容模式(恢复中)", "warn");
    }
    return;
  }
  if (state.mode !== "webrtc") return;
  const ref = state.lastFrameAt || state.webrtcStartAt;
  if (ref && performance.now() - ref > 20000) {
    if (state.webrtcStallRetries < 1) {
      // 先重连一次 WebRTC（给 REMB 重新爬升的机会），不要一卡就切硬解码
      state.webrtcStallRetries++;
      state.lastFrameAt = performance.now();
      setStatus("WebRTC 无画面，重连中…", "warn");
      sendLog("webrtc stall -> reconnect");
      setupWebRTC({ forceRelay: state.forceRelay });
    } else {
      enableFallback("WebRTC 无画面，已自动切换兼容模式");
    }
  }
}, 2000);

/* ----------------------------- 上报接收状态（自适应码率）+ RTT ----------------------------- */
setInterval(() => {
  const rx = state.rxCount / 2;
  state.rxCount = 0;
  const iw = state.inputWs;
  const ws = (iw && iw.readyState === 1)
    ? iw
    : ((state.ws && state.ws.readyState === 1) ? state.ws : null);
  if (!ws) return;
  if (state.mode === "fallback" && state.fallbackCodec === "h264") {
    const q = state.decoder ? state.decoder.decodeQueueSize : 0;
    ws.send(JSON.stringify({ type: "rate", q, rx }));
  }
  // WebRTC：把浏览器侧接收统计上报给服务端（排查“发得出去、收不到”）
  if (state.mode === "webrtc" && state.pc && state.ws && state.ws.readyState === 1) {
    state.pc.getStats().then((st) => {
      let fr = 0, fd = 0, lost = 0, bytes = 0;
      st.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          fr = r.framesReceived; fd = r.framesDecoded; lost = r.packetsLost; bytes = r.bytesReceived;
        }
      });
      try { state.ws.send(JSON.stringify({ type: "rxstat", fr, fd, lost, bytes })); } catch (_) {}
    }).catch(() => {});
  }
  if (ws === iw) {
    state.inputPingSent = performance.now();
  } else {
    state.pingSent = performance.now();
  }
  const tEpoch = Date.now();
  state.pingSentEpoch = tEpoch;
  ws.send(JSON.stringify({ type: "ping", t: tEpoch }));
}, 2000);

/* ----------------------------- 状态统计 ----------------------------- */
setInterval(async () => {
  if (state.pc) tuneReceiver();
  const rx = state.rxFrames;
  const rxBytes = state.rxBytes;
  state.rxFrames = 0;
  state.rxBytes = 0;

  let text = "";
  if (state.mode === "fallback") {
    text = `兼容 · ${rx} fps · ${(rxBytes * 8 / 1000).toFixed(0)} Kbps`;
  } else if (state.pc) {
    try {
      const stats = await state.pc.getStats();
      stats.forEach((r) => {
        if (r.type === "inbound-rtp" && r.kind === "video") {
          const fps = r.framesPerSecond ? r.framesPerSecond.toFixed(0) : "?";
          const now = performance.now();
          let bitrate = 0;
          if (state.bytesTime && r.bytesReceived >= state.bytesLast) {
            bitrate = (r.bytesReceived - state.bytesLast) * 8 / ((now - state.bytesTime) / 1000);
          }
          state.bytesLast = r.bytesReceived;
          state.bytesTime = now;
          const jb = r.jitterBufferEmittedCount ? 1000 * r.jitterBufferDelay / r.jitterBufferEmittedCount : 0;
          const proc = r.framesDecoded ? 1000 * (r.totalProcessingDelay || 0) / r.framesDecoded : 0;
          state.jbProc = jb + proc;
          text = `${fps} fps · ${(bitrate / 1e6).toFixed(1)} Mbps`;
        }
      });
    } catch (_) {}
    if (!text && rx) text = `${rx} fps`;
  }
  els.stats.textContent = text;
}, 1000);

/* ----------------------------- 诊断条 ----------------------------- */
setInterval(() => {
  if (els.build) els.build.textContent = "v91";
  if (!els.diag) return;
  const age = state.lastFrameAt ? ((performance.now() - state.lastFrameAt) / 1000).toFixed(1) : "-";
  let lat = 0;
  if (state.mode === "fallback") {
    // 真实端到端（服务端采集时间戳 → 客户端显示）
    if (state.e2e != null) { lat = state.e2e; if (els.lat) els.lat.textContent = "端到端:" + lat + "ms"; }
    else if (els.lat) { els.lat.textContent = "端到端:…"; }
  } else {
    // WebRTC 无自定义时间戳，展示接收管线延迟（jb+proc）+ RTT/2
    lat = Math.round((state.jbProc || 0) + (state.rtt > 0 ? state.rtt / 2 : 0));
    if (els.lat) els.lat.textContent = "接收:" + lat + "ms";
  }
  els.diag.textContent =
    `模式:${state.mode}${state.mode === "fallback" ? "/" + state.fallbackCodec : ""} RTT:${state.rtt < 0 ? "-" : state.rtt + "ms"} 帧龄:${age}s` +
    ` 键:${state.lastKey || "-"}` +
    (state.h264Codec ? ` ${state.h264Codec}${state.hwDecode ? "(硬解)" : "(软解)"}` : "") +
    (state.mode === "fallback" && state.fallbackCodec === "h264" ? ` 解码:${state.decodeLatency}ms` : "") +
    (state.lastError ? ` ERR:${state.lastError}` : "");
}, 1500);
