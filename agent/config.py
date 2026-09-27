"""配置加载与保存。首次运行自动生成 token 密钥，并把明文密码转为哈希。"""
import base64
import hashlib
import hmac
import json
import os
import secrets

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")

DEFAULTS = {
    "host": "127.0.0.1",
    "port": 8443,
    "password_hash": None,
    "fps": 60,
    "bitrate": 8000000,
    "monitor": 0,
    "session_ttl": 12 * 3600,
    "tls_cert": None,
    "tls_key": None,
    "ice_servers": [
        {"urls": ["stun:stun.miwifi.com:3478"]},
        {"urls": ["stun:stun.l.google.com:19302"]},
        # 部署 coturn 后，按 vps/install_turn.sh 输出的 ice_servers 填写（域名/用户名/口令）
        # {"urls": ["turn:<你的域名>:3478?transport=udp"], "username": "<用户名>", "credential": "<口令>"},
        # {"urls": ["turn:<你的域名>:3478?transport=tcp"], "username": "<用户名>", "credential": "<口令>"},
    ],
    "token_secret": None,
}


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def hash_password(password: str, salt: bytes = None, iterations: int = 200_000) -> str:
    salt = salt or os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(iterations, _b64e(salt), _b64e(dk))


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_b64 + "=" * (-len(salt_b64) % 4))
        expected = base64.urlsafe_b64decode(hash_b64 + "=" * (-len(hash_b64) % 4))
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iters))
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False


def save(cfg: dict) -> None:
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CONFIG_PATH)


def load() -> dict:
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError):
            cfg = {}
    else:
        cfg = {}

    merged = dict(DEFAULTS)
    merged.update(cfg)

    changed = False

    # 明文密码 -> 哈希（首次运行或用户手改 config.json）
    plain = cfg.get("password")
    if plain:
        merged["password_hash"] = hash_password(str(plain))
        changed = True
    if "password" in merged:
        del merged["password"]
        changed = True

    if not merged.get("token_secret"):
        merged["token_secret"] = _b64e(secrets.token_bytes(32))
        changed = True

    if not merged.get("password_hash"):
        merged["password_hash"] = hash_password("admin")
        changed = True

    if changed or not os.path.exists(CONFIG_PATH):
        save(merged)

    return merged
