#!/usr/bin/env bash
# 用 lego + Cloudflare DNS-01 为 remote / rc 签发证书，并配置 Caddy 使用该证书
# 用法（服务器上）： sudo bash setup_ssl.sh <Cloudflare_API_Token>
set -euo pipefail

TOKEN="${1:?用法: sudo bash setup_ssl.sh <Cloudflare_API_Token>}"
D1="remote.example.com"
D2="rc.example.com"
CERTDIR="/etc/caddy/certs"
LEGO_VER="4.21.0"

echo "==> 下载 lego"
cd /tmp
URL="https://github.com/go-acme/lego/releases/download/v${LEGO_VER}/lego_v${LEGO_VER}_linux_amd64.tar.gz"
for prefix in "" "https://ghfast.top/" "https://gh-proxy.com/"; do
    if curl -fL --connect-timeout 20 "${prefix}${URL}" -o lego.tgz && [ -s lego.tgz ]; then
        break
    fi
done
tar xzf lego.tgz lego
install -m 0755 lego /usr/local/bin/lego

echo "==> 申请证书（DNS-01）"
export CLOUDFLARE_DNS_API_TOKEN="$TOKEN"
mkdir -p "$CERTDIR"
lego --email "admin@example.com" --dns cloudflare \
     --domains "$D1" --domains "$D2" --accept-tos --path "$CERTDIR" run

CRT="$CERTDIR/certificates/${D1}.crt"
KEY="$CERTDIR/certificates/${D1}.key"
[ -f "$CRT" ] || { echo "证书未生成: $CRT"; exit 1; }

echo "==> 写 Caddyfile"
cat > /etc/caddy/Caddyfile <<EOF
${D1} {
    tls ${CRT} ${KEY}
    reverse_proxy 127.0.0.1:8443
}
${D2} {
    tls ${CRT} ${KEY}
    reverse_proxy 127.0.0.1:8443
}
EOF

echo "==> 重启 Caddy"
systemctl restart caddy
sleep 3
systemctl --no-pager --full status caddy | head -5 || true
echo ""
echo "完成。证书：$CRT"
