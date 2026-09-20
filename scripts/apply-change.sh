#!/usr/bin/env bash
# P2 的"签字"那一步：把主人看过的那一个补丁应用成**一个 commit**，然后停下，等主人自己决定重启。
#
# 依据：手册 `06-OPERATIONS.md` §三（P2：助手只能提申请，签字的是主人）
#       · §8.3（重启必须是主人自己决定的一步）· `04-ROADMAP.md` 批 6「P2 apply 工具」
#       · `08-SPEC.md` §13.3 的 **V9**（跑完必须留下一个 commit）。
#
# 用法：
#   scripts/apply-change.sh <补丁文件> [--allow-dirty]
#   scripts/apply-change.sh -h
#
# ⚠️ 为什么补丁只能从 `proposals/` 里来：P2 甲的安全性全靠"主人真的看一眼"（§3.1），
#    而"一眼"只能落在一个文件上。允许从任意路径 apply，等于主人看的那份和真正生效的
#    那份可以不是同一份 —— 这条护栏就退化成"助手有 root，只是慢一点"。
#    `proposals/` 同时被 `.gitignore` 排除：不然申请文件本身就让仓库永远有未提交改动，
#    下面那道干净闸会变成永远过不去。
#
# ⚠️ 为什么要求仓库里没有未提交的改动：apply 之后那个 commit 必须**只包含这一个补丁**。
#    否则"回退一次"就不等于"退回这一步"，出事时主人没法用一句话恢复。
#    真需要带着别的改动跑，主人得自己显式说 `--allow-dirty`（那是他的签字，不是脚本替他做的）。
#
# ⚠️ 为什么这里**不重启**：§8.3 —— 直接重启会把正在说的那一轮连同回答一起杀掉，
#    用户看到话说一半没了。重启是主人自己决定的一步，所以这里只把"接下来做什么"
#    打印成一小块，不替他做。
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  scripts/apply-change.sh <补丁文件> [--allow-dirty]
  scripts/apply-change.sh -h

  <补丁文件>     必须位于仓库的 proposals/ 里（主人只看那一个文件）
  --allow-dirty  仓库里还有没提交的改动时也继续（那些改动会一起进这个 commit）
  -h             打印这段用法

做完会发生什么：改动 + 这份补丁的留档一起落成一个 commit；
**不会**重启服务 —— 重启的命令会打印出来，由主人自己跑。
EOF
}

ALLOW_DIRTY=0
PATCH_ARG=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -*)
      echo "✗ 不认识的选项：$arg" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$PATCH_ARG" ]; then
        echo "✗ 一次只处理一个补丁：已经给了 $PATCH_ARG，又多出 $arg" >&2
        exit 2
      fi
      PATCH_ARG="$arg"
      ;;
  esac
done

if [ -z "$PATCH_ARG" ]; then
  echo "✗ 没说要用哪个补丁。" >&2
  usage >&2
  exit 2
fi

# 仓库根：优先听主人的环境变量，否则按脚本自己的位置推（脚本在 <仓库根>/scripts/ 下）。
REPO="${HUPO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO" || { echo "✗ 进不去仓库根：$REPO" >&2; exit 1; }

# ── 1) 补丁必须来自 proposals/ ───────────────────────────────
# 用 realpath 而不是字符串前缀比较：软链、`..`、相对路径都能绕过前缀检查，
# 而这里要拦的恰恰是"主人看的那份"和"生效的那份"不是同一个文件。
PROP_DIR="$REPO/proposals"
if [ ! -d "$PROP_DIR" ]; then
  echo "✗ 没有 $PROP_DIR 这个目录。" >&2
  echo "  申请补丁必须放在仓库的 proposals/ 里（主人只看那一个文件）。" >&2
  echo "  先把这个目录建出来，再把要用的补丁放进去。" >&2
  exit 1
fi
PROP_REAL="$(realpath "$PROP_DIR")"

if [ ! -f "$PATCH_ARG" ]; then
  echo "✗ 找不到这个补丁文件：$PATCH_ARG" >&2
  exit 1
fi
PATCH_REAL="$(realpath "$PATCH_ARG")"

case "$PATCH_REAL" in
  "$PROP_REAL"/*) ;;
  *)
    echo "✗ 补丁不在 $PROP_REAL/ 里，拒绝应用。" >&2
    echo "  它现在指向：$PATCH_REAL" >&2
    echo "  只从 proposals/ 里取补丁，是为了让主人看的那一份就是真正生效的那一份。" >&2
    exit 1
    ;;
esac

# ── 2) 干净闸 ────────────────────────────────────────────────
# 放在 --check 之前：位置不对和仓库不干净是两回事，报错要说清是哪一种。
if [ -n "$(git status --porcelain)" ]; then
  if [ "$ALLOW_DIRTY" != "1" ]; then
    echo "✗ 仓库里还有没提交的改动，拒绝应用。" >&2
    echo "  那样 apply 之后的那个 commit 会混进别的东西，" >&2
    echo "  「回退一次」就不再等于「退回这一步」。先把它们提交或收起来；" >&2
    echo "  确实要带着它们跑，就自己显式加 --allow-dirty。" >&2
    git status --short >&2
    exit 1
  fi
fi

# ── 3) 先试后打 ──────────────────────────────────────────────
# --check 没过必须**什么都没改**地退出：主人看到失败时，仓库应当和他敲命令前一样。
if ! git apply --check "$PATCH_REAL"; then
  echo "✗ 这个补丁打不上（git apply --check 没过）。**什么都没改**。" >&2
  echo "  多半是仓库里那几行已经和补丁写的不一样了 —— 让助手重新出一份，别手工硬塞。" >&2
  exit 1
fi
git apply "$PATCH_REAL"

# ── 4) 把补丁本身留档，并进同一个 commit ─────────────────────
# 理由：`git log` 里该留下的不只有"结果"，还有"主人当时看的那份东西"。
# 归档名用 UTC 日期：git 记时间用 UTC，出问题时两边对得上，也不会因为换时区而错位。
APPLIED_DIR="$REPO/docs/dev/applied"
mkdir -p "$APPLIED_DIR"
PATCH_NAME="$(basename "$PATCH_REAL")"
ARCHIVE="$APPLIED_DIR/$(date -u +%Y-%m-%d)-$PATCH_NAME"
cp -f "$PATCH_REAL" "$ARCHIVE"

# ── 5) 落成一个 commit ───────────────────────────────────────
SUBJECT="apply: $PATCH_NAME（由主人在本机执行）"

# 补丁开头那行注释是助手写给主人看的说明，顺手带进 commit 正文：
# 三个月后翻 log 的人先看到的是"为什么"，不是一串 diff 路径。
PATCH_NOTE=""
while IFS= read -r line; do
  [ -z "${line//[[:space:]]/}" ] && continue
  case "$line" in
    \#*|//*) PATCH_NOTE="${line#"${line%%[![:space:]]*}"}" ;;
  esac
  break
done < "$PATCH_REAL"

git add -A
if git diff --cached --quiet; then
  echo "✗ 这个补丁没有带来任何改动，没有留下 commit（仓库原样不动）。" >&2
  exit 1
fi
if [ -n "$PATCH_NOTE" ]; then
  git commit -q -m "$SUBJECT" -m "$PATCH_NOTE"
else
  git commit -q -m "$SUBJECT"
fi
SHORT="$(git rev-parse --short HEAD)"

# ── 6) 只报"接下来做什么"，替主人做决定的部分到此为止 ────────
# 这一块刻意压到几行：§3.1 说得很清楚，主人闭眼跑的那天，这套护栏就没了。
#
# ⚠️ **node 必须打印绝对路径**：本机**没有系统 `node`**（只有 nvm 里那一个），
#    所以 `sudo node …` 会撞"找不到命令" —— 2026-09-21 实测踩过一次
#    （主人照这行抄，命令直接失败）。`verify-integrity.mjs` 自己打印的是对的
#    （它用 `process.execPath`），这里之前是**硬编**的，是个真缺陷。
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  # nvm 那个位置（`AGENTS.md` §1.1 记着本机只有这一个）
  for cand in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$cand" ] && NODE_BIN="$cand" && break
  done
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="<node 的绝对路径>"
  echo "⚠️ 找不到 node —— 下面那条重建命令里的 <node 的绝对路径> 要你自己填。" >&2
fi
cat <<EOF

✅ 已应用并留下一个 commit：$SHORT
⚠️ 代码/配置变过 ⇒ 开机那份清单要重建，否则下次开机起不来：
     sudo $NODE_BIN scripts/verify-integrity.mjs --build
   然后（等它把手上的话说完再重启）：
     scripts/restart-core.sh
EOF
