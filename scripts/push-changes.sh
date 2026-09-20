#!/usr/bin/env bash
# 提交 + 推送到 GitHub。⚠️ **必须说清提交哪些路径**（2026-09-21 改）。
#
# 用法：
#   scripts/push-changes.sh "一句说明" -- <路径...>   # 只提交这些路径（推荐）
#   scripts/push-changes.sh "一句说明" --all          # 提交整棵树（会先把清单打出来）
#   scripts/push-changes.sh "一句说明"                # 树上干净时：把本地已有的提交推上去
#
# ── 为什么改成"必须给路径" ──────────────────────────────────
# 旧版是 `git add -A` ⇒ **会把正在被别人改的半成品顺手扫进提交**。
# 实测犯过 **4 次**（`docs/dev/00-PROGRESS.md` §十、§十一·补）：信息写的是 A，
# 提交里却有 B。而那个提交是要入库、要给下一个人读的。
#
# ⚠️ **光记纪律没用**（记了三条，第 4 次还是犯了）⇒ 改工具，让它在**结构上不可能**：
#    只 `git add -- <你给的路径>`；树上还有**别的**脏路径就**在 git add 之前**拒绝。
#    确实要提交整棵树，就得显式说 `--all`（那时它会把清单打出来，逼你看一眼）。
#
# ⚠️ 另一个坑（顺手修的）：旧版在"工作区干净"时**直接退出 0**，
#    于是 `apply-change.sh` 那种"已经 commit 但还没 push"的情况**永远推不上去**。
#    ⇒ 现在"干净"只表示**没有新改动要提交**，它照样会把本地已有的提交推上去。
#
# 退出码：0 推成功（或确实没有要推的）· 1 提交/推送失败 · 2 用法不对（**什么都没提交**）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "✗ 找不到仓库根目录"; exit 1; }

usage() {
  cat <<'EOF'
用法：
  scripts/push-changes.sh "一句说明" -- <路径...>   # 只提交这些路径（推荐）
  scripts/push-changes.sh "一句说明" --all          # 提交整棵树（会先把清单打出来）
  scripts/push-changes.sh "一句说明"                # 树上干净时：把本地已有的提交推上去

为什么必须给路径：`git add -A` 会把**别人正在改的半成品**一起提交（已经犯过 4 次）。
树上还有你没点名的脏路径时，这个脚本**在 git add 之前就拒绝**，什么都不改。
EOF
}

# ── 参数 ────────────────────────────────────────────────────
if [ $# -eq 0 ]; then usage >&2; exit 2; fi
MSG="$1"; shift

PATHS=()
ALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --all) ALL=1; shift ;;
    --)
      shift
      while [ $# -gt 0 ]; do PATHS+=("$1"); shift; done
      ;;
    *)
      echo "✗ 不认识的参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# ── 现在树上哪些路径是脏的（porcelain 前两列状态 + 一个空格之后是路径）──
dirty_paths() {
  git status --porcelain | while IFS= read -r line; do
    p="${line:3}"
    case "$p" in *' -> '*) p="${p##* -> }" ;; esac
    printf '%s\n' "$p"
  done
}
DIRTY="$(dirty_paths)"

# ── 情况一：没给路径、也没说 --all ───────────────────────────
PUSH_ONLY=0
if [ "${#PATHS[@]}" = "0" ] && [ "$ALL" = "0" ]; then
  if [ -n "$DIRTY" ]; then
    echo "✗ 树上有未提交的改动，但你没说提交哪些 ⇒ **什么都没提交。**" >&2
    echo "  · 只提交你自己那几个路径：" >&2
    echo "      scripts/push-changes.sh \"说明\" -- <路径...>" >&2
    echo "  · 确实要提交整棵树（先看清楚下面这些是不是都该进）：" >&2
    echo "      scripts/push-changes.sh \"说明\" --all" >&2
    echo "  现在树上：" >&2
    printf '%s\n' "$DIRTY" | sed 's/^/      /' >&2
    exit 2
  fi
  # 干净 ⇒ 没有新东西要提交，但**可能还有本地提交没推**
  PUSH_ONLY=1
fi

# ── 情况二：只提交点名的路径 ⇒ **先**确认没有别人的活混在树上 ──
if [ "$ALL" = "0" ] && [ "$PUSH_ONLY" = "0" ] && [ -n "$DIRTY" ]; then
  EXTRA=""
  while IFS= read -r d; do
    [ -z "$d" ] && continue
    ok=0
    for p in "${PATHS[@]}"; do
      case "$d" in "$p"|"$p"/*) ok=1 ;; esac
    done
    [ "$ok" = "0" ] && EXTRA="${EXTRA}${d}"$'\n'
  done <<< "$DIRTY"
  if [ -n "$EXTRA" ]; then
    echo "✗ 树上**还有别的**未提交改动 ⇒ 拒绝提交（**什么都没动**）。" >&2
    echo "  下面这些不在你点名的路径里（很可能有人正在改）：" >&2
    printf '%s' "$EXTRA" | sed 's/^/      /' >&2
    echo "  ⇒ 等它落地，只提交你自己的那几个；确实要一起提交，就显式加 --all。" >&2
    exit 2
  fi
fi

# ── 安全闸：运行时数据**绝不入库**（口令哈希、聊天记录都在 data/ 下）──
# ⚠️ 放在 `git add` **之前**（照脏路径清单判）：放在后面的话，
#    拒绝时暂存区里已经躺着东西了 —— "什么都没动"就成了假话。
# ⚠️ `.gitignore` 已经排除它们了，这里是第二道 —— 旧版注释里说"提交后复核一次"，
#    其实那一次**从来没写过**。现在补上。
if [ -n "$DIRTY" ] && printf '%s\n' "$DIRTY" | grep -qE '(^|/)(data/|auth\.json)$|\.jsonl$'; then
  echo "✗ 这次会提交到运行时数据（data/ 或 *.jsonl 或 auth.json）⇒ 拒绝。**什么都没动。**" >&2
  printf '%s\n' "$DIRTY" | grep -E '(^|/)(data/|auth\.json)$|\.jsonl$' | sed 's/^/      /' >&2
  exit 1
fi

# ── 暂存 ────────────────────────────────────────────────────
if [ "$PUSH_ONLY" = "0" ]; then
  if [ "$ALL" = "1" ]; then
    echo "▶ --all：下面这些会**一起**提交（看清楚有没有不是你的）"
    [ -n "$DIRTY" ] && printf '%s\n' "$DIRTY" | sed 's/^/    /'
    git add -A
  else
    for p in "${PATHS[@]}"; do
      if [ ! -e "$p" ] && ! git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
        echo "✗ 这个路径不存在：$p" >&2
        exit 2
      fi
    done
    git add -- "${PATHS[@]}" || { echo "✗ git add 失败"; exit 1; }
  fi

  if git diff --cached --quiet; then
    echo "  （没有新的改动要提交）"
  else
    git commit -q -m "$MSG" || { echo "✗ git commit 失败"; exit 1; }
    echo "  已提交 $(git rev-parse --short HEAD)：$MSG"
  fi
fi

# ── 推 ─────────────────────────────────────────────────────
if git rev-parse --verify --quiet origin/main >/dev/null; then
  if [ -z "$(git log --oneline origin/main..HEAD)" ]; then
    echo "✓ 没有要推的（远端已经是最新的）"
    exit 0
  fi
else
  echo "⚠ 本地没有 origin/main（没 fetch 过？）⇒ 直接试一次 push"
fi

if git push origin main 2>&1; then
  echo "✅ 已推送到 GitHub（$(git rev-parse --short HEAD)：$MSG）"
  exit 0
fi

# push 被拒：远端可能有外部提交（比如主人在 GitHub 网页上改过）。
# fetch + rebase 一次再推；rebase 失败就放弃并还原，别把仓库留在半吊子状态。
echo "  ↻ push 被拒，尝试 fetch + rebase 后重推…"
if git fetch origin main && git pull --rebase --autostash origin main && git push origin main 2>&1; then
  echo "✅ 已推送到 GitHub（$(git rev-parse --short HEAD)：$MSG）"
  exit 0
fi
git rebase --abort 2>/dev/null || true
echo "⚠ GitHub 推送失败（改动已在本地提交 $(git rev-parse --short HEAD)，下次成功推送会自动补齐）" >&2
exit 1
