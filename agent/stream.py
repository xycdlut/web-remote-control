"""WebRTC 视频轨：从 ScreenCapture 拉取 BGRA 帧交给 NVENC 编码。"""
import asyncio
import fractions
import logging

from av import VideoFrame
from aiortc import MediaStreamTrack

logger = logging.getLogger(__name__)


class ScreenStreamTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, capture):
        super().__init__()
        self.capture = capture
        self.fps = capture.fps
        self.time_base = fractions.Fraction(1, self.fps)
        self.counter = 0
        self._loop = asyncio.get_event_loop()

    async def recv(self):
        while True:
            frame = await self._loop.run_in_executor(None, self.capture.get_frame)
            if frame is not None:
                break
            await asyncio.sleep(1.0 / self.fps)

        h, w = frame.shape[:2]
        if (w, h) != (self.capture.width, self.capture.height):
            self.capture.width, self.capture.height = w, h

        video = VideoFrame.from_ndarray(frame, format="bgra")
        video.pts = self.counter
        video.time_base = self.time_base
        self.counter += 1
        return video
