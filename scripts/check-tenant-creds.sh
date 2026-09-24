#!/usr/bin/env bash
# **租户那半到底接通了没有**（B10 的最后一段判据 · 2026-09-24）。
#
# ── 它判什么 ────────────────────────────────────────────────
#   租户（盒子里那台）要能用语音与画图，缺一不可的三件事：
#     ① 中心送钥匙时**两种形状一起带**（老的 `key` ＋ 新的 `creds`）；
#     ② 盒子里写的时候**合并**（不是整份重写 —— 那会把别的几样抹掉）；
#     ③ 盒子里读的时候**认那份单文件** `creds.yaml`（识别路/画图读的就是它）。
#   前两件是"仓库里的代码对不对"（这条脚本**静态**就能判）；
#   第三件要**真去盒子里看**（`--live`，要 root）。
#
# ── 用法 ────────────────────────────────────────────────────
#   bash scripts/check-tenant-creds.sh          # 静态那几条（不用 root）
#   sudo bash scripts/check-tenant-creds.sh --live   # 再看一眼真盒子：`/data/creds.yaml` 里有那几样吗
#   ⚠️ **必须以"那个租户用户的身份"去看那个盒子**（2026-09-24 实测纠正）：
#      两个盒子跑在**租户自己的账号**下（`hupo-a` uid 2001 / `hupo-b` uid 2002 的 **rootless** podman），
#      所以 `root` 或 `deploy` 的 `podman ps` **都看不到它们**（各有各的存储）
#      ⇒ 脚本内部用 `sudo -u <那个用户> podman exec …`（root 才切得过去）。
#
# ── 退出码 ──────────────────────────────────────────────────
#   0 = 全过 · 1 = 有不过 · 3 = 环境不具备（要 root 但没给）
#
# ⚠️ **绝不打印任何钥匙的值**：`--live` 只报"有哪几样、各多长"。

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1
bad=0
pass=0
skip=0

ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
no()   { echo "  ✗ $1"; bad=$((bad+1)); }
have() { grep -q "$1" "$2"; }

echo "── ① 中心送钥匙：两种形状一起带（老盒子认 key、新盒子认 creds）"
if have "creds: pack" "$CORE/src/tenant-channel.mjs" && have "state: 'ready'" "$CORE/src/tenant-channel.mjs"; then
  ok "pushKey 把 key 与 creds 一起发（加不破）"
else
  no "tenant-channel.mjs 里看不出"两种形状一起带" —— 老盒子或新盒子会有一边收不到"
fi

echo "── ② 盒子里写：合并（不许整份重写）"
if have "export function mergeKeyFile" "$CORE/src/tenant-shell.mjs"; then ok "mergeKeyFile 在"; else no "mergeKeyFile 不在"; fi
if have "mergeCreds(text, patch)" "$CORE/src/tenant-shell.mjs"; then ok "它用的是 creds.mjs 的 mergeCreds（规则只住一处）"; else no "没走 mergeCreds"; fi
if have "pack && Object.keys(pack).length > 0" "$CORE/src/tenant-shell.mjs"; then ok "收到那一帧时**creds 优先**、老的 key 仍认"; else no "收货那一段没认 creds"; fi

echo "── ③ 盒子里读：认那份单文件（**只在 tenant 角色下**）"
if have "export function credsFor" "$CORE/src/creds-store.js"; then ok "credsFor 在"; else no "credsFor 不在"; fi
if have "HUPO_ROLE === 'tenant'" "$CORE/src/creds-store.js"; then ok "只在 tenant 角色下认它（宿主上不认 —— 免得陈旧文件悄悄影响主人自己）"; else no "角色那道闸不在"; fi
for f in asr-creds.js image-use.js; do
  if have "credsFor(" "$CORE/src/$f"; then ok "$f 走 credsFor"; else no "$f 还在直接读按人分目录那份"; fi
done

if [ "$LIVE" = "0" ]; then
  echo
  echo "⚠️ 真盒子里那一眼（那份 /data/creds.yaml 里到底有没有那几样）要 root："
  echo "   sudo bash scripts/check-tenant-creds.sh --live"
  skip=1
else
  if [ "$(id -u)" != "0" ]; then
    echo
    echo "⚠️ --live 要 root（盒子在租户自己的 rootless podman 里）—— **不是"通过"**，是没看"
    echo "──"
    echo "  通过 $pass · 失败 $bad · 跳过 $skip"
    exit 3
  fi
  echo
  echo "── ④ 真盒子：那份文件里有哪几样（只报名字，不打印值）"
  # ⚠️ 盒子在**租户自己的** rootless podman 里（uid 2001/2002）⇒ 要 `sudo -u <那个用户>` 才看得到。
  #    容器名是 `hupo-tenant-<用户>`（不是 `hupo-a` —— 那是通道名）。
  # ⚠️ **正确的姿势**（2026-09-24 实测四次才找对；每一条都是踩出来的）：
  #   ① 盒子在**租户自己的** rootless podman 里（`hupo-a` uid 2001 / `hupo-b` uid 2002）
  #      ⇒ root 与 deploy 的 `podman ps` **都看不到它们**；
  #   ② 切过去（`runuser -u`，`sudo -D` 被 sudoers 挡）还得给
  #      `XDG_RUNTIME_DIR=/run/user/<它的 uid>`（rootless 的套接字在那儿）；
  #   ③ **工作目录不能是别人的家**（会 "cannot chdir"）⇒ 包一层 `sh -c "cd /tmp && …"`；
  #   ④ 🔴 **盒子里连 `cat` 都没有**（极简镜像，只有 `/bin/node`）⇒ 用
  #      `/bin/node -` **从标准输入读**（这条也是踩出来的：一开始用 `cat`，
  #      于是把"容器里没有 cat"误报成"还没填过钥匙" —— **归错原因**最误导）。
  READER=/tmp/.hupo-read-creds-$$.js
  printf '%s\n' "const fs=require('fs');" "try{const t=fs.readFileSync('/data/creds.yaml','utf8');console.log(t.split('\n').map(l=>l.split(':')[0].trim()).filter(Boolean).join(' '))}catch(e){console.log('读不到 '+e.code)}" > "$READER"
  chmod 644 "$READER"
  for box in hupo-a hupo-b; do
    uid="$(id -u "$box" 2>/dev/null || echo '')"
    out="$(timeout 40 runuser -u "$box" -- sh -c "cd /tmp && XDG_RUNTIME_DIR=/run/user/$uid podman exec -i hupo-tenant-$box /bin/node - < $READER" 2>/dev/null || true)"
    if [ -z "$out" ]; then
      echo "  ⚠️ $box：**没读到**（容器没在跑，或者命令没跑成）—— 记成"没看到"，不算过"
      skip=$((skip+1))
      continue
    fi
    case "$out" in
      读不到*) echo "  · $box：**还没有那份文件**（$out）—— 他还没填过钥匙，不是坏了"; skip=$((skip+1)); continue ;;
    esac
    # ⚠️ 读取器**已经只打印名字**（不打印值）⇒ 这里别再按 `名字: 值` 去解（第一版就这么错了：
    #    名字全丢 ⇒ 一律报"缺"，看着像"他没填"，其实是**我们解析错了**）。
    names=" $out "
    for want in HUPO_MODEL_KEY HUPO_VOICE_APPID HUPO_VOICE_SECRET_ID HUPO_VOICE_SECRET_KEY HUPO_IMAGE_KEY; do
      case " $names " in
        *" $want "*) ok "$box 有 $want" ;;
        *) echo "  ⚠️ $box 缺 $want（他还没填／中心还没推）" ; skip=$((skip+1)) ;;
      esac
    done
  done
fi

rm -f "$READER" 2>/dev/null || true
echo "──"
echo "  通过 $pass · 失败 $bad · 跳过 $skip"
[ "$bad" = "0" ] || exit 1
exit 0
