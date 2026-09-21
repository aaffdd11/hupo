#!/usr/bin/env bash
# **那"最后一寸"**：申请文件到底会不会把助手叫起来（契约 `43-AUTO-PROVISION.md` §四 ⑤）。
#
# 用法：
#   sudo bash scripts/check-provision-trigger.sh
#
# ── 为什么要单独验这一条 ────────────────────────────────────
# 整套设计里有一处**一直在被假设、从来没被验过**：
#
#     `DirectoryNotEmpty=` + `PathChanged=` 这两个 `.path` 条件，
#     真的会在"投放口多了一个文件"时把那个 oneshot 服务拉起来吗？
#
# 它错的话，**签字装完之后才发现** —— 而那正是我们最不想的时机。
# ⇒ 用一对**临时探针单元**在这台机器的**真 systemd** 上试，跑完**撤干净并自证**。
#
# ── 🔴 量出来的真语义（2026-09-21，就是这一条判据量出来的）──────
# 我原来以为：DirectoryNotEmpty 管"从空变非空"、PathChanged 管"已经有东西了、又来了一个"。
# **那是错的。** 探针实测：
#
#     · DirectoryNotEmpty **会反复触发** —— 投放口里留一个文件不动，
#       服务被拉起 **5 次**，然后撞上 systemd 的**启动限速**（默认 10 秒内 5 次）；
#     · 所以它**自己就**覆盖了"又来一个"那一半（不需要靠 PathChanged）；
#     · 🔴 **而它的反面是要命的**：只要投放口里**留下任何东西**（比如失败标记），
#       它就会一直触发到限速 ⇒ 单元进 `failed` ⇒ **之后的新申请没人管了**。
#
# ⇒ 由此改了两处设计：**投放口里只许有待办申请**，失败标记搬到旁边的目录。
#   这一条判据把上面每一条都**量出来**（而不是写在注释里当信条）。
#
# ── 这一份验六件 ────────────────────────────────────────────
#   ① tmpfiles.d 那一行真的产出 **1733**（不是"我写了 1733"）；
#   ② 从空变非空 ⇒ 拉起，而且**收尾之后不重复**（探针模拟助手的收尾）；
#   ③ 已经非空时又来一个 ⇒ **也**拉起；
#   ④ 起来时投放口里**已经有待办**（开机那一种）⇒ 也拉起；
#   ⑤ 🔴 **反面**：处理完**留了东西** ⇒ **反复触发**（这就是标记必须搬走的原因）；
#   ⑥ 撤干净，并**自证**这台机器上什么都没留下。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${HUPO_SERVICE_USER:-deploy}"
id "$SERVICE_USER" >/dev/null 2>&1 || SERVICE_USER="$(stat -c %U "$ROOT")"

if [ "$(id -u)" != "0" ]; then
  echo "✗ 这个判据要 root（它要临时装一对单元、再撤掉）。请：sudo bash $0"; exit 2
fi
command -v systemctl >/dev/null 2>&1 || { echo "✗ 这台机器上没有 systemctl"; exit 2; }

# ⚠️ 全部用**探针专用**的名字与路径，跟真那条路一点不重名
P_DIR="/tmp/hupo-probe-watch"
P_LOG="/tmp/hupo-probe.log"
P_PATH_UNIT="/etc/systemd/system/hupo-probe.path"
P_SVC_UNIT="/etc/systemd/system/hupo-probe.service"
P_TMPFILES="/etc/tmpfiles.d/hupo-probe.conf"
P_TMP_DIR="/run/hupo-probe-tmpfiles"

pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1"; fail=$((fail + 1)); }

# ── **真机状态指纹**：跑判据**之前**记一份，跑完再比 ──────────────────
# ⚠️ 为什么需要它（2026-09-21 **装上之后**才发现的）：这几份判据原来断言的是
#    "真机上那几处**一处都没有**" —— 那只在**还没装**的时候成立。
#    装上之后它们集体报红，而**真机上什么都没有被这次测试改动**。
#    ⇒ 正确的问题是"**这次测试有没有改动真机**"，不是"真机上有没有东西"。
#    记一份指纹（路径 + 属主/权限 + 内容哈希 + 投放口条目数 + 单元状态），
#    跑完逐字比 —— 这样**装之前装之后都成立**。
real_state() {
  {
    for f in /usr/local/libexec/hupo/*.sh /etc/hupo/tenant-template.conf \
             /etc/systemd/system/hupo-provision.path /etc/systemd/system/hupo-provision.service \
             /etc/tmpfiles.d/hupo-provision.conf; do
      [ -e "$f" ] || continue
      printf '%s %s %s\n' "$f" "$(stat -c '%U:%G:%a' "$f")" "$(sha256sum "$f" | cut -c1-16)"
    done
    printf 'req-entries=%s\n' "$(ls -A /run/hupo-provision 2>/dev/null | wc -l)"
    printf 'tenants=%s\n' "$(getent passwd | awk -F: '/^hupo-/{print $1}' | sort | tr '\n' ',')"
    printf 'path=%s\n' "$(systemctl is-active hupo-provision.path 2>/dev/null || echo none)"
  } 2>/dev/null
}

REAL_BEFORE="$(real_state)"

cleanup() {
  systemctl disable --now hupo-probe.path >/dev/null 2>&1 || true
  systemctl stop hupo-probe.service >/dev/null 2>&1 || true
  # ⚠️ --remove 要在**删掉那个配置文件之前**跑（它是照着文件里的路径去删的）
  systemd-tmpfiles --remove "$P_TMPFILES" >/dev/null 2>&1 || true
  rm -f "$P_PATH_UNIT" "$P_SVC_UNIT" "$P_TMPFILES"
  rm -rf "$P_DIR" "$P_LOG" "$P_TMP_DIR"
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl reset-failed hupo-probe.service >/dev/null 2>&1 || true
}
trap cleanup EXIT

n_runs() { grep -c '' "$P_LOG" 2>/dev/null || echo 0; }
wait_runs() {  # 等它跑到至少 want 次（最多 20 秒）
  local want="$1" i
  for i in $(seq 1 40); do
    [ "$(n_runs)" -ge "$want" ] && return 0
    sleep 0.5
  done
  return 1
}
runs_after() { sleep "$1"; n_runs; }

write_units() {  # write_units <服务要不要收尾（把文件删掉）>
  local tidy="$1"
  if [ "$tidy" = "1" ]; then
    cat > "$P_SVC_UNIT" <<'EOF'
[Unit]
Description=琥珀 · 探针（模拟助手的收尾：干完把申请删掉）
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'date +%%s >> /tmp/hupo-probe.log; rm -f /tmp/hupo-probe-watch/*.req'
EOF
  else
    cat > "$P_SVC_UNIT" <<'EOF'
[Unit]
Description=琥珀 · 探针（**故意不收尾**：留着东西不删）
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'date +%%s >> /tmp/hupo-probe.log'
EOF
  fi
  cat > "$P_PATH_UNIT" <<EOF
[Unit]
Description=琥珀 · 探针（看一眼那个投放口）
[Path]
DirectoryNotEmpty=$P_DIR
PathChanged=$P_DIR
Unit=hupo-probe.service

[Install]
WantedBy=paths.target
EOF
  mkdir -p "$P_DIR"; chmod 0755 "$P_DIR"
  systemctl daemon-reload
  systemctl reset-failed hupo-probe.service >/dev/null 2>&1 || true
}
restart_path() {  # 先停、清空投放口（让它"武装"起来）、再起
  systemctl stop hupo-probe.path >/dev/null 2>&1 || true
  rm -f "$P_DIR"/*; rm -f "$P_LOG"
  systemctl start hupo-probe.path >/dev/null 2>&1
  sleep 1
}

# ══════════════════════════════════════════════════════════════════
echo "① tmpfiles.d 那一行真的产出 **1733**（不是「我写了 1733」）"
# ══════════════════════════════════════════════════════════════════
printf 'd %s 1733 root %s -\n' "$P_TMP_DIR" "$SERVICE_USER" > "$P_TMPFILES"
systemd-tmpfiles --create "$P_TMPFILES" >/dev/null 2>&1 || true
if [ -d "$P_TMP_DIR" ]; then
  got="$(stat -c '%a %U:%G' "$P_TMP_DIR")"
  if [ "$got" = "1733 root:$SERVICE_USER" ]; then ok "产出的是 $got"; else bad "产出的是 $got（期望 1733 root:$SERVICE_USER）"; fi
  as_user() { sudo -u "$SERVICE_USER" -H sh -c 'cd /tmp && exec "$@"' sh "$@"; }
  if as_user sh -c ": > $P_TMP_DIR/放得下.txt" 2>/dev/null; then ok "服务那个身份**放得进**文件"; else bad "服务那个身份**放不进**文件（那这条路就不通了）"; fi
  if as_user ls "$P_TMP_DIR" >/dev/null 2>&1; then
    bad "服务那个身份**列得出**目录内容（1733 的语义是列不出 —— 值得看一眼）"
  else
    ok "服务那个身份**列不出**目录内容（1733 的语义）"
  fi
else
  bad "$P_TMP_DIR 没被建出来 —— tmpfiles 那一行有问题"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "② 从空变非空 ⇒ 拉起；而且**收尾之后不重复**（探针模拟助手：干完把申请删掉）"
# ══════════════════════════════════════════════════════════════════
write_units 1
restart_path
: > "$P_DIR/1.req"
if wait_runs 1; then ok "第 1 个文件 ⇒ 服务被拉起来了"; else bad "第 1 个文件**没**把服务拉起来"; fi
k="$(runs_after 6)"
if [ "$k" = "1" ]; then
  ok "**收尾之后不重复**（6 秒后还是 1 次）—— 这正是「投放口里只许有待办申请」的回报"
else
  bad "收尾之后还跑了 $k 次（投放口都空了却还在触发？）"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "③ 已经非空时又来一个 ⇒ **也**拉起（设计里点名的情形：第 1 张还在飞、第 2 个号也来了）"
# ══════════════════════════════════════════════════════════════════
: > "$P_DIR/2.req"
if wait_runs 2; then ok "第 2 个文件 ⇒ 服务**又**被拉起来了一次"; else bad "第 2 个文件**没有**触发 —— 那「第 2 个号也来了」就没人管"; fi

# ══════════════════════════════════════════════════════════════════
echo
echo "④ 起来时投放口里**已经有待办**（开机那一种）⇒ 也拉起"
# ══════════════════════════════════════════════════════════════════
# ⚠️ 这一条是 DirectoryNotEmpty 那一行**存在的理由**：
#    开机时如果有一张申请躺在那里，**没有"变化"可听** —— 只有"目录非空"这个条件会响。
systemctl stop hupo-probe.path >/dev/null 2>&1 || true
rm -f "$P_LOG"; : > "$P_DIR/3.req"          # 先放好，再起
systemctl start hupo-probe.path >/dev/null 2>&1
if wait_runs 1; then ok "带着待办起来 ⇒ 拉起了"; else bad "带着待办起来**没**拉起 —— 那 DirectoryNotEmpty 那一行没起作用"; fi

# ══════════════════════════════════════════════════════════════════
echo
echo "⑤ 🔴 反面：处理完**留了东西**在投放口里 ⇒ **反复触发**（这就是标记必须搬走的原因）"
# ══════════════════════════════════════════════════════════════════
write_units 0                               # 探针改成"不收尾"
restart_path
: > "$P_DIR/4.req"
if wait_runs 1; then ok "（前提）它跑起来了"; else bad "（前提）没跑起来 ⇒ 下面那半说明不了什么"; fi
k="$(runs_after 8)"
if [ "$k" -gt 1 ]; then
  ok "留了东西不删 ⇒ **反复触发**（8 秒里跑了 $k 次）—— 所以失败标记**不能**放在投放口里"
else
  bad "留了东西却只跑了 $k 次 —— 那与量出来的语义不符，值得重看一次"
fi

# ══════════════════════════════════════════════════════════════════
echo
echo "⑥ 撤干净，而且**自证**没留东西"
# ══════════════════════════════════════════════════════════════════
cleanup
trap - EXIT
stray=0
for p in "$P_PATH_UNIT" "$P_SVC_UNIT" "$P_TMPFILES" "$P_DIR" "$P_LOG" "$P_TMP_DIR"; do
  [ -e "$p" ] && { bad "没撤干净：$p"; stray=1; }
done
if systemctl list-unit-files 2>/dev/null | grep -q '^hupo-probe'; then bad "还留着 unit file"; stray=1; fi
[ "$stray" = "0" ] && ok "探针那几样**一样都没留下**（单元 / tmpfiles / 目录 / 日志）"
# ⚠️ 同上：比"有没有改动"，不比"有没有装"（2026-09-21 装上之后才发现的）
if [ "$(real_state)" = "$REAL_BEFORE" ]; then
  ok "真那条路的状态与跑之前**逐字相同**（它装没装都不该被这一条判据动到）"
else
  bad "真那条路被这一条判据改了："
  diff <(printf '%s\n' "$REAL_BEFORE") <(real_state) | sed 's/^/      /'
fi

echo
echo "──────────────────────────────"
if [ "$fail" = "0" ]; then
  echo "✅ 全过（$pass 条）—— 最后一寸验掉了，而且**量出了真语义**："
  echo "   · DirectoryNotEmpty **会反复触发**（所以投放口必须保持「只放待办」）；"
  echo "   · 它自己就覆盖了「又来一个」那一半，还管「带着待办开机」那一种；"
  echo "   · 投放口里**留下任何东西**都会触发到限速 ⇒ 单元 failed ⇒ 之后的新申请没人管。"
  exit 0
else
  echo "✗ 没过 $fail 条（过 $pass 条）"
  exit 1
fi
