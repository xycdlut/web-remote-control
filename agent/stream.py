"""WebRTC 视频轨：从 ScreenCapture 拉取 BGRA 帧交给 NVENC 编码。
支持运行时上限（params: max_w/max_h/fps），用于中继模式降分辨率/帧率，降低解码压力。"""
import asyncio
import fractions
import logging

import cv2

from av import VideoFrame
from aiortc import MediaStreamTrack

logger = logging.getLogger(__name__)


class ScreenStreamTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, capture, params=None):
        super().__init__()
        self.capture = capture
        self.params = params if params is not None else {}  # {"max_w","max_h","fps"}
        self.time_base = fractions.Fraction(1, capture.fps)
        self.counter = 0
        self._i = 0
        self._loop = asyncio.get_event_loop()

    async def recv(self):
        cap_fps = max(1, int(self.capture.fps))
        fps_cap = int(self.params.get("fps") or 0)
        # 帧率上限：按比例丢弃采集帧（例如 60 -> 30 丢弃一半）
        drop = (cap_fps // fps_cap) if (fps_cap and cap_fps > fps_cap) else 1
        while True:
            frame = await self._loop.run_in_executor(None, self.capture.get_frame)
            if frame is not None:
                break
            await asyncio.sleep(1.0 / cap_fps)

        if drop > 1:
            self._i = (self._i + 1) % drop
            if self._i != 0:
                # 丢弃该帧，继续取下一帧（仍保持采集节奏）
                return await self.recv()

        max_w = int(self.params.get("max_w") or 0)
        max_h = int(self.params.get("max_h") or 0)
        h, w = frame.shape[:2]
        if max_w and w > max_w:
            nw = max_w
            nh = max(2, int(round(h * nw / w)))
            nh -= nh % 2
            frame = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)

        video = VideoFrame.from_ndarray(frame, format="bgra")
        video.pts = self.counter
        video.time_base = fractions.Fraction(1, fps_cap or cap_fps)
        self.counter += 1
        return video
