#!/usr/bin/env bash
# **把本机那几条 frp 隧道拉起来**（幂等：已经在跑的不动它）。
#
# 用法：bash scripts/start-tunnels.sh
#
# ── 为什么要有这个脚本 ────────────────────────────────────
# 这几条隧道（w. 壳 / apps. 制品口 / u. GUI / v. …）**一直是手动 `setsid nohup` 起的**，
# 没有任何脚本或单元管它们 ⇒ **机器重启之后它们不会自己回来**，
# 而现象是"网站 502"（`w.` 那条)或"小程序打不开"（`apps.` 那条）—— 都不好查。
# ⇒ 这个脚本不解决"开机自启"（那要 systemd，见 `00-PROGRESS.md` §六 #48），
#    但把"重启之后要跑哪几条"变成**一条命令**，并且**跑完自己报读数**。
#
# ⚠️ 它**不碰任何秘密**：只读 `~/.local/frp/*.toml`（那些文件 0600，里面才有 secretKey）。
# ⚠️ 已经在跑的那条**不会重起**（重起会掐断线上几秒）。

set -u
FRP="$HOME/.local/frp"
if [ ! -x "$FRP/frpc" ]; then
  echo "✗ 找不到 $FRP/frpc（这台机器上没装 frp 客户端？）"
  exit 1
fi

start_one() {
  local name="$1" conf="$FRP/$1.toml"
  if [ ! -f "$conf" ]; then
    echo "  ⚪ $name：没有那份配置（$conf）⇒ 跳过"
    return 0
  fi
  if pgrep -f "frpc -c .*$1.toml" >/dev/null 2>&1; then
    echo "  ✓ $name：已经在跑"
    return 0
  fi
  ( cd "$FRP" && setsid nohup ./frpc -c "$conf" >/dev/null 2>&1 </dev/null & )
  sleep 2
  if pgrep -f "frpc -c .*$1.toml" >/dev/null 2>&1; then
    echo "  ✚ $name：起来了"
  else
    echo "  ✗ $name：没起来（看 $FRP/$1.log）"
  fi
}

echo "▶ 拉隧道（已经在跑的不动）"
for n in frpc-w frpc-apps; do
  start_one "$n"
done

echo ""
echo "▶ 读数（**报告它现在是什么样，不喊口号**）"
for u in https://w.stalkerai.cn/api/version https://apps.stalkerai.cn/; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$u" || echo 000)
  case "$u" in
    *apps.stalkerai.cn*) [ "$code" = "404" ] && code="$code（未知路径 = 制品服务在答，正常）" ;;
  esac
  echo "  $u → $code"
done
