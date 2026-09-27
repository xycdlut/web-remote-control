"""H.264 编码：NVENC 硬编，两套入口
  - NvencH264Encoder : 替换 aiortc 默认 libx264，用于 WebRTC 视频轨
  - AnnexBEncoder    : 输出 Annex-B 码流，用于 WebSocket + 浏览器 WebCodecs 播放
"""
import fractions
import logging

import av

from aiortc.codecs.h264 import H264Encoder

logger = logging.getLogger(__name__)

SETTINGS = {"fps": 30, "bitrate": 8_000_000, "max_bitrate": 50_000_000}


def configure(fps: int = None, bitrate: int = None):
    if fps:
        SETTINGS["fps"] = int(fps)
    if bitrate:
        SETTINGS["bitrate"] = int(bitrate)


def _new_codec(frame, name, fps, bitrate, width=None, height=None):
    codec = av.CodecContext.create(name, "w")
    codec.width = width or frame.width
    codec.height = height or frame.height
    codec.bit_rate = int(bitrate)
    codec.pix_fmt = "yuv420p"
    codec.framerate = fractions.Fraction(fps, 1)
    codec.time_base = fractions.Fraction(1, fps)
    codec.max_b_frames = 0
    if name == "h264_nvenc":
        codec.options = {"preset": "p1", "tune": "ull", "rc": "cbr",
                         "zerolatency": "1", "delay": "0", "bf": "0",
                         "g": str(max(1, fps * 4))}
    else:
        codec.options = {"tune": "zerolatency", "preset": "ultrafast",
                         "g": str(max(1, fps * 4))}
    return codec


_logged_once = False


class NvencH264Encoder(H264Encoder):
    """替换 aiortc 的 libx264，走 NVENC。"""

    def __init__(self, fps: int = None, bitrate: int = None):
        global _logged_once
        super().__init__()
        self.fps = int(fps or SETTINGS["fps"])
        self._target_bitrate = int(bitrate or SETTINGS["bitrate"])
        self._max_bitrate = int(SETTINGS.get("max_bitrate", 50_000_000))
        self._codec_name = "h264_nvenc"
        self.codec = None
        if not _logged_once:
            _logged_once = True
            logger.info("NvencH264Encoder active (fps=%s bitrate=%s)", self.fps, self._target_bitrate)

    @property
    def target_bitrate(self) -> int:
        return self._target_bitrate

    @target_bitrate.setter
    def target_bitrate(self, value: int) -> None:
        # REMB from the browser can ramp this up; never exceed the configured cap.
        self._target_bitrate = max(300_000, min(int(value), self._max_bitrate))

    def _encode_frame(self, frame, force_keyframe):
        if self.codec is not None and (
            frame.width != self.codec.width
            or frame.height != self.codec.height
            or abs(self._target_bitrate - self.codec.bit_rate) / max(1, self.codec.bit_rate) > 0.4
        ):
            self.codec = None

        if force_keyframe:
            frame.pict_type = av.video.frame.PictureType.I
        else:
            frame.pict_type = av.video.frame.PictureType.NONE

        if self.codec is None:
            self.codec = _new_codec(frame, self._codec_name, self.fps, self._target_bitrate)

        try:
            data = b""
            for packet in self.codec.encode(frame):
                data += bytes(packet)
        except av.FFmpegError as e:
            if self._codec_name == "h264_nvenc":
                logger.warning("NVENC 编码失败，回退 libx264: %s", e)
                self._codec_name = "libx264"
                self.codec = _new_codec(frame, self._codec_name, self.fps, self._target_bitrate)
                data = b""
                for packet in self.codec.encode(frame):
                    data += bytes(packet)
            else:
                raise

        if data:
            yield from self._split_bitstream(data)


class AnnexBEncoder:
    """BGRA 帧 -> Annex-B H.264，用于 WS + WebCodecs。"""

    def __init__(self, width, height, fps=30, bitrate=2_500_000):
        self.width = int(width)
        self.height = int(height)
        self.fps = int(fps)
        self.bitrate = int(bitrate)
        self.pts = 0
        self._force = True
        self._codec_name = "h264_nvenc"
        self.codec = None
        self._build()

    def _build(self):
        c = av.CodecContext.create(self._codec_name, "w")
        c.width = self.width
        c.height = self.height
        c.pix_fmt = "yuv420p"
        c.bit_rate = self.bitrate
        c.framerate = fractions.Fraction(self.fps, 1)
        c.time_base = fractions.Fraction(1, self.fps)
        c.max_b_frames = 0
        if self._codec_name == "h264_nvenc":
            c.options = {"preset": "p1", "tune": "ull", "rc": "cbr", "zerolatency": "1",
                         "delay": "0", "bf": "0",
                         "g": str(max(1, self.fps * 2))}
        else:
            c.options = {"tune": "zerolatency", "preset": "ultrafast",
                         "g": str(max(1, self.fps * 2))}
        self.codec = c

    def force_keyframe(self):
        self._force = True

    def set_bitrate(self, bitrate):
        bitrate = max(500_000, min(int(bitrate), 12_000_000))
        if abs(bitrate - self.bitrate) < self.bitrate * 0.1:
            return
        self.bitrate = bitrate
        try:
            self._build()
            self._force = True
        except Exception as e:
            logger.warning("重建编码器失败: %s", e)

    def encode(self, frame_bgra):
        """返回 (bytes, is_keyframe)"""
        vf = av.VideoFrame.from_ndarray(frame_bgra, format="bgra")
        vf.pts = self.pts
        vf.time_base = fractions.Fraction(1, self.fps)
        self.pts += 1
        if self._force:
            vf.pict_type = av.video.frame.PictureType.I
            is_key = True
            self._force = False
        else:
            vf.pict_type = av.video.frame.PictureType.NONE
            is_key = False
        try:
            buf = b""
            for pkt in self.codec.encode(vf):
                buf += bytes(pkt)
            return buf, is_key
        except av.FFmpegError:
            if self._codec_name == "h264_nvenc":
                logger.warning("NVENC 失败，改用 libx264")
                self._codec_name = "libx264"
                self._build()
                vf2 = av.VideoFrame.from_ndarray(frame_bgra, format="bgra")
                vf2.pts = vf.pts
                vf2.time_base = vf.time_base
                vf2.pict_type = av.video.frame.PictureType.I if is_key else av.video.frame.PictureType.NONE
                buf = b""
                for pkt in self.codec.encode(vf2):
                    buf += bytes(pkt)
                return buf, is_key
            raise


_original_get_encoder = None
_last_encoder = None


def _patched_get_encoder(codec):
    global _last_encoder
    if codec.mimeType.lower() == "video/h264":
        _last_encoder = NvencH264Encoder()
        return _last_encoder
    return _original_get_encoder(codec)


def set_target_bitrate(bps: int, max_bps=None) -> None:
    """运行时调整 WebRTC 视频编码码率（中继降码率用）。
    max_bps 同时设为上限，防止浏览器 REMB 把码率重新拉高导致中继链路拥塞。"""
    bps = max(300_000, min(int(bps), 50_000_000))
    SETTINGS["bitrate"] = bps
    if max_bps:
        SETTINGS["max_bitrate"] = max(300_000, min(int(max_bps), 50_000_000))
    enc = _last_encoder
    if enc is not None:
        try:
            if max_bps:
                enc._max_bitrate = SETTINGS["max_bitrate"]
            enc.target_bitrate = bps
        except Exception:
            pass


def apply_codec_preference(transceiver) -> None:
    """强制该 transceiver 优先使用 H264（否则浏览器 offer 里的 VP8 会排在前面）。"""
    from aiortc.codecs import get_capabilities
    caps = get_capabilities(transceiver.kind).codecs
    h264 = [c for c in caps if c.mimeType.lower() == "video/h264"]
    vp8 = [c for c in caps if c.mimeType.lower() == "video/vp8"]
    rtx = [c for c in caps if c.mimeType.lower() == "video/rtx"]
    transceiver.setCodecPreferences(h264 + vp8 + rtx)


def install_patch():
    """必须在创建 RTCPeerConnection 之前调用一次。"""
    global _original_get_encoder
    import aiortc.codecs as codecs
    import aiortc.rtcrtpsender as sender

    if _original_get_encoder is None:
        _original_get_encoder = codecs.get_encoder

    codecs.get_encoder = _patched_get_encoder
    sender.get_encoder = _patched_get_encoder
    logger.info("NVENC H.264 encoder patch installed (fps=%s bitrate=%s)",
                SETTINGS["fps"], SETTINGS["bitrate"])
