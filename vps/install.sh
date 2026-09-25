#!/usr/bin/env bash
# 国内云服务器（Ubuntu/Debian, amd64）一键安装：frps 中转 + Caddy 自动 HTTPS
#
# 用法（在服务器上执行）：
#   bash install.sh <域名> <frp令牌>
# 例：
#   bash install.sh rdp.example.com YOUR_FRP_TOKEN
#
# 前置：
#   1. Cloudflare 添加 A 记录 <域名> -> 本服务器公网IP （灰云/DNS only）
#   2. 服务器安全组放行 TCP 22, 80, 443, 7000
set -euo pipefail

DOMAIN="${1:?用法: bash install.sh <域名> <frp令牌>}"
TOKEN="${2:?用法: bash install.sh <域名> <frp令牌>}"
FRP_REMOTE_PORT="${3:-8443}"

FRP_VER="0.61.0"
CADDY_VER="2.8.4"
ARCH="amd64"

# 依次尝试 直连 和 国内 GitHub 镜像
fetch() {
    local url="$1" out="$2"
    for prefix in "" "https://ghfast.top/" "https://gh-proxy.com/" "https://mirror.ghproxy.com/"; do
        echo "   -> ${prefix}${url}"
        if curl -fL --connect-timeout 20 --max-time 300 "${prefix}${url}" -o "$out" && [ -s "$out" ]; then
            return 0
        fi
    done
    return 1
}

echo "==> 检查依赖"
if ! command -v curl >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y curl
fi

TMP=$(mktemp -d)
cd "$TMP"

echo "==> 下载 frp v${FRP_VER}"
fetch "https://github.com/fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_linux_${ARCH}.tar.gz" frp.tar.gz \
    || { echo "frp 下载失败"; exit 1; }
tar xzf frp.tar.gz
install -m 0755 "$(find . -name frps -type f | head -1)" /usr/local/bin/frps

echo "==> 写 frps 配置"
mkdir -p /etc/frp
cat > /etc/frp/frps.toml <<EOF
bindPort = 7000
proxyBindAddr = "127.0.0.1"
auth.method = "token"
auth.token = "${TOKEN}"
allowPorts = [{ start = ${FRP_REMOTE_PORT}, end = ${FRP_REMOTE_PORT} }]
EOF

cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frps
After=network.target

[Service]
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> 下载 Caddy v${CADDY_VER}"
fetch "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VER}/caddy_${CADDY_VER}_linux_${ARCH}.tar.gz" caddy.tar.gz \
    || { echo "Caddy 下载失败"; exit 1; }
tar xzf caddy.tar.gz caddy
install -m 0755 caddy /usr/local/bin/caddy

echo "==> 写 Caddy 配置（自动申请 Let's Encrypt 正式证书）"
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<EOF
{
    acme_ca https://acme-v02.api.letsencrypt.org/directory
}
${DOMAIN} {
    reverse_proxy 127.0.0.1:${FRP_REMOTE_PORT}
}
EOF

cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network.target

[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> 启动服务"
systemctl daemon-reload
systemctl enable --now frps
systemctl enable --now caddy
sleep 3
echo "--- frps ---"; systemctl --no-pager --full status frps | head -6 || true
echo "--- caddy ---"; systemctl --no-pager --full status caddy | head -6 || true

echo ""
echo "完成。"
echo "  frp 服务器IP : $(curl -s --max-time 8 https://api.ipify.org || echo 'YOUR_SERVER_IP')"
echo "  frp 端口     : 7000"
echo "  frp 令牌     : ${TOKEN}"
echo "  主控机访问   : https://${DOMAIN}"
