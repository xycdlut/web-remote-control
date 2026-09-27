'use strict';
/* H.264 解码 + OffscreenCanvas 渲染，全部在 Worker 内完成，避免主线程抖动 */

let decoder = null;
let canvas = null;
let ctx = null;
let dispW = 0, dispH = 0, dpr = 1;
let lastW = 0, lastH = 0;
let offsetUs = 0;  // 服务端时钟 - 客户端时钟 (µs)，由主线程下发
let clockProbe = false;  // 仅测试用：从帧里采样像素时钟，生产默认关闭

function postFrame(w, h, e2e) {
  const changed = (w !== lastW || h !== lastH);
  lastW = w; lastH = h;
  self.postMessage({ type: 'frame', w, h, changed, e2e });
}

// 从解码帧的自然分辨率里，按固定坐标采样被控桌面上“像素时钟”的黑白块，解出“当日毫秒数”
function readClock(frame) {
  const fw = frame.displayWidth || frame.codedWidth, fh = frame.displayHeight || frame.codedHeight;
  if (!fw || !fh) return null;
  const DESKTOP_W = 2048, CLOCK_X = 840;
  const s = fw / DESKTOP_W, B = 40 * s, x0 = CLOCK_X * s;
  const sx = Math.max(0, Math.floor(x0 - 3)), sy = Math.max(0, Math.floor(8 * s));
  const sw = Math.ceil(30 * B + 6), sh = Math.ceil(90 * s);
  if (sx + sw > fw || sy + sh > fh) return null;
  const oc = new OffscreenCanvas(sw, sh);
  const octx = oc.getContext('2d', { willReadFrequently: true });
  octx.drawImage(frame, sx, sy, sw, sh, 0, 0, sw, sh);
  const lum = (x, y) => {
    const px = Math.round(x), py = Math.round(y);
    const d = octx.getImageData(px - 2, py - 2, 5, 5).data;
    let sum = 0; for (let i = 0; i < d.length; i += 4) sum += 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    return sum / (d.length / 4);
  };
  for (let cap = 10; cap <= 60; cap++) {
    const y = (10 + cap + 20) * s - sy;
    if (y < 3 || y > sh - 3) continue;
    const a0 = lum(x0 + 0.5*B - sx, y), a1 = lum(x0 + 1.5*B - sx, y), a2 = lum(x0 + 2.5*B - sx, y);
    if (!(a0 > 190 && a1 > 190 && a2 < 70)) continue;
    let ok = true, v = 0;
    for (let i = 0; i < 27; i++) { const l = lum(x0 + (3.5 + i)*B - sx, y); if (l > 190) v = v*2 + 1; else if (l < 70) v = v*2; else { ok = false; break; } }
    if (ok) return v;
  }
  return null;
}

function draw(frame) {
  const fw = frame.displayWidth || frame.codedWidth;
  const fh = frame.displayHeight || frame.codedHeight;
  if (canvas && ctx && dispW && dispH && fw && fh) {
    const scale = Math.min(dispW / fw, dispH / fh);
    const dw = fw * scale, dh = fh * scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(frame, (dispW - dw) / 2, (dispH - dh) / 2, dw, dh);
  }
  if (clockProbe) { try { const v = readClock(frame); if (v != null) self.postMessage({ type: 'clock', msOfDay: v, t: Date.now() }); } catch (_) {} }
  postFrame(fw, fh, Math.round((Date.now() * 1000 + offsetUs - frame.timestamp) / 1000));
}

function configure(m) {
  if (decoder) { try { decoder.close(); } catch (_) {} decoder = null; }
  decoder = new VideoDecoder({
    output: (frame) => { draw(frame); frame.close(); },
    error: (err) => self.postMessage({ type: 'error', message: err.message }),
  });
  const c = { codec: m.codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' };
  if (m.description) c.description = m.description;
  decoder.configure(c);
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'canvas':
      canvas = m.canvas;
      ctx = canvas.getContext('2d');
      break;
    case 'offset':
      offsetUs = m.us || 0;
      break;
    case 'clockprobe':
      clockProbe = !!m.on;
      break;
    case 'size':
      dispW = m.w; dispH = m.h; dpr = m.dpr || 1;
      if (canvas) {
        canvas.width = Math.max(1, Math.round(dispW * dpr));
        canvas.height = Math.max(1, Math.round(dispH * dpr));
      }
      break;
    case 'config':
      try { configure(m); } catch (err) { self.postMessage({ type: 'error', message: 'cfg:' + err.message }); }
      break;
    case 'chunk':
      if (!decoder || decoder.state !== 'configured') { self.postMessage({ type: 'needkey' }); break; }
      if (decoder.decodeQueueSize > 12) {
        try { decoder.close(); } catch (_) {}
        decoder = null; self.postMessage({ type: 'needkey' }); break;
      }
      try {
        decoder.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: m.ts, data: m.data }));
      } catch (err) { self.postMessage({ type: 'needkey' }); }
      break;
    case 'close':
      if (decoder) { try { decoder.close(); } catch (_) {} decoder = null; }
      break;
  }
};
