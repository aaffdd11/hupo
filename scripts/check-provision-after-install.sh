#!/usr/bin/env bash
# **装完特权侧之后才验得了的那两条**（契约 `docs/dev/43-AUTO-PROVISION.md` §五）：
#
#   ⑥ A6：装完之后，服务那个身份的**三条**与**装之前**记下来的基线**逐字相同**
#   ① 真建一台：一个新号登录 ⇒ 他那台**真的被建出来**、容器起来、隧道通、状态到 ready
#
# 用法：
#   bash scripts/check-provision-after-install.sh                  # 只验 A6（现在就能跑）
#   sudo bash scripts/check-provision-after-install.sh --phone 13800000000
#                                                                 # 再真建一台（装了之后）
#
# ── ⚠️ A6 的基线**必须在装之前**记下来 ─────────────────────
# 基线在 `v2/services/core/data/provision-identity-baseline.txt`（机器本地、不进仓库）。
# 🔴 **装完再记就成了"自己跟自己比"** —— 所以这份基线是**装之前**写下的。
# 基线不在 ⇒ 这一条**如实说"验不了"**，**不许**当成过了。
#
# ── ⚠️ `--phone` 会真的建一个号 ─────────────────────────────
# 它会用那个手机号登录（= 在 `users.json` 里建一个用户 + 给他建一台容器）。
# 所以**号码由你给**，脚本不替你编一个。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${HUPO_SERVICE_USER:-deploy}"
BASELINE="${HUPO_IDENTITY_BASELINE:-$ROOT/v2/services/core/data/provision-identity-baseline.txt}"
CONF="$ROOT/v2/services/core/tenant-template.conf"
LIBEXEC="/usr/local/libexec/hupo"
REQ_DIR="/run/hupo-provision"
PHONE=""
WAIT_S="${HUPO_BUILD_WAIT_S:-180}"

while [ $# -gt 0 ]; do
  case "$1" in
    --phone) shift; PHONE="${1:-}" ;;
    *) echo "✗ 不认识的参数：$1"; exit 2 ;;
  esac
  shift
done

pass=0; fail=0; skipped=0
ok()   { echo "  ✓ $1"; pass=$((pass + 1)); }
bad()  { echo "  ✗ $1"; fail=$((fail + 1)); }
skip() { echo "  · $1"; skipped=$((skipped + 1)); }

tpl_get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CONF" | head -1; }
NAME_PREFIX="$(tpl_get name_prefix)"
UID_BASE="$(tpl_get uid_base)"
MAX_TENANTS="$(tpl_get max_tenants)"

echo "── 服务那个身份：$SERVICE_USER"
echo "── 基线：$BASELINE"
echo

# ══════════════════════════════════════════════════════════════════
echo "⑥ A6：装完之后，身份三条与**装之前**逐字相同"
# ══════════════════════════════════════════════════════════════════
# ⚠️ 这一节**现在就能跑**（装之前跑 = 基线跟自己比，必然是过的）——
#    它的意义在**装完之后再跑一次**：那时候它比的是"装之前那个样子"。
#    所以它是**同一条判据的两次测量**，不是两次不同的判据。
if [ ! -f "$BASELINE" ]; then
  bad "基线不在（$BASELINE）⇒ **A6 验不了**（装完再记就成了自己跟自己比）"
else
  # 只取基线里那三条**事实**，不取注释与时间戳
  facts() { sed -n '/^--- /,$p' "$1"; }
  # ⚠️ **这三条必须与"谁在跑这个判据"无关**（2026-09-21 判据自己抓到的）：
  #    `sudo -l -U deploy` 在 **root** 下会打印出 sudoers 规则，
  #    而在 deploy 下打印的是 `sudo: a password is required` —— **两种输出**。
  #    基线是以 deploy 身份记的 ⇒ 之后**用 root 跑一次判据就会假警报**，
  #    而假警报很快就会被下一个人绕开（那就等于没有这条闸）。
  #    ⇒ 固定成"以服务身份、非交互地问一句"，两种调用者下都得到同一行。
  sudo_line() { sudo -u "$SERVICE_USER" -H sudo -n -l 2>&1 | tail -1; }
  now="$( { echo "--- id ---"; id "$SERVICE_USER";
             echo "--- sudo（tail）---"; sudo_line;
             echo "--- docker 组 ---"; getent group docker 2>/dev/null || echo "（没有这个组）"; } )"
  if [ "$(facts "$BASELINE")" = "$now" ]; then
    ok "三条**逐字相同**（$(grep '^--- ' "$BASELINE" | sed 's/^--- *//; s/ *---$//' | tr '\n' ' '))"
  else
    bad "🔴 身份**变了** —— 装这一下动了不该动的东西"
    diff <(facts "$BASELINE") <(printf '%s\n' "$now") | sed 's/^/      /'
  fi
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "装完了没有"
# ══════════════════════════════════════════════════════════════════
INSTALLED=1
[ -x "$LIBEXEC/provision-tenant-request.sh" ] || INSTALLED=0
if [ "$INSTALLED" = "0" ]; then
  skip "**还没装**（$LIBEXEC 不在）⇒ 下面两条等主人签字"
  echo
  echo "──────────────────────────────"
  echo "（只验了 A6 的基线那一半：过 $pass、没过 $fail、跳过 $skipped）"
  echo "⏳ 要真建一台：先 sudo bash scripts/install-provision-helper.sh --yes"
  exit 0
fi
if [ "$(id -u)" != "0" ]; then
  bad "装了，但后面几条要 root：请加 sudo 再跑一次"
  exit 1
fi
ok "装着了"
if [ "$(stat -c '%U' "$LIBEXEC/provision-tenant-request.sh")" = "root" ]; then
  ok "root 要跑的那几份是 root 拥有的（A9）"
else
  bad "🔴 root 要跑的那份**不是** root 拥有的 —— A9 破了"
fi
if systemctl is-active hupo-provision.path >/dev/null 2>&1; then
  ok "投放口那条路起着了（.path active）"
else
  bad "投放口那条路**没起**（systemctl status hupo-provision.path）"
fi
if bash "$ROOT/scripts/install-provision-helper.sh" --check >/dev/null 2>&1; then
  ok "仓库那份与装着那份**一致**（root 跑的就是仓库里这一份）"
else
  bad "🔴 两份**不一致** —— 改了仓库但没重装（root 跑的还是旧的）"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "① 真建一台（一个**新号**登录 ⇒ 他那台真的被建出来）"
# ══════════════════════════════════════════════════════════════════
if [ -z "$PHONE" ]; then
  skip "没给 --phone ⇒ 这一条**没验**（不是过了）"
else
  # ⚠️ 先记下**这次之前**已经有哪几台 —— 跑完要自证"只多了一台"
  before="$(getent passwd | awk -F: -v p="$NAME_PREFIX" '$1 ~ "^"p"[0-9]+$" {print $1}' | sort | tr '\n' ' ')"
  echo "  建之前已有的租户：${before:-（没有）}"

  # 用**服务自己那条路**登录（就是用户会做的事）
  login_json="$(curl -s -X POST -H 'content-type: application/json' \
      -d "{\"phone\":\"$PHONE\",\"code\":\"${HUPO_DEV_CODE:-}\"}" \
      http://127.0.0.1:8020/api/login)"
  token="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' <<<"$login_json")"
  if [ -z "$token" ]; then
    bad "登录没成：$(cut -c1-160 <<<"$login_json")"
  else
    ok "用 $PHONE 登录成了（是不是新号他那边会说）"
    state=""
    t0="$(date +%s)"
    while [ $(( "$(date +%s)" - t0 )) -lt "$WAIT_S" ]; do
      space="$(curl -s -H "Authorization: Bearer $token" http://127.0.0.1:8020/api/space)"
      state="$(sed -n 's/.*"state":"\([^"]*\)".*/\1/p' <<<"$space")"
      case "$state" in
        ready|full) break ;;
      esac
      sleep 3
    done
    # 他那个号是第几号 —— 从 `/api/space` 的 kind 与用户表里推不出来，
    # 所以直接看"建之前 vs 现在"多了哪一台（**那才是这台机器的真相**）
    after="$(getent passwd | awk -F: -v p="$NAME_PREFIX" '$1 ~ "^"p"[0-9]+$" {print $1}' | sort | tr '\n' ' ')"
    new_tenants="$(comm -13 <(tr ' ' '\n' <<<"$before" | sort) <(tr ' ' '\n' <<<"$after" | sort) | grep -v '^$' | tr '\n' ' ')"
    echo "  状态：${state:-（一直没到终态，等了 ${WAIT_S}s）} ｜ 建之后：${after:-（没有）}"

    if [ -z "$new_tenants" ]; then
      bad "🔴 **一台都没多出来** —— 申请没变成容器（看 journalctl -u hupo-provision.service）"
    else
      n_new="$(wc -w <<<"$new_tenants")"
      if [ "$n_new" != "1" ]; then
        bad "🔴 多出来 $n_new 台（$new_tenants）—— 一次申请只该建一台"
      else
        ok "只多了一台：$new_tenants"
      fi
      t="${new_tenants%% *}"
      t_uid="$(id -u "$t" 2>/dev/null || echo '?')"
      t_n="${t#"$NAME_PREFIX"}"
      want_uid=$((UID_BASE + t_n))
      if [ "$t_uid" = "$want_uid" ]; then ok "他的名字与编号对得上模板（$t ⇒ uid $t_uid）"; else bad "$t 的 uid 是 $t_uid，模板说该是 $want_uid"; fi
      home="$(getent passwd "$t" | cut -d: -f6)"
      if [ "$(stat -c '%a %U:%G' "$home/tenant" 2>/dev/null)" = "700 $t:$t" ]; then
        ok "他那份卷 ⇒ 700 $t:$t（别人读不到）"
      else
        bad "卷不对：$(stat -c '%a %U:%G' "$home/tenant" 2>/dev/null || echo '不在')"
      fi
      if [ -f "/var/lib/systemd/linger/$t" ]; then ok "linger 开着（他没登录时容器也在）"; else bad "linger 没开"; fi
      if [ -S "/run/hupo-channel/$t/channel.sock" ]; then ok "宿主在替他听那条通道"; else bad "通道没在听（/run/hupo-channel/$t/）"; fi
      if sudo -u "$t" -H sh -c 'cd /tmp && exec env XDG_RUNTIME_DIR="/run/user/$(id -u)" podman ps --format "{{.Status}}"' 2>/dev/null | grep -qi up; then
        ok "他那台容器在跑"
      else
        bad "容器没跑起来（journalctl --user -u hupo-tenant.service，看 $t 那一份）"
      fi
      if [ "$state" = "ready" ]; then
        ok "「我的空间到哪一步了」⇒ ready（三步全勾）"
      else
        bad "状态是 ${state:-（空）} —— 没到 ready"
      fi
    fi
  fi
fi

echo
echo "──────────────────────────────"
if [ "$fail" = "0" ]; then
  echo "✅ 全过（过 $pass、跳过 $skipped）"
  [ "$skipped" != "0" ] && echo "⚠️ **有跳过的**（上面写了是哪几条）—— 跳过的**不是**过的。"
  exit 0
else
  echo "✗ 没过 $fail 条（过 $pass、跳过 $skipped）"
  exit 1
fi
