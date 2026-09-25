"""被控机 Agent 入口。

用法:
    python agent\\main.py                      # 启动服务（默认 127.0.0.1:8443）
    python agent\\main.py --host 0.0.0.0 --port 8443
    python agent\\main.py --set-password 我的密码
    python agent\\main.py --fps 30 --bitrate 8000000 --monitor 0
"""
import argparse
import logging
import os
import sys
from pathlib import Path

# 允许 `python agent\main.py` 直接运行（使用同目录扁平导入）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from capture import ScreenCapture, enable_dpi_awareness, list_monitors  # noqa: E402
import config as config_mod  # noqa: E402
import encoder as encoder_mod  # noqa: E402
from injector import Injector  # noqa: E402
import server as server_mod  # noqa: E402


def parse_args(argv):
    p = argparse.ArgumentParser(description="远程控制软件 - 被控机 Agent")
    p.add_argument("--host", default=None)
    p.add_argument("--port", type=int, default=None)
    p.add_argument("--fps", type=int, default=None)
    p.add_argument("--bitrate", type=int, default=None)
    p.add_argument("--monitor", type=int, default=None)
    p.add_argument("--set-password", metavar="PASSWORD", default=None,
                   help="设置访问密码后退出")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("comtypes").setLevel(logging.WARNING)
    logging.getLogger("aioice").setLevel(logging.WARNING)
    logging.getLogger("aiortc.rtcdtlstransport").setLevel(logging.WARNING)

    cfg = config_mod.load()

    if args.set_password:
        cfg["password_hash"] = config_mod.hash_password(args.set_password)
        cfg.pop("password", None)
        config_mod.save(cfg)
        print("密码已更新。")
        return 0

    if args.host:
        cfg["host"] = args.host
    if args.port:
        cfg["port"] = args.port
    if args.fps:
        cfg["fps"] = args.fps
    if args.bitrate:
        cfg["bitrate"] = args.bitrate
    if args.monitor is not None:
        cfg["monitor"] = args.monitor

    enable_dpi_awareness()

    encoder_mod.configure(cfg["fps"], cfg["bitrate"])
    encoder_mod.install_patch()

    capture = ScreenCapture(monitor=cfg["monitor"], fps=cfg["fps"])
    capture.start()

    monitors = list_monitors()
    mon_rect = (monitors[capture.monitor]["left"], monitors[capture.monitor]["top"],
                monitors[capture.monitor]["width"], monitors[capture.monitor]["height"])
    injector = Injector(mon_rect)

    server_mod.WEB_DIR = Path(__file__).resolve().parent.parent / "web"

    app = server_mod.create_app(cfg, capture, injector)

    from aiohttp import web
    host = cfg["host"]
    port = int(cfg["port"])

    ssl_context = None
    cert = cfg.get("tls_cert")
    key = cfg.get("tls_key")
    if cert and key and os.path.exists(cert) and os.path.exists(key):
        import ssl
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.load_cert_chain(cert, key)
        if host == "127.0.0.1":
            host = "0.0.0.0"

    scheme = "https" if ssl_context else "http"
    print("=" * 60)
    print("远程控制 Agent 已启动")
    print("  监听       : {}://{}:{}".format(scheme, host, port))
    print("  显示器     : #{} {}x{} 后端={}".format(
        capture.monitor, capture.width, capture.height, capture.backend))
    print("  帧率/码率  : {} fps / {} bps".format(cfg["fps"], cfg["bitrate"]))
    print("  访问密码   : 使用 --set-password 修改（首次默认 admin，请立即修改）")
    print("=" * 60)

    try:
        web.run_app(app, host=host, port=port, print=None, access_log=None, ssl_context=ssl_context)
    finally:
        capture.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
