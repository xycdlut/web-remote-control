"""本地 Web 服务：静态页面 + 登录 + WebSocket 信令 + WebRTC + H.264 硬解码兜底。"""
import asyncio
import base64
import json
import logging
import re
import socket
import struct
import time

import cv2
from aiohttp import WSMsgType, web

from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)

import auth
import config as config_mod
import encoder as encoder_mod
from stream import ScreenStreamTrack

logger = logging.getLogger("agent.server")

WEB_DIR = None  # 由 main 设置

# 客户端上报的接收状态（用于服务端自适应码率）
CLIENT_RATE = {"q": 0, "rx": 0.0, "t": 0.0}

_START_RE = re.compile(rb"\x00\x00\x00?\x01")


def _annexb_nals(data: bytes):
    """按起始码切分 Annex-B 为 NAL 单元列表。"""
    ms = list(_START_RE.finditer(data))
    nals = []
    for i, m in enumerate(ms):
        s = m.end()
        e = ms[i + 1].start() if i + 1 < len(ms) else len(data)
        if e > s:
            nals.append(data[s:e])
    return nals


def _avcc(nals):
    """NAL 列表 -> AVCC（4 字节长度前缀）。"""
    return b"".join(len(n).to_bytes(4, "big") + n for n in nals)


def _avcc_description(nals):
    """从 SPS/PPS 构造 avcC（WebCodecs 的 description）。"""
    sps = pps = None
    for n in nals:
        t = n[0] & 0x1F
        if t == 7 and sps is None:
            sps = n
        elif t == 8 and pps is None:
            pps = n
    if not sps or not pps:
        return None
    return (bytes([1, sps[1], sps[2], sps[3], 0xFF, 0xE1])
            + len(sps).to_bytes(2, "big") + sps
            + bytes([1]) + len(pps).to_bytes(2, "big") + pps)


def _codec_string(nals):
    for n in nals:
        if (n[0] & 0x1F) == 7:
            return "avc1.%02X%02X%02X" % (n[1], n[2], n[3])
    return "avc1.42E01E"


def _set_nodelay(request):
    """关闭 Nagle，降低交互延迟。"""
    try:
        sock = request.transport.get_extra_info("socket")
        if sock is not None:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except Exception:
        pass


class ClientSession:
    def __init__(self, ws, cfg, capture, injector):
        self.ws = ws
        self.cfg = cfg
        self.capture = capture
        self.injector = injector
        self.pc = None
        self.track = None
        self._fallback_task = None
        self._fallback_gen = 0
        self._fallback_width = 1024
        self._closed = False

    # ---------- 信令 ----------
    async def handle(self):
        async for msg in self.ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                await self._on_message(data)
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
                break
        await self.close()

    async def _on_message(self, data):
        mtype = data.get("type")
        if mtype == "offer":
            await self._handle_offer(data.get("sdp", ""))
        elif mtype == "candidate":
            cand = data.get("candidate")
            if self.pc is not None and cand:
                from aiortc import RTCIceCandidate
                try:
                    await self.pc.addIceCandidate(RTCIceCandidate(
                        candidate=cand.get("candidate", ""),
                        sdpMid=cand.get("sdpMid"),
                        sdpMLineIndex=cand.get("sdpMLineIndex"),
                    ))
                except Exception as e:
                    logger.debug("addIceCandidate failed: %s", e)
        elif mtype == "input":
            self._inject(data.get("ev") or {})
        elif mtype == "rate":
            CLIENT_RATE["q"] = int(data.get("q", 0))
            CLIENT_RATE["rx"] = float(data.get("rx", 0))
            CLIENT_RATE["t"] = time.time()
        elif mtype == "fallback":
            if data.get("on"):
                self._start_fallback(data.get("w", 1024))
            else:
                self._stop_fallback()
        elif mtype == "ping":
            await self._send_json({"type": "pong", "t": data.get("t"), "s": int(time.time() * 1000)})
        elif mtype == "bitrate":
            try:
                encoder_mod.set_target_bitrate(int(data.get("bps", 0)), data.get("max"))
                logger.info("target bitrate -> %s bps (max %s)", data.get("bps"), data.get("max"))
            except Exception as e:
                logger.warning("set bitrate failed: %s", e)

    async def _handle_offer(self, sdp):
        ice_servers = []
        for s in self.cfg.get("ice_servers", []):
            ice_servers.append(RTCIceServer(
                urls=s.get("urls"),
                username=s.get("username"),
                credential=s.get("credential"),
            ))
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))
        self.track = ScreenStreamTrack(self.capture)
        self.pc.addTrack(self.track)
        try:
            encoder_mod.apply_codec_preference(self.pc.getTransceivers()[-1])
        except Exception as e:
            logger.warning("无法设置 H264 优先: %s", e)

        @self.pc.on("datachannel")
        def on_datachannel(channel):
            @channel.on("message")
            def on_message(message):
                if isinstance(message, str):
                    try:
                        self._inject(json.loads(message))
                    except ValueError:
                        pass

        @self.pc.on("connectionstatechange")
        async def on_state():
            st = self.pc.connectionState if self.pc else "closed"
            logger.info("WebRTC connection state: %s", st)
            if st in ("failed", "closed"):
                await self._close_pc()

        @self.pc.on("icecandidate")
        async def on_icecandidate(candidate):
            """把本地候选（含 TURN relay）逐条发给浏览器，否则后收集的中继候选会漏掉。"""
            if candidate is None:
                return
            try:
                await self._send_json({"type": "candidate", "candidate": {
                    "candidate": candidate.candidate,
                    "sdpMid": candidate.sdpMid,
                    "sdpMLineIndex": candidate.sdpMLineIndex,
                }})
            except Exception:
                pass

        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type="offer"))
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)
        await self._send_json({"type": "answer", "sdp": self.pc.localDescription.sdp})

    # ---------- 兜底 ----------
    def _start_fallback(self, width=1024):
        self._fallback_width = max(640, min(int(width), 1920))
        self._fallback_gen += 1
        CLIENT_RATE.update({"q": 0, "rx": 0.0, "t": 0.0})
        # 切到兜底后关闭 WebRTC，避免它的视频轨继续抢占采集帧
        if self.pc is not None:
            asyncio.ensure_future(self._close_pc())
        if self._fallback_task and not self._fallback_task.done():
            self._fallback_task.cancel()
        self._fallback_task = asyncio.ensure_future(self._h264_loop())
        logger.info("fallback started w=%s", self._fallback_width)

    def _stop_fallback(self):
        self._fallback_gen += 1
        if self._fallback_task and not self._fallback_task.done():
            self._fallback_task.cancel()
        self._fallback_task = None

    def _ws_backlog(self):
        try:
            return self.ws._writer.transport.get_write_buffer_size()
        except Exception:
            return 0

    async def _h264_loop(self):
        gen = self._fallback_gen
        fps = min(int(self.capture.fps), 30)
        src_w = self.capture.width or 1920
        src_h = self.capture.height or 1080
        w = min(self._fallback_width, src_w)
        h = int(round(w * src_h / src_w))
        h -= h % 2
        bitrate = int(max(800_000, min(w * h * fps * 0.05, 6_000_000)))
        enc = encoder_mod.AnnexBEncoder(w, h, fps=fps, bitrate=bitrate)
        period = 1.0 / max(1, fps)
        loop = asyncio.get_event_loop()
        sent = dropped = nbytes = 0
        cap_ms = enc_ms = 0.0
        stat_at = time.time()
        key_at = 0.0
        header_sent = False
        try:
            while not self._closed and self._fallback_gen == gen:
                t0 = time.perf_counter()
                _tc = time.perf_counter()
                frame = await loop.run_in_executor(None, self.capture.get_frame)
                cap_us = int(time.time() * 1_000_000)
                cap_ms += (time.perf_counter() - _tc) * 1000.0
                if frame is None:
                    await asyncio.sleep(period)
                    continue
                if time.time() - key_at > 2.0:
                    enc.force_keyframe()
                    key_at = time.time()
                _te = time.perf_counter()
                data, _flag = await loop.run_in_executor(None, self._encode_h264, enc, frame, w, h)
                enc_ms += (time.perf_counter() - _te) * 1000.0
                nals = _annexb_nals(data) if data else []
                if not nals:
                    await asyncio.sleep(period)
                    continue
                is_key = any((n[0] & 0x1F) == 5 for n in nals)

                if not header_sent:
                    desc = _avcc_description(nals)
                    if desc is None:
                        await asyncio.sleep(period)
                        continue
                    codec_str = _codec_string(nals)
                    await self._send_json({
                        "type": "h264", "width": w, "height": h, "fps": fps,
                        "codec": codec_str,
                        "description": base64.b64encode(desc).decode("ascii"),
                    })
                    header_sent = True
                    logger.info("h264 stream %dx%d @%d codec=%s", w, h, fps, codec_str)

                avcc = _avcc(nals)
                if avcc and self._ws_backlog() < 64 * 1024:
                    payload = (b"\x01" if is_key else b"\x00") + struct.pack(">Q", cap_us) + avcc
                    try:
                        await self.ws.send_bytes(payload)
                        sent += 1
                        nbytes += len(payload)
                    except (ConnectionError, RuntimeError):
                        break
                else:
                    dropped += 1
                now = time.time()
                if now - stat_at >= 3.0:
                    n = max(1, sent + dropped)
                    logger.info("h264: sent %.1ffps %.2fMbps drop %d | cap %.1fms enc %.1fms rate %.2fMbps q=%d rx=%.1f",
                                sent / (now - stat_at), nbytes * 8 / (now - stat_at) / 1e6, dropped,
                                cap_ms / n, enc_ms / n, enc.bitrate / 1e6, CLIENT_RATE["q"], CLIENT_RATE["rx"])
                    cap_ms = enc_ms = 0.0
                    if now - CLIENT_RATE["t"] < 6:
                        if CLIENT_RATE["q"] > 4 or CLIENT_RATE["rx"] < fps * 0.6:
                            enc.set_bitrate(enc.bitrate * 0.7)
                        elif CLIENT_RATE["q"] <= 1 and CLIENT_RATE["rx"] >= fps * 0.95:
                            enc.set_bitrate(enc.bitrate * 1.12)
                    sent = dropped = nbytes = 0
                    stat_at = now
                dt = time.perf_counter() - t0
                if dt < period:
                    await asyncio.sleep(period - dt)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning("h264 loop stopped: %s", e)

    def _encode_h264(self, enc, frame, w, h):
        f = frame
        if frame.shape[1] != w or frame.shape[0] != h:
            f = cv2.resize(frame, (w, h), interpolation=cv2.INTER_LINEAR)
        return enc.encode(f)

    # ---------- 输入 ----------
    def _inject(self, ev):
        try:
            self.injector.dispatch(ev)
            if ev.get("t") != "m":
                logger.info("input %r", ev)
        except Exception as e:
            logger.warning("inject failed: %s ev=%r", e, ev)

    async def _send_json(self, obj):
        try:
            await self.ws.send_json(obj)
        except (ConnectionError, RuntimeError):
            pass

    # ---------- 清理 ----------
    async def _close_pc(self):
        pc, self.pc = self.pc, None
        self.track = None
        if pc is not None:
            try:
                await pc.close()
            except Exception:
                pass
            logger.info("WebRTC peer connection closed")

    async def close(self):
        if self._closed:
            return
        self._closed = True
        self._stop_fallback()
        await self._close_pc()
        state.current = None


class AppState:
    current = None


state = AppState()


def _client_ip(request):
    hdr = request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For")
    if hdr:
        return hdr.split(",")[0].strip()
    return request.remote or "?"


def capture_monitors_safe():
    from capture import list_monitors
    return list_monitors()


def _public_config(cfg, capture):
    return {
        "width": capture.width,
        "height": capture.height,
        "monitor": capture.monitor,
        "monitors": capture_monitors_safe(),
        "fps": cfg.get("fps", 30),
        "backend": capture.backend,
        "encoder": "h264_nvenc",
        "ice_servers": cfg.get("ice_servers", []),
    }


def create_app(cfg, capture, injector):
    throttle = auth.LoginThrottle()

    @web.middleware
    async def no_cache(request, handler):
        response = await handler(request)
        if request.path == "/" or request.path.endswith((".js", ".css", ".html")):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    app = web.Application(middlewares=[no_cache], client_max_size=1024 * 1024)

    async def index(request):
        return web.FileResponse(str(WEB_DIR / "index.html"))

    async def login(request):
        ip = _client_ip(request)
        wait = throttle.retry_after(ip)
        if wait > 0:
            return web.json_response(
                {"ok": False, "error": "尝试过于频繁，请 {:.0f} 秒后再试".format(wait)},
                status=429,
            )
        try:
            body = await request.json()
        except ValueError:
            body = {}
        password = body.get("password", "")
        if config_mod.verify_password(password, cfg["password_hash"]):
            throttle.register_success(ip)
            token = auth.create_token(cfg["token_secret"], cfg.get("session_ttl", 43200))
            logger.info("登录成功 %s", ip)
            return web.json_response({"ok": True, "token": token, "config": _public_config(cfg, capture)})
        throttle.register_failure(ip)
        logger.warning("登录失败 %s", ip)
        return web.json_response({"ok": False, "error": "密码错误"}, status=401)

    async def ws_handler(request):
        token = request.query.get("token", "")
        payload = auth.verify_token(cfg["token_secret"], token)
        if payload is None:
            return web.Response(status=401, text="unauthorized")

        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=8 * 1024 * 1024)
        await ws.prepare(request)
        _set_nodelay(request)

        old = state.current
        if old is not None:
            try:
                await old.close()
            except Exception:
                pass

        session = ClientSession(ws, cfg, capture, injector)
        state.current = session
        capture._cursor_overlay = True  # 每会话默认叠加服务端光标，客户端可请求关闭
        await session._send_json({"type": "ready", "config": _public_config(cfg, capture)})
        try:
            await session.handle()
        finally:
            await session.close()
        return ws

    async def ws_input_handler(request):
        """独立的输入通道：与视频流分开，避免大帧队头阻塞导致的输入延迟。"""
        token = request.query.get("token", "")
        if auth.verify_token(cfg["token_secret"], token) is None:
            return web.Response(status=401, text="unauthorized")
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        _set_nodelay(request)
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                t = data.get("type")
                if t == "input":
                    try:
                        injector.dispatch(data.get("ev") or {})
                    except Exception as e:
                        logger.debug("inject failed: %s", e)
                elif t == "ping":
                    await ws.send_json({"type": "pong", "s": int(time.time() * 1000)})
                elif t == "rate":
                    CLIENT_RATE["q"] = int(data.get("q", 0))
                    CLIENT_RATE["rx"] = float(data.get("rx", 0))
                    CLIENT_RATE["t"] = time.time()
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
                break
        return ws

    app.router.add_get("/", index)
    app.router.add_post("/api/login", login)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/ws-input", ws_input_handler)
    if WEB_DIR is not None:
        app.router.add_static("/", str(WEB_DIR), show_index=False)
    return app
