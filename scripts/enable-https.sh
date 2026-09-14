#!/usr/bin/env bash
# 为 hupo.stalkerai.cn 启用/校验 HTTPS（幂等）
#
# 现状：证书已由 `certbot --nginx` 签发并配置，续期由 certbot 定时任务自动处理。
# 这个脚本用于：换机器重建、证书丢失后重新跑、或事后校验状态。
#
# 注意：hupo.chat 因域名级问题（大陆服务器需备案）无法签发证书，
#      主域名已切换为 hupo.stalkerai.cn。
set -euo pipefail

DOMAIN="${1:-hupo.stalkerai.cn}"
CERT="/etc/letsencrypt/live/$DOMAIN"

if [ -f "$CERT/fullchain.pem" ]; then
  echo "✅ 证书已存在：$CERT"
else
  echo "▶ 证书不存在，申请中（需 DNS 已指向本机）..."
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect
fi

echo "▶ 校验 nginx 配置"
sudo nginx -t
sudo systemctl reload nginx

echo "▶ 验证"
curl -s -o /dev/null -w "  https://$DOMAIN → %{http_code}（证书校验=%{ssl_verify_result}）\n" "https://$DOMAIN/"
curl -s -o /dev/null -w "  http://$DOMAIN  → %{http_code} → %{redirect_url}\n" "http://$DOMAIN/"

echo "▶ 续期演练"
if sudo certbot renew --dry-run --cert-name "$DOMAIN" >/dev/null 2>&1; then
  echo "  ✅ 自动续期正常"
else
  echo "  ⚠️ 续期演练失败，需检查"
fi
