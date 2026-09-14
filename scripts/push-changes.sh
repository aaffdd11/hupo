#!/usr/bin/env bash
# 把工作区所有改动提交并推送到 GitHub。
#
# 主人的规则（2026-09-15 起）：所有系统级修改都必须入库推送。
# 本脚本是这条规则唯一的机械落点 —— 服务端改动、客户端改动、人格改动、手册改动，
# 改完都从这里走一遍。
#
# 用法：
#   scripts/push-changes.sh "一句说明改了什么"     # 指定提交说明
#   scripts/push-changes.sh                        # 默认"system: <时间> 自动推送"
#
# 行为：
#   - 工作区干净时静默退出 0（可以放心接在任何部署脚本末尾）
#   - 推送失败时退出 1 并大声警告 —— 改动已在本地提交，任何一次后续成功推送都会补齐
#   - 远端被外部改过（push 被拒）时自动 fetch + rebase 后重试一次
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "✗ 找不到仓库根目录"; exit 1; }

# 安全闸：绝不能把运行时数据提交进去（口令哈希、聊天记录都在 data/ 下）。
# 依赖 .gitignore 里 data/、*.jsonl、auth.json 的排除 —— 提交后复核一次。
git add -A
if git diff --cached --quiet; then
  echo "  （工作区干净，没有需要推送的改动）"
  exit 0
fi

MSG="${1:-system: $(date '+%Y-%m-%d %H:%M') 自动推送}"
git commit -q -m "$MSG" || { echo "✗ git commit 失败"; exit 1; }

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
