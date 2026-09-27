"""屏幕采集：优先 DXGI Desktop Duplication（dxcam），失败回退 mss，并叠加鼠标光标。

对外接口:
    enable_dpi_awareness()
    list_monitors() -> [{"index","left","top","width","height","primary"}]
    ScreenCapture(monitor, fps)   .start() .get_frame() .stop() .size .rect
"""
import ctypes
import threading
import time

import numpy as np

_user32 = ctypes.WinDLL("user32", use_last_error=True)


def enable_dpi_awareness():
    """让进程感知物理像素，避免 125%/150% 缩放导致采集分辨率与鼠标坐标不一致。"""
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            _user32.SetProcessDPIAware()
        except Exception:
            pass


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", RECT),
                ("rcWork", RECT), ("dwFlags", ctypes.c_ulong)]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class CURSORINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_ulong), ("flags", ctypes.c_ulong),
                ("hCursor", ctypes.c_void_p), ("ptScreenPos", POINT)]


CURSOR_SHOWING = 0x00000001
_user32.GetCursorInfo.argtypes = (ctypes.POINTER(CURSORINFO),)
_user32.GetCursorInfo.restype = ctypes.c_int

_CURSOR_SHAPE = [
    (0, 0), (0, 19), (4, 15), (7, 22), (11, 20), (8, 13), (14, 13),
]


def _draw_cursor(frame, origin_left, origin_top):
    """在 BGRA 帧上叠加当前鼠标光标（DXGI 截屏默认不含光标）。"""
    import cv2
    info = CURSORINFO()
    info.cbSize = ctypes.sizeof(CURSORINFO)
    if not _user32.GetCursorInfo(ctypes.byref(info)):
        return frame
    if not (info.flags & CURSOR_SHOWING):
        return frame
    x = info.ptScreenPos.x - origin_left
    y = info.ptScreenPos.y - origin_top
    h, w = frame.shape[:2]
    if not (0 <= x < w and 0 <= y < h):
        return frame
    pts = np.array([(px + x, py + y) for px, py in _CURSOR_SHAPE], dtype=np.int32)
    cv2.fillPoly(frame, [pts], (255, 255, 255, 255))
    cv2.polylines(frame, [pts], True, (0, 0, 0, 255), 1)
    return frame


def list_monitors():
    monitors = []
    MonitorEnumProc = ctypes.WINFUNCTYPE(
        ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
        ctypes.POINTER(RECT), ctypes.c_double,
    )

    def _callback(hmonitor, hdc, lprect, lparam):
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if _user32.GetMonitorInfoW(hmonitor, ctypes.byref(info)):
            r = info.rcMonitor
            monitors.append({
                "index": len(monitors),
                "left": r.left,
                "top": r.top,
                "width": r.right - r.left,
                "height": r.bottom - r.top,
                "primary": bool(info.dwFlags & 1),
            })
        return 1

    _user32.EnumDisplayMonitors(None, None, MonitorEnumProc(_callback), 0)
    if not monitors:
        vx = _user32.GetSystemMetrics(76)
        vy = _user32.GetSystemMetrics(77)
        vw = _user32.GetSystemMetrics(78)
        vh = _user32.GetSystemMetrics(79)
        monitors.append({"index": 0, "left": vx, "top": vy, "width": vw,
                         "height": vh, "primary": True})
    return monitors


class ScreenCapture:
    def __init__(self, monitor: int = 0, fps: int = 30):
        self.monitor = int(monitor)
        self.fps = int(fps)
        self.width = 0
        self.height = 0
        self.rect = (0, 0, 0, 0)
        self._cam = None
        self._mss = None
        self._started = False
        self._last_frame = None
        self._lock = threading.Lock()
        self._stopping = False
        self._cursor_overlay = True

    # ---- 生命期 ----
    def start(self):
        if self._started:
            return self
        monitors = list_monitors()
        if self.monitor < 0 or self.monitor >= len(monitors):
            self.monitor = 0
        mon = monitors[self.monitor]
        self.rect = (mon["left"], mon["top"], mon["width"], mon["height"])

        try:
            import dxcam
            output_idx = self.monitor
            try:
                self._cam = dxcam.create(device_idx=0, output_idx=output_idx, output_color="BGRA")
            except Exception:
                self._cam = dxcam.create(device_idx=0, output_color="BGRA")
            self._cam.start(target_fps=self.fps, video_mode=True)
            self.width = int(self._cam.width)
            self.height = int(self._cam.height)
            self._backend = "dxcam"
        except Exception:
            self._cam = None
            self._start_mss(mon)

        self._started = True
        return self

    def _start_mss(self, mon):
        import mss
        self._mss = mss.mss()
        self._mss_region = {
            "left": mon["left"], "top": mon["top"],
            "width": mon["width"], "height": mon["height"],
        }
        self.width = int(mon["width"])
        self.height = int(mon["height"])
        self._backend = "mss"
        threading.Thread(target=self._mss_loop, daemon=True).start()

    def _mss_loop(self):
        period = 1.0 / max(1, self.fps)
        while not self._stopping:
            t0 = time.perf_counter()
            try:
                raw = self._mss.grab(self._mss_region)
                arr = np.ascontiguousarray(np.asarray(raw, dtype=np.uint8))
                if self._cursor_overlay:
                    _draw_cursor(arr, self.rect[0], self.rect[1])
                with self._lock:
                    self._last_frame = arr
            except Exception:
                pass
            dt = time.perf_counter() - t0
            if dt < period:
                time.sleep(period - dt)

    def get_frame(self):
        if self._cam is not None:
            frame = self._cam.get_latest_frame()
            if frame is not None:
                self._last_frame = frame
            src = self._last_frame
            if src is not None and self._cursor_overlay:
                _draw_cursor(src, self.rect[0], self.rect[1])
            return src
        with self._lock:
            return self._last_frame

    def stop(self):
        self._stopping = True
        self._started = False
        if self._cam is not None:
            try:
                self._cam.stop()
            except Exception:
                pass
            self._cam = None
        self._mss = None

    @property
    def backend(self):
        return getattr(self, "_backend", "none")
