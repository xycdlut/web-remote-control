"""修补 aioice TURN 客户端的一个缺陷（中继模式“连一会就崩”的根因）。

现象：CHANNEL_BIND 收到 coturn 的 `403 - Forbidden IP` 后，aioice 在
`TurnClientMixin.send_data()` 里留下的 `peer_connect_waiters[addr]` 不会被清理，
于是**后续对同一 peer 的 send_data 会永久 `await waiter`**（turn.py 的 `await waiter`），
中继媒体发送被卡死 → WebRTC 无画面 → 客户端看门狗切到兼容模式。

本补丁替换 `send_data`：
  - 等待 channel 绑定带超时，绝不再永久阻塞；
  - ChannelBind 失败时打印 peer 地址、释放等待者并清理状态；
  - 回退用 TURN `Send` 指示（不依赖 channel）尽力把该包发出去。
"""
import asyncio
import ctypes
import logging
import os
import struct
import time
from ctypes import wintypes

from aioice import stun, turn

logger = logging.getLogger("agent.turnpatch")

_installed = False

SIO_UDP_CONNRESET = 0x9800000C


def _disable_udp_connreset(sock) -> None:
    """Windows：关闭 UDP socket 的 SIO_UDP_CONNRESET，避免收到 ICMP 端口不可达后
    后续 sendto 抛 WSAECONNRESET、进而被 asyncio 判为致命错误而拆连接。"""
    if os.name != "nt":
        return
    try:
        ws2 = ctypes.WinDLL("ws2_32")
        ws2.WSAIoctl.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
            ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
            ctypes.c_void_p, ctypes.c_void_p,
        ]
        ws2.WSAIoctl.restype = ctypes.c_int
        inbuf = ctypes.c_int(0)          # BOOL FALSE
        ret = wintypes.DWORD(0)
        ws2.WSAIoctl(wintypes.HANDLE(sock.fileno()), SIO_UDP_CONNRESET,
                     ctypes.byref(inbuf), ctypes.sizeof(inbuf),
                     None, 0, ctypes.byref(ret), None, None)
    except Exception:
        pass


def install_udp_connreset() -> None:
    """给之后创建的所有 IPv4/IPv6 UDP socket 打上 SIO_UDP_CONNRESET=off。"""
    if os.name != "nt":
        return
    import socket
    if getattr(socket.socket, "_rc_connreset_off", False):
        return
    orig_init = socket.socket.__init__

    def _init(self, *args, **kwargs):
        orig_init(self, *args, **kwargs)
        try:
            if self.family in (socket.AF_INET, socket.AF_INET6) and self.type == socket.SOCK_DGRAM:
                _disable_udp_connreset(self)
        except Exception:
            pass

    socket.socket.__init__ = _init
    socket.socket._rc_connreset_off = True
    logger.info("已对 UDP socket 关闭 SIO_UDP_CONNRESET（Windows 防 sendto 致命错误）")


def _ensure_data_attribute():
    """aioice 的 STUN 属性表里没有 DATA(0x0013)，补上（Send 指示需要）。"""
    if "DATA" in stun.ATTRIBUTES_BY_NAME:
        return
    entry = (0x0013, "DATA", stun.pack_bytes, stun.unpack_bytes)
    stun.ATTRIBUTES_BY_NAME["DATA"] = entry
    stun.ATTRIBUTES_BY_TYPE[0x0013] = entry


async def _send_data(self, data: bytes, addr) -> None:
    # 若该 peer 正在绑定 channel，等它（带超时，避免永久阻塞）
    if addr in self.peer_connect_waiters:
        loop = asyncio.get_event_loop()
        waiter = loop.create_future()
        self.peer_connect_waiters[addr].append(waiter)
        try:
            await asyncio.wait_for(asyncio.shield(waiter), timeout=3.0)
        except Exception:
            pass

    channel = self.peer_to_channel.get(addr)
    now = time.time()
    if channel is None:
        self.peer_connect_waiters[addr] = []
        channel = self.channel_number
        self.channel_number += 1
        try:
            await self.channel_bind(channel, addr)
        except Exception as e:
            logger.warning("TURN ChannelBind 失败，peer=%s：%s（回退 Send 指示）", addr, e)
            for w in self.peer_connect_waiters.pop(addr, []):
                if not w.done():
                    w.set_result(None)
            try:
                ind = stun.Message(
                    message_method=stun.Method.SEND,
                    message_class=stun.Class.INDICATION,
                )
                ind.attributes["XOR-PEER-ADDRESS"] = addr
                ind.attributes["DATA"] = data
                self.send_stun(ind)
            except Exception as e2:
                logger.debug("TURN Send 指示失败 peer=%s：%s", addr, e2)
            return
        self.channel_refresh_at[channel] = now + self.channel_refresh_time
        self.channel_to_peer[channel] = addr
        self.peer_to_channel[addr] = channel
        for w in self.peer_connect_waiters.pop(addr, []):
            if not w.done():
                w.set_result(None)
    elif now > self.channel_refresh_at[channel]:
        try:
            await self.channel_bind(channel, addr)
            self.channel_refresh_at[channel] = now + self.channel_refresh_time
        except Exception as e:
            logger.warning("TURN ChannelBind 刷新失败，peer=%s：%s", addr, e)

    header = struct.pack("!HH", channel, len(data))
    self._send(header + data)


def install() -> None:
    global _installed
    if _installed:
        return
    _installed = True
    _ensure_data_attribute()
    install_udp_connreset()
    turn.TurnClientMixin.send_data = _send_data
    logger.info("aioice TURN send_data 补丁已安装（ChannelBind 失败不再阻塞发送）")
