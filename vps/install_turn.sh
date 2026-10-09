#!/usr/bin/env bash
# 国内云服务器（Ubuntu/Debian, amd64）部署 coturn：WebRTC 的 TURN/STUN 中继
# 让"不同局域网"的设备在 P2P 打洞失败时，仍走 WebRTC 低延迟管线（而不是 WebCodecs）。
#
# 用法：
#   bash install_turn.sh <域名> <用户名> <密码> [公网IP]
# 例：
#   bash install_turn.sh remote.example.com turnuser TurnPass123
#
# 前置：安全组放行  UDP/TCP 3478、TCP 5349、以及中继端口段 UDP 49160-49200
set -euo pipefail

DOMAIN="${1:?用法: bash install_turn.sh <域名> <用户名> <密码> [公网IP]}"
TURN_USER="${2:?缺少用户名}"
TURN_PASS="${3:?缺少密码}"
PUBLIC_IP="${4:-}"

RELAY_MIN=49160
RELAY_MAX=49200

if [ -z "$PUBLIC_IP" ]; then
    PUBLIC_IP="$(curl -s --max-time 8 https://api.ipify.org || true)"
fi
if [ -z "$PUBLIC_IP" ]; then
    PUBLIC_IP="$(curl -s --max-time 8 ifconfig.me || true)"
fi
[ -n "$PUBLIC_IP" ] || { echo "无法自动获取公网IP，请作为第4个参数传入"; exit 1; }
case "$PUBLIC_IP" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|127.*)
        echo "检测到 PUBLIC_IP=${PUBLIC_IP} 是内网地址，请显式传入公网IP作为第4个参数"; exit 1;;
esac

# 云主机常见「私网IP + 公网EIP(NAT)」：external-ip 必须写 公网/私网 映射，
# 否则 coturn 会把中继到自身(公网)判为非法，返回 403 Forbidden IP（中继不可用）。
LOCAL_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
[ -n "$LOCAL_IP" ] || LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
EXTERNAL_IP_CFG="$PUBLIC_IP"
if [ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "$PUBLIC_IP" ]; then
    EXTERNAL_IP_CFG="${PUBLIC_IP}/${LOCAL_IP}"
    echo "检测到私网IP ${LOCAL_IP}，external-ip 使用 ${EXTERNAL_IP_CFG}"
fi

echo "==> 安装 coturn"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y coturn

echo "==> 定位 Caddy 证书（用于 TLS 5349）"
CERT_SRC=""
KEY_SRC=""
for base in /var/lib/caddy/.local/share/caddy/certificates /root/.local/share/caddy/certificates; do
    if [ -d "$base" ]; then
        CERT_SRC="$(find "$base" -type f -name "${DOMAIN}.crt" 2>/dev/null | head -1 || true)"
        KEY_SRC="$(find "$base" -type f -name "${DOMAIN}.key" 2>/dev/null | head -1 || true)"
    fi
    [ -n "$CERT_SRC" ] && break
done

TLS_CONF=""
if [ -n "$CERT_SRC" ] && [ -n "$KEY_SRC" ]; then
    echo "    找到证书：$CERT_SRC"
    install -m 0644 "$CERT_SRC" /etc/coturn/turn.crt
    install -m 0600 "$KEY_SRC"  /etc/coturn/turn.key
    TLS_CONF=$'cert=/etc/coturn/turn.crt\npkey=/etc/coturn/turn.key'
    echo "    TLS(5349) 已启用"
else
    echo "    未找到 Caddy 证书，跳过 TLS(5349)。可用 TURN over TCP(3478) 兜底。"
fi

echo "==> 写 /etc/turnserver.conf"
cat > /etc/turnserver.conf <<EOF
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=${EXTERNAL_IP_CFG}
min-port=${RELAY_MIN}
max-port=${RELAY_MAX}
fingerprint
lt-cred-mech
realm=${DOMAIN}
user=${TURN_USER}:${TURN_PASS}
no-cli
no-multicast-peers
stale-nonce
log-file=/var/log/turnserver.log
simple-log
${TLS_CONF}
EOF

echo "==> 开启 coturn 服务"
if [ -f /etc/default/coturn ]; then
    sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
    grep -q '^TURNSERVER_ENABLED=' /etc/default/coturn || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
elif [ -f /etc/default/turnserver ]; then
    sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/turnserver
fi

systemctl daemon-reload
systemctl enable --now coturn
sleep 2
systemctl --no-pager --full status coturn | head -6 || true

echo ""
echo "完成。"
echo "  TURN 主机   : ${DOMAIN}  (公网IP ${PUBLIC_IP})"
echo "  端口        : 3478 udp/tcp, 5349 tcp(tls)"
echo "  中继端口段  : ${RELAY_MIN}-${RELAY_MAX} udp"
echo "  账号        : ${TURN_USER} / ${TURN_PASS}"
echo ""
echo "安全组需放行：入站 UDP+TCP 3478、TCP 5349、UDP ${RELAY_MIN}-${RELAY_MAX}"
echo "本地 ufw 若启用："
echo "  ufw allow 3478/udp; ufw allow 3478/tcp; ufw allow 5349/tcp; ufw allow ${RELAY_MIN}:${RELAY_MAX}/udp"
echo ""
echo "自检（在本机验证 TURN 是否可用）："
echo "  turnutils_uclient -v -u ${TURN_USER} -w '${TURN_PASS}' -p 3478 ${DOMAIN}"
echo ""
echo "把下面这段合并进 agent/config.json 的 ice_servers："
cat <<EOF
[
  { "urls": ["stun:${DOMAIN}:3478"] },
  { "urls": ["turn:${DOMAIN}:3478?transport=udp"], "username": "${TURN_USER}", "credential": "${TURN_PASS}" },
  { "urls": ["turn:${DOMAIN}:3478?transport=tcp"], "username": "${TURN_USER}", "credential": "${TURN_PASS}" },
  { "urls": ["turns:${DOMAIN}:5349?transport=tcp"], "username": "${TURN_USER}", "credential": "${TURN_PASS}" }
]
EOF
