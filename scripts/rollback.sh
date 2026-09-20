#!/usr/bin/env bash
# P2 的救援那一步：把某一次改动原样撤回，主人不用知道历史。
#
# 依据：手册 `06-OPERATIONS.md` §三（回退必须用 `git revert`）· §8.1/§8.2（回退的硬要求
#       与故障处理顺序）· `04-ROADMAP.md` 批 6「P2 apply 工具」· `08-SPEC.md` §13.2 第 3 条。
#
# 用法：
#   scripts/rollback.sh            # 回退最近一次改动
#   scripts/rollback.sh <commit>   # 回退指定的那一次
#   scripts/rollback.sh -h
#
# ⚠️ 为什么这里**一个助手产出的文件都不读**（不读 proposals/、不读账、不读 docs）：
#    §8.2 —— 出问题时助手本身可能就是出问题的那个。回退要"主人一句话完成、不需要助手
#    参与"，所以它只信 git 自己的历史，不信任何助手写下来的东西。
#
# ⚠️ 为什么这里**可以**替主人重启，而 apply 不行：apply 是正常往前走，重启会打断主人
#    正在进行的那一轮（§8.3）；回退几乎总是"服务已经坏了要救回来"，坏掉的服务没有
#    "正在说的话"可保，再让主人手打一条命令只是把没法用的时间拉长。§8.1 的顺序也是
#    revert → 重启 → 确认存活。
#    本机没有那个服务时（见 `AGENTS.md` §一），脚本只提示、不假装重启成功。
#    要跳过重启（测试、或服务在别的机器上）：HUPO_SKIP_RESTART=1。
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  scripts/rollback.sh            # 回退最近一次改动
  scripts/rollback.sh <commit>   # 回退指定的那一次
  scripts/rollback.sh -h

  HUPO_SKIP_RESTART=1 scripts/rollback.sh   # 只回退，不重启服务

回退会在历史里新增一个 commit（不是把历史抹掉），所以回退本身也能被回退。
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

# 仓库根：优先听主人的环境变量，否则按脚本自己的位置推（脚本在 <仓库根>/scripts/ 下）。
REPO="${HUPO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO" || { echo "✗ 进不去仓库根：$REPO" >&2; exit 1; }

TARGET="${1:-HEAD}"
if ! git rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null; then
  echo "✗ 找不到这个改动：$TARGET" >&2
  exit 1
fi

# 有没提交的改动**不拦**：回退是救援路径，不能被一件不相干的脏改动挡在门外；
# 而且 git 只把这一次的撤回放进新 commit，那些改动不会跟着被提交。只提醒一句。
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️ 仓库里还有没提交的改动 —— 回退只撤回已经提交的部分，它们会原样留着。" >&2
fi

if git revert --no-edit "$TARGET"; then
  SHORT="$(git rev-parse --short HEAD)"
  echo "✅ 已回退：$SHORT"
else
  # 冲突了。git 会把仓库停在"回退进行到一半"的状态里（`.git/REVERT_HEAD` 还在），
  # 那种状态下主人不管接着做什么都是踩在半吊子上 —— 所以先整个撤掉，回到他敲命令之前。
  git revert --abort >/dev/null 2>&1 || true
  echo "✗ 回退没成功，**已经撤销这次回退，仓库回到你敲命令之前的样子**。" >&2
  echo "  多半是这次改动和它后面的改动撞在了同一处，git 不敢替你决定。" >&2
  echo "  要自己收拾的话：" >&2
  echo "    1) git revert --no-edit $TARGET      # 再做一次，这回看它报哪几个文件" >&2
  echo "    2) 打开那几个文件，按里面的提示改到你要的样子" >&2
  echo "    3) git add <那几个文件> && git revert --continue" >&2
  echo "  中途不想收拾了：git revert --abort，一样回到现在这个状态。" >&2
  exit 1
fi

# ── 重启 ─────────────────────────────────────────────────────
if [ "${HUPO_SKIP_RESTART:-0}" = "1" ]; then
  echo "▶ 重启服务（这次跳过了：HUPO_SKIP_RESTART=1）"
  exit 0
fi

RESTART="$REPO/scripts/restart-core.sh"
if [ ! -x "$RESTART" ]; then
  echo "▶ 重启服务：这台机器上没有 $RESTART"
  echo "   请在有服务的那台机器上重启，然后确认它还活着。"
  exit 0
fi

echo "▶ 重启服务"
"$RESTART"
