#!/usr/bin/env bash
# 容器那几条**可执行验收**（手册 `08-SPEC.md` §13.1 的 V1 / V1b / V3 / V4）。
#
# 用法：
#   bash scripts/check-container.sh              # 跑（镜像不在就自己造一个）
#   HUPO_CONTAINER_IMAGE=xxx bash scripts/check-container.sh
#
# ── 为什么要有这个脚本 ────────────────────────────────────────
# 手册原话：这几条**必须逐条跑，不许"看起来没问题"**，而且
# **一票否决：不许用"这是本机 / 测试环境"当理由降级通过**。
# 在 2026-09-21 之前，这几条**一条都没跑过**（本机原先做不了容器）。
#
# ── 本机的实测前提（都量过，不是照手册抄的）─────────────────────
#   · `docker` 装了、守护进程也在，但 **`deploy` 不在 docker 组**
#     ⇒ 连不上套接字；而"加进 docker 组"**≡ 交出 root**，被 P2.2 永久否决
#     （`test/reverse-drift.test.js` 有一条硬闸盯着 `usermod`）。
#   · ⇒ 走**无根 podman**：实测 `Rootless=true`、`podman unshare` 通、
#     subuid/subgid 已配、cgroup v2 且 memory 已委托 ⇒ 能设上限。
#   · ⚠️ **Docker Hub 从这台机器连不上**（IPv4/IPv6 都不通；npm 通）。
#     ⇒ 镜像**不拉**，用宿主自己的**静态 busybox** 现造一个最小 rootfs
#       （`buildah from scratch`）—— 这条链**不碰任何 registry**。
#
# ⚠️ **这个镜像不是最终那个容器**：它只用来把"agent 与宿主"这几条判据跑出来。
#    "第二个用户"那一半（用户之间互相看不见）**不在这个脚本里**，也**还没验**。

set -uo pipefail

PODMAN="${PODMAN_BIN:-/usr/bin/podman}"
BUILDAH="${BUILDAH_BIN:-/usr/bin/buildah}"
IMG="${HUPO_CONTAINER_IMAGE:-localhost/hupo-base:local}"
BUSYBOX="${HUPO_BUSYBOX:-/bin/busybox}"

bad=0
ok()   { echo "  ✓ $1"; }
no()   { echo "  ✗ $1"; bad=1; }
note() { echo "  · $1"; }

# ── 0) 前提 ──────────────────────────────────────────────────
echo "▶ 0) 前提"
for bin in "$PODMAN" "$BUILDAH"; do
  [ -x "$bin" ] || { no "找不到 $bin（无根容器这条路要它）"; exit 2; }
done
rootless="$("$PODMAN" info --format '{{.Host.Security.Rootless}}' 2>/dev/null)"
[ "$rootless" = "true" ] && ok "podman 是**无根**模式（不是 root）" || no "podman 不是无根模式（$rootless）—— 那这条链的前提就变了"
[ -f "$BUSYBOX" ] || { no "找不到静态 busybox：$BUSYBOX（造镜用它，不联网）"; exit 2; }
file "$BUSYBOX" | grep -q "statically linked" && ok "busybox 是静态链接的（一个文件就能当 rootfs）" || no "busybox 不是静态链接"

# ── 1) 镜像：不在就现造（**不碰 registry**）────────────────────
echo "▶ 1) 镜像"
if "$PODMAN" image exists "$IMG" 2>/dev/null; then
  ok "镜像已在：$IMG"
else
  note "镜像不在 ⇒ 用静态 busybox 现造一个（不联网）"
  R="$(mktemp -d)"
  mkdir -p "$R/bin" "$R/proc" "$R/tmp"
  cp "$BUSYBOX" "$R/bin/busybox"
  for a in sh touch env grep cat ls id pwd nc wget; do ln -sf busybox "$R/bin/$a"; done
  ctr="$("$BUILDAH" from scratch)"
  "$BUILDAH" copy "$ctr" "$R/" / >/dev/null
  "$BUILDAH" config --cmd '/bin/sh' "$ctr"
  "$BUILDAH" commit "$ctr" "$IMG" >/dev/null
  "$BUILDAH" rm "$ctr" >/dev/null
  rm -rf "$R"
  "$PODMAN" image exists "$IMG" && ok "造好了：$IMG" || { no "镜像没造出来"; exit 2; }
fi

run() { "$PODMAN" run --rm "$IMG" /bin/sh -c "$1" 2>/dev/null; }

# ── 2) V1b（**负向对照，不能省**）──────────────────────────────
# ⚠️ 手册点名：没有它，V1 的"失败"什么都证明不了（可能只是容器根本没跑起来）。
echo "▶ 2) V1b 负向对照：容器里写 /tmp 必须**成功**"
if run 'touch /tmp/canary && echo YES' | grep -q YES; then
  ok "容器真的在跑，而且里面写得进东西 ⇒ 下面 V1 的'失败'有意义"
else
  no "容器里连 /tmp 都写不了 ⇒ **后面几条的结论全部作废**（先修这个）"
  echo; echo "❌ 前提不成立"; exit 2
fi

# ── 3) V1：宿主凭据读不到 ─────────────────────────────────────
echo "▶ 3) V1：读宿主凭据（/proc/1/root/...）必须**失败**"
out="$(run 'cat /proc/1/root/home/deploy/.ssh/id_rsa 2>&1; echo "RC=$?"')"
if echo "$out" | grep -q "RC=0"; then
  no "★ 读到了宿主的东西 —— 这是**一票否决**：$out"
else
  ok "读不到（rc≠0）"
fi
# ⚠️ 负向对照之二：`/proc/1/root` 必须是**容器自己的**根，不是宿主的
lsroot="$(run 'ls /proc/1/root/ 2>/dev/null | tr "\n" " "')"
case "$lsroot" in
  *home*|*root*) no "★ /proc/1/root 里出现了宿主的目录：$lsroot" ;;
  *) ok "/proc/1/root 是容器自己的根（看到的是：${lsroot:-（空）}）" ;;
esac

# ── 4) V3：元数据地址不通（**带正对照**）──────────────────────
echo "▶ 4) V3：访问 169.254.169.254 必须**失败**"
# ⚠️ 先证明"容器有网"：没有网的话，这条"失败"什么都证明不了（空跑）。
# ⚠️ 而且**一个目标不够**：实测 `1.1.1.1:443` 在这条链路上不通（可能是上游挡了 ICMP/那些网段），
#    而 `registry.npmjs.org:443` 通 —— 只试一个会得出"容器没网"的错结论。
#    ⇒ 试几个，**任何一个通**就算"有网"，并把它报出来（让读的人看得见证据是哪一条）。
NET_TARGET=""
for t in "registry.npmjs.org 443" "1.1.1.1 443" "10.0.2.3 53"; do
  set -- $t
  if run "nc -w 5 $1 $2 </dev/null >/dev/null 2>&1; echo RC=\$?" | grep -q "RC=0"; then
    NET_TARGET="$1:$2"; break
  fi
done
if [ -n "$NET_TARGET" ]; then
  ok "正对照：容器**有**对外网络（连上了 $NET_TARGET）⇒ 下面那条不是空跑"
else
  note "⚠️ 三个目标都不通 ⇒ 下面那条'失败'**可能是没网**，不是元数据被挡（这条判据今天算不了）"
fi
if run 'nc -w 4 169.254.169.254 80 </dev/null >/dev/null 2>&1; echo RC=$?' | grep -q "RC=0"; then
  no "★ 通到了云元数据地址（一票否决）"
else
  ok "不通"
fi

# ── 5) V4：密钥不许出现在容器里 ───────────────────────────────
echo "▶ 5) V4：密钥 = 0"
n="$(run 'env | grep -cE "(_API_KEY|_TOKEN|_SECRET|DEEPSEEK)"' | tr -d '[:space:]')"
[ "${n:-x}" = "0" ] && ok "环境变量里命中 0 个" || no "环境里出现了 $n 个可疑变量名"
# ⚠️ 这一半**只有在真的挂了 /data /home 时才有意义**：最小镜像里那两个目录根本不存在，
#    `grep -rl ... /data /home` 必然是 0 —— 那是**空跑**，不是通过。
if run 'ls -d /data /home >/dev/null 2>&1; echo RC=$?' | grep -q "RC=0"; then
  h="$(run 'grep -rl "sk-" /data /home 2>/dev/null | wc -l' | tr -d '[:space:]')"
  [ "${h:-x}" = "0" ] && ok "/data 与 /home 里 sk- 命中 0 个" || no "/data 或 /home 里有 $h 个文件含 sk-"
else
  note "⚠️ 镜像里没有 /data 与 /home ⇒ **这一半今天验不了**（空跑不算通过）；"
  note "   要验它得把真实那套挂载摆进来（那是容器本体那一批的事）"
fi

echo
if [ "$bad" = "0" ]; then
  echo "✅ 通过（V1 / V1b / V3 / V4 的环境那一半）"
  echo "⚠️ 没验的：用户之间、资源上限、真实挂载下的 V4 —— 见 docs/dev/34-CONTAINER.md"
  exit 0
fi
echo "❌ 有判据没过（一票否决的尤其要看）"
exit 1
