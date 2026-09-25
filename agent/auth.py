"""会话令牌与登录限速。"""
import base64
import hashlib
import hmac
import json
import secrets
import time


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def create_token(secret: str, ttl: int, extra: dict = None) -> str:
    payload = {"exp": int(time.time()) + int(ttl), "n": _b64e(secrets.token_bytes(8))}
    if extra:
        payload.update(extra)
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = _b64e(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    return body + "." + sig


def verify_token(secret: str, token: str) -> dict:
    """返回 payload 字典；无效返回 None。"""
    if not token or "." not in token:
        return None
    body, sig = token.split(".", 1)
    expected = _b64e(hmac.new(secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        payload = json.loads(_b64d(body).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if int(payload.get("exp", 0)) < time.time():
        return None
    return payload


class LoginThrottle:
    """同一来源连续失败后指数退避。"""

    def __init__(self, max_fails: int = 5, base_delay: float = 2.0, max_delay: float = 60.0):
        self.max_fails = max_fails
        self.base_delay = base_delay
        self.max_delay = max_delay
        self._state = {}

    def retry_after(self, key: str) -> float:
        entry = self._state.get(key)
        if not entry:
            return 0.0
        fails, until = entry
        remaining = until - time.time()
        return remaining if remaining > 0 else 0.0

    def register_failure(self, key: str) -> None:
        fails, _ = self._state.get(key, (0, 0.0))
        fails += 1
        if fails >= self.max_fails:
            delay = min(self.base_delay * (2 ** (fails - self.max_fails)), self.max_delay)
            self._state[key] = (fails, time.time() + delay)

    def register_success(self, key: str) -> None:
        self._state.pop(key, None)
