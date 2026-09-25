"""Windows 键鼠注入（user32!SendInput）。

输入协议（与浏览器前端约定）:
  {"t": "m", "x": 0..1, "y": 0..1}     # 鼠标绝对移动（相对被采集显示器的归一化坐标）
  {"t": "b", "b": 0|1|2|3|4, "d": 1|0} # 鼠标键 按下/抬起  (0左 1中 2右 3后退 4前进)
  {"t": "w", "dx": int, "dy": int}     # 滚轮
  {"t": "k", "c": "KeyA", "d": 1|0}    # 键盘（浏览器 event.code）
"""
import ctypes
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_XDOWN = 0x0080
MOUSEEVENTF_XUP = 0x0100
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002

XBUTTON1 = 0x0001
XBUTTON2 = 0x0002

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                ("mouseData", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT


KEYMAP = {
    "Escape": (0x1B, False), "Tab": (0x09, False), "CapsLock": (0x14, False),
    "Space": (0x20, False), "Enter": (0x0D, False), "Backspace": (0x08, False),
    "ContextMenu": (0x5D, True), "ShiftLeft": (0xA0, False), "ShiftRight": (0xA1, False),
    "ControlLeft": (0xA2, False), "ControlRight": (0xA3, True),
    "AltLeft": (0xA4, False), "AltRight": (0xA5, True),
    "MetaLeft": (0x5B, True), "MetaRight": (0x5C, True),
    "Insert": (0x2D, True), "Delete": (0x2E, True), "Home": (0x24, True),
    "End": (0x23, True), "PageUp": (0x21, True), "PageDown": (0x22, True),
    "ArrowLeft": (0x25, True), "ArrowUp": (0x26, True),
    "ArrowRight": (0x27, True), "ArrowDown": (0x28, True),
    "NumLock": (0x90, True), "ScrollLock": (0x91, False), "Pause": (0x13, False),
    "PrintScreen": (0x2C, True),
    "Minus": (0xBD, False), "Equal": (0xBB, False), "BracketLeft": (0xDB, False),
    "BracketRight": (0xDD, False), "Backslash": (0xDC, False), "Semicolon": (0xBA, False),
    "Quote": (0xDE, False), "Backquote": (0xC0, False), "Comma": (0xBC, False),
    "Period": (0xBE, False), "Slash": (0xBF, False), "IntlBackslash": (0xE2, False),
    "NumpadEnter": (0x0D, True), "NumpadAdd": (0x6B, False), "NumpadSubtract": (0x6D, False),
    "NumpadMultiply": (0x6A, False), "NumpadDivide": (0x6F, True), "NumpadDecimal": (0x6E, False),
}
for _i in range(10):
    KEYMAP["Digit{}".format(_i)] = (0x30 + _i, False)
    KEYMAP["Numpad{}".format(_i)] = (0x60 + _i, False)
for _i in range(26):
    KEYMAP["Key{}".format(chr(65 + _i))] = (0x41 + _i, False)
for _i in range(1, 25):
    KEYMAP["F{}".format(_i)] = (0x6F + _i, False)


def _send(*inputs):
    n = len(inputs)
    array = (INPUT * n)(*inputs)
    sent = user32.SendInput(n, array, ctypes.sizeof(INPUT))
    if sent != n:
        raise ctypes.WinError(ctypes.get_last_error())


def _mouse_event(flags, dx=0, dy=0, data=0):
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(dx, dy, data, flags, 0, 0)
    return inp


def _key_event(vk, up, extended=False):
    inp = INPUT(type=INPUT_KEYBOARD)
    flags = (KEYEVENTF_KEYUP if up else 0) | (KEYEVENTF_EXTENDEDKEY if extended else 0)
    inp.ki = KEYBDINPUT(vk, 0, flags, 0, 0)
    return inp


def virtual_screen_rect():
    gsm = user32.GetSystemMetrics
    return (gsm(SM_XVIRTUALSCREEN), gsm(SM_YVIRTUALSCREEN),
            gsm(SM_CXVIRTUALSCREEN), gsm(SM_CYVIRTUALSCREEN))


class Injector:
    """把归一化坐标映射到指定显示器，再用 SendInput 注入。"""

    def __init__(self, monitor_rect):
        self.set_monitor(monitor_rect)

    def set_monitor(self, monitor_rect):
        left, top, width, height = monitor_rect
        self.mon_left = int(left)
        self.mon_top = int(top)
        self.mon_w = max(1, int(width))
        self.mon_h = max(1, int(height))
        vx, vy, vw, vh = virtual_screen_rect()
        self.virt = (vx, vy, max(1, vw), max(1, vh))

    def move(self, nx, ny):
        nx = 0.0 if nx < 0 else (1.0 if nx > 1 else float(nx))
        ny = 0.0 if ny < 0 else (1.0 if ny > 1 else float(ny))
        px = self.mon_left + nx * (self.mon_w - 1)
        py = self.mon_top + ny * (self.mon_h - 1)
        vx, vy, vw, vh = self.virt
        ax = int(round((px - vx) * 65535 / (vw - 1)))
        ay = int(round((py - vy) * 65535 / (vh - 1)))
        ax = max(0, min(65535, ax))
        ay = max(0, min(65535, ay))
        _send(_mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay))

    def button(self, button, down):
        if button == 0:
            flags = MOUSEEVENTF_LEFTDOWN if down else MOUSEEVENTF_LEFTUP
            _send(_mouse_event(flags))
        elif button == 1:
            flags = MOUSEEVENTF_MIDDLEDOWN if down else MOUSEEVENTF_MIDDLEUP
            _send(_mouse_event(flags))
        elif button == 2:
            flags = MOUSEEVENTF_RIGHTDOWN if down else MOUSEEVENTF_RIGHTUP
            _send(_mouse_event(flags))
        elif button in (3, 4):
            xbtn = XBUTTON1 if button == 3 else XBUTTON2
            flags = MOUSEEVENTF_XDOWN if down else MOUSEEVENTF_XUP
            _send(_mouse_event(flags, data=xbtn))

    def wheel(self, dx, dy):
        if dy:
            _send(_mouse_event(MOUSEEVENTF_WHEEL, data=int(dy)))
        if dx:
            _send(_mouse_event(MOUSEEVENTF_HWHEEL, data=int(dx)))

    def key(self, code, down, key_hint=None):
        entry = KEYMAP.get(code)
        if entry is None:
            vk = self._vk_from_char(key_hint)
            if vk is None:
                return
            extended = False
        else:
            vk, extended = entry
        _send(_key_event(vk, not down, extended))

    @staticmethod
    def _vk_from_char(ch):
        if not ch or len(ch) != 1:
            return None
        res = user32.VkKeyScanW(ctypes.c_wchar(ch))
        if res == -1:
            return None
        return res & 0xFF

    def dispatch(self, ev: dict) -> None:
        t = ev.get("t")
        if t == "m":
            self.move(ev.get("x", 0.0), ev.get("y", 0.0))
        elif t == "b":
            self.button(int(ev.get("b", 0)), bool(ev.get("d")))
        elif t == "w":
            self.wheel(int(ev.get("dx", 0)), int(ev.get("dy", 0)))
        elif t == "k":
            self.key(ev.get("c", ""), bool(ev.get("d")), ev.get("k"))
