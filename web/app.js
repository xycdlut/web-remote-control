"use strict";

/* global RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, VideoDecoder, EncodedVideoChunk */

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
  cursorLayer: $("cursorLayer"),
  placeholder: $("placeholder"),

  status: $("status"),
  stats: $("stats"),
  diag: $("diag"),
  qualitySel: $("qualitySel"),
  localCursorChk: $("localCursorChk"),
  fallbackBtn: $("fallbackBtn"),
  keyboardBtn: $("keyboardBtn"),
  disconnectBtn: $("disconnectBtn"),
  toast: $("toast"),
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
  lastBitmap: null,
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
  decTimestamp: 0,
  h264: null,
  h264StartedAt: 0,
  h264Codec: "",
  needKey: true,
  rxCount: 0,
  rxMsgs: 0,
  rxJpeg: 0,
  rxDec: 0,
  rxOut: 0,
  rtt: -1,
  pingSent: 0,
  inputPingSent: 0,
  lastError: "",
  baseCanvas: null,
  baseCtx: null,
  baseW: 0,
  baseH: 0,
  mouseX: 0,
  mouseY: 0,
  mouseVisible: false,
  localCursor: true,
  hwDecode: false,
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
  return JSON.stringify({ type: "fallback", on: true, quality: 45, codec, w });
}

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  return proto + location.host + "/ws?token=" + encodeURIComponent(state.token);
}

/* ----------------------------- 登录 ----------------------------- */
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

  openWebSocket();
  openInputSocket();
  await setupWebRTC();
  tryFullscreenAndLock();
}

function openWebSocket() {
  const ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.onmessage = onSignalingMessage;
  ws.onopen = () => setLocalCursor(els.localCursorChk.checked, true);
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
  const ws = new WebSocket(proto + location.host + "/ws-input?token=" + encodeURIComponent(state.token));
  state.inputWs = ws;
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const m = JSON.parse(ev.data);
      if (m.type === "pong" && state.inputPingSent) {
        state.rtt = Math.round(performance.now() - state.inputPingSent);
      }
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
    setLocalCursor(els.localCursorChk.checked, true);
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
    state.rxMsgs += 1;
    if (state.fallbackCodec === "h264") {
      if (state.decoder) decodeH264(event.data);
    } else {
      renderJpeg(event.data);
    }
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
  } else if (msg.type === "ready") {
    // 服务端就绪
  } else if (msg.type === "h264") {
    setupH264(msg);
  } else if (msg.type === "pong") {
    if (state.pingSent) state.rtt = Math.round(performance.now() - state.pingSent);
  }
}

/* ----------------------------- WebRTC ----------------------------- */
async function setupWebRTC() {
  const cfg = state.config || {};
  const iceServers = (cfg.ice_servers && cfg.ice_servers.length)
    ? cfg.ice_servers
    : [{ urls: "stun:stun.l.google.com:19302" }];

  const pc = new RTCPeerConnection({ iceServers });
  state.pc = pc;
  state.webrtcStartAt = performance.now();

  pc.addTransceiver("video", { direction: "recvonly" });

  const dc = pc.createDataChannel("ctrl", { ordered: true });
  state.dc = dc;
  dc.onopen = () => {
    state.mode = "webrtc";
    els.fallbackBtn.classList.remove("active");
    setConnected(true);
  };

  pc.ontrack = (ev) => {
    if (state.mode === "fallback") return;
    els.video.srcObject = ev.streams[0];
    els.video.play().catch(() => {});
    els.video.classList.remove("hidden");
    els.canvas.classList.add("hidden");
    els.placeholder.classList.add("hidden");
    state.mode = "webrtc";
    els.fallbackBtn.classList.remove("active");
    const v = els.video;
    if (v.requestVideoFrameCallback) {
      const cb = () => {
        state.lastFrameAt = performance.now();
        if (!state.connected) setConnected(true);
        if (state.switchTimer) { clearTimeout(state.switchTimer); state.switchTimer = null; }
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") setStatus("已连接", "ok");
    else if (s === "connecting") setStatus("连接中…", "warn");
    else if (s === "failed") setStatus("直连失败", "err");
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGathering(pc, 2500);

  const send = () => {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: "offer", sdp: pc.localDescription.sdp }));
    } else {
      setTimeout(send, 200);
    }
  };
  send();

  state.switchTimer = setTimeout(() => {
    if (!state.connected) enableFallback("未能建立 P2P，已切换兼容模式");
  }, 5000);
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
  if (v && state.switchTimer) {
    clearTimeout(state.switchTimer);
    state.switchTimer = null;
  }
  if (v) {
    setStatus(state.mode === "fallback"
      ? (state.fallbackCodec === "h264" ? "兼容模式(硬解)" : "兼容模式(JPEG)")
      : "已连接", state.mode === "fallback" ? "warn" : "ok");
  }
}

/* ----------------------------- 兼容模式 ----------------------------- */
function supportsH264() {
  return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
}

function enableFallback(msg) {
  if (state.mode === "fallback") return;
  state.mode = "fallback";
  els.fallbackBtn.classList.add("active");
  state.fallbackCodec = supportsH264() ? "h264" : "jpeg";
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

function switchToJpeg() {
  state.fallbackCodec = "jpeg";
  teardownDecoder();
  if (state.ws && state.ws.readyState === 1) state.ws.send(fallbackMsg("jpeg"));
}

function teardownDecoder() {
  if (state.decoder) {
    try { state.decoder.close(); } catch (_) {}
    state.decoder = null;
  }
}

function setupH264(msg) {
  teardownDecoder();
  state.fallbackCodec = "h264";
  state.h264 = { width: msg.width, height: msg.height, fps: msg.fps || 20 };
  state.lastFrameAt = performance.now();
  state.h264StartedAt = performance.now();
  els.video.classList.add("hidden");
  els.canvas.classList.remove("hidden");
  els.placeholder.classList.add("hidden");
  if (!canvasCtx) canvasCtx = els.canvas.getContext("2d");
  state.decTimestamp = 0;

  const config = {
    codec: msg.codec || "avc1.42E01E",
    optimizeForLatency: true,
    hardwareAcceleration: "prefer-hardware",
  };
  if (msg.description) config.description = b64ToBytes(msg.description);
  state.decoderConfig = config;
  state.h264Codec = config.codec;

  if (!ensureDecoder()) {
    toast("H.264 配置失败，改用 JPEG：" + (state.lastError || ""), 5000);
    switchToJpeg();
    return;
  }
  setStatus("兼容模式(硬解)", "warn");
  probeHwDecode(config);
}

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
        state.rxOut += 1;
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
  if (!ensureDecoder()) return;
  const u8 = new Uint8Array(buffer);
  if (u8.length < 2) return;
  const isKey = u8[0] === 1;

  if (state.decoder.decodeQueueSize > 12) {
    try { state.decoder.close(); } catch (_) {}
    state.decoder = null;
    ensureDecoder();
    state.needKey = true;
  }
  if (state.needKey && !isKey) return;
  if (isKey) state.needKey = false;

  const data = u8.subarray(1);
  const ts = state.decTimestamp;
  state.decTimestamp += Math.round(1e6 / (state.h264 ? state.h264.fps : 20));
  try {
    state.decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: ts, data }));
    state.rxFrames += 1;
    state.rxCount += 1;
    state.rxDec += 1;
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
    ensureBase(fw, fh);
    state.baseCtx.drawImage(frame, 0, 0, fw, fh);
    renderComposite();
    state.lastError = "";
  } catch (e) {
    state.lastError = "draw:" + e.message;
  }
}

function disableFallback() {
  state.mode = "webrtc";
  els.fallbackBtn.classList.remove("active");
  teardownDecoder();
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type: "fallback", on: false }));
  els.canvas.classList.add("hidden");
  els.video.classList.remove("hidden");
  state.lastBitmap = null;
}

/* ----------------------------- JPEG 渲染 ----------------------------- */
let canvasCtx = null;

async function renderJpeg(buffer) {
  els.video.classList.add("hidden");
  els.canvas.classList.remove("hidden");
  els.placeholder.classList.add("hidden");
  state.lastFrameAt = performance.now();
  state.rxFrames += 1;
  state.rxJpeg += 1;
  state.rxBytes += (buffer.byteLength || buffer.length || 0);
  try {
    const blob = new Blob([buffer], { type: "image/jpeg" });
    const bmp = await createImageBitmap(blob);
    state.lastBitmap = bmp;
    ensureBase(bmp.width, bmp.height);
    state.baseCtx.drawImage(bmp, 0, 0);
    renderComposite();
    state.lastError = "";
  } catch (e) {
    state.lastError = "jpeg:" + e.message;
  }
}

/* ----------------------------- 本地光标（画在主画布上，保证可见） ----------------------------- */
const CURSOR_SHAPE = [[0, 0], [0, 19], [4, 15], [7, 22], [11, 20], [8, 13], [14, 13]];

function ensureBase(w, h) {
  if (!state.baseCanvas) {
    state.baseCanvas = document.createElement("canvas");
    state.baseCtx = null;
  }
  if (state.baseCanvas.width !== w || state.baseCanvas.height !== h) {
    state.baseCanvas.width = w;
    state.baseCanvas.height = h;
    state.baseCtx = null;
  }
  if (!state.baseCtx) state.baseCtx = state.baseCanvas.getContext("2d");
  state.baseW = w;
  state.baseH = h;
}

function drawArrow(ctx, x, y) {
  ctx.beginPath();
  CURSOR_SHAPE.forEach((p, i) => (i ? ctx.lineTo(x + p[0], y + p[1]) : ctx.moveTo(x + p[0], y + p[1])));
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
}

function renderComposite() {
  const canvas = els.canvas;
  if (!state.baseCanvas || !state.baseW) return;
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
  const scale = Math.min(w / state.baseW, h / state.baseH);
  const dw = state.baseW * scale, dh = state.baseH * scale;
  const dx = (w - dw) / 2, dy = (h - dh) / 2;
  ctx.drawImage(state.baseCanvas, dx, dy, dw, dh);
  if (state.localCursor && state.mouseVisible) {
    const r = canvas.getBoundingClientRect();
    drawArrow(ctx, state.mouseX - r.left, state.mouseY - r.top);
  }
}

function setLocalCursor(on, notify = false) {
  state.localCursor = !!on;
  if (notify && state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: "cursor", on: !state.localCursor }));
  }
  if (state.mode === "fallback") renderComposite();
}

/* ----------------------------- 输入映射 ----------------------------- */
function activeMedia() {
  return state.mode === "fallback" ? els.canvas : els.video;
}

function intrinsicSize() {
  if (state.mode === "fallback") {
    if (state.baseW) return { w: state.baseW, h: state.baseH };
    const b = state.lastBitmap;
    return b ? { w: b.width, h: b.height } : null;
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

function normalized(e) {
  const r = contentRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.x) / r.w)),
    y: Math.min(1, Math.max(0, (e.clientY - r.y) / r.h)),
  };
}

els.stage.addEventListener("mousemove", (e) => {
  state.mouseX = e.clientX;
  state.mouseY = e.clientY;
  state.mouseVisible = true;
  if (state.mode === "fallback") renderComposite();
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

els.stage.addEventListener("mouseleave", () => {
  state.mouseVisible = false;
  if (state.mode === "fallback") renderComposite();
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

window.addEventListener("keydown", (e) => {
  if (!state.connected || isTyping(e.target)) return;
  if (e.metaKey && !e.ctrlKey) return;
  sendInput({ t: "k", c: e.code, k: e.key.length === 1 ? e.key : undefined, d: 1 });
  e.preventDefault();
}, true);

window.addEventListener("keyup", (e) => {
  if (!state.connected || isTyping(e.target)) return;
  sendInput({ t: "k", c: e.code, k: e.key.length === 1 ? e.key : undefined, d: 0 });
  e.preventDefault();
}, true);

/* ----------------------------- 全屏 / 键盘锁定 ----------------------------- */
async function tryFullscreenAndLock() {
  try {
    if (!document.fullscreenElement && els.viewer.requestFullscreen) {
      await els.viewer.requestFullscreen();
    }
  } catch (_) {}
  try {
    if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock();
  } catch (_) {}
}

els.keyboardBtn.addEventListener("click", tryFullscreenAndLock);

/* ----------------------------- 兼容模式按钮：切换 H.264/JPEG ----------------------------- */
els.fallbackBtn.addEventListener("click", () => {
  if (state.mode !== "fallback") {
    enableFallback("已开启兼容模式");
    return;
  }
  if (state.fallbackCodec === "h264") {
    toast("切换到 JPEG 模式");
    switchToJpeg();
  } else {
    toast("切换到 H.264 硬解");
    state.fallbackCodec = "h264";
    teardownDecoder();
    state.needKey = true;
    if (state.ws && state.ws.readyState === 1) state.ws.send(fallbackMsg("h264"));
  }
});

/* ----------------------------- 画质档位 ----------------------------- */
els.qualitySel.addEventListener("change", () => {
  if (state.mode === "fallback" && state.ws && state.ws.readyState === 1) {
    state.ws.send(fallbackMsg(state.fallbackCodec));
    toast("已切换画质档位");
  }
});

/* ----------------------------- 本地光标开关 ----------------------------- */
els.localCursorChk.addEventListener("change", () => {
  setLocalCursor(els.localCursorChk.checked, true);
  toast(els.localCursorChk.checked ? "已启用本地即时光标" : "已切回被控机真实光标");
});

els.disconnectBtn.addEventListener("click", () => location.reload());

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
  if (ref && performance.now() - ref > 6000) {
    enableFallback("WebRTC 无画面，已自动切换兼容模式");
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
  if (ws === iw) {
    state.inputPingSent = performance.now();
  } else {
    state.pingSent = performance.now();
  }
  ws.send(JSON.stringify({ type: "ping" }));
}, 2000);

/* ----------------------------- 状态统计 ----------------------------- */
setInterval(async () => {
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
  if (!els.diag) return;
  const age = state.lastFrameAt ? ((performance.now() - state.lastFrameAt) / 1000).toFixed(1) : "-";
  els.diag.textContent =
    `模式:${state.mode}/${state.fallbackCodec} 帧龄:${age}s 收:${state.rxMsgs} J:${state.rxJpeg} 提交:${state.rxDec} 出:${state.rxOut}` +
    ` ws:${state.ws ? state.ws.readyState : "-"} in:${state.inputWs ? state.inputWs.readyState : "-"}` +
    ` RTT:${state.rtt < 0 ? "-" : state.rtt + "ms"}` +
    (state.h264Codec ? ` ${state.h264Codec}${state.hwDecode ? "(硬解)" : "(软解)"}` : "") +
    (state.lastError ? ` ERR:${state.lastError}` : "");
}, 1500);
