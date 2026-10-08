#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 打一个**源代码压缩包**给他下载（主人 2026-10-07：*"给我一个源代码压缩包，放到下载链接里"*）
#
# 包什么（**默认打 HEAD 那一份**，也就是 GitHub 上那一份 —— 前后一致、可复现）：
#   · `git archive HEAD` 的内容（**只有进了 git 的文件**）；
#   · ＋ 一张 `SOURCE-MANIFEST.txt`（哪一次提交、什么时候打的、有多少个文件、每个文件的 sha256、怎么跑）。
# 不包什么（**它们本来就不在 git 里**，所以天然进不来）：
#   · `.git` 历史（要就加 `--with-git`）· `node_modules/` · `build/` `.dart_tool/` · 运行时 `data/`
#     · 安卓包与产物（那些是 `publish-apk.sh` / `deploy-web-v2.sh` 的事）
#
# 输出（**data/ 不进仓库**，跟 APK 一样是这台机器上的产物；`deploy-web-v2.sh` 会拷进 web 根，
# 所以下载链接跟着每次部署走、不会被 `rm -rf` 清掉）：
#   v2/services/core/data/hupo-source.tar.gz
#
# 用法：
#   bash scripts/pack-source.sh                 # HEAD 那一份（默认）
#   bash scripts/pack-source.sh --worktree      # 打**工作树**（含还没提交的改动与未跟踪的新文件）
#   bash scripts/pack-source.sh --with-git      # 连 `.git` 历史一起打（大很多）
#   bash scripts/pack-source.sh --out /tmp/x.tar.gz
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE=head
WITH_GIT=0
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) MODE=worktree ;;
    --with-git) WITH_GIT=1 ;;
    --out) shift; OUT="${1:-}" ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "✗ 不认识的参数：$1（看 --help）" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$OUT" ] || OUT="$ROOT/v2/services/core/data/hupo-source.tar.gz"

COMMIT="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short=12 HEAD)"
DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"

STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

echo "▶ 打源码包：$MODE（commit $SHORT）"
if [ "$MODE" = head ]; then
  git archive HEAD | tar -x -C "$STAGE"
  NOTE="HEAD 那一份（= GitHub main 那一份）"
else
  # 工作树：跟踪的那些**照工作树里的样子**打（未提交的改动跟着走），再加未跟踪但没被 .gitignore 挡的文件
  git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$STAGE"
  git ls-files --others --exclude-standard -z | tar --null -T - -cf - | tar -xf - -C "$STAGE"
  NOTE="工作树那一份（含未提交改动；打的时候树上有 $DIRTY 个脏路径）"
fi

if [ "$WITH_GIT" = 1 ]; then
  cp -a "$ROOT/.git" "$STAGE/.git"
  NOTE="$NOTE ＋ .git 历史"
fi

# ── 清单：让收到包的**不用问也知道这是哪一份、怎么跑**（数字都在这里，别处不写）──
COUNT="$(find "$STAGE" -type f ! -name SOURCE-MANIFEST.txt | wc -l | tr -d ' ')"
{
  echo "琥珀（hupo）源代码"
  echo "=================="
  echo
  echo "这一份是：$NOTE"
  echo "提交：$COMMIT"
  echo "打包时间：$(date -Iseconds)"
  echo "文件数：$COUNT"
  echo
  echo "目录：v2/services/core/ 是调度器（服务端，Node），v2/apps/mobile/ 是客户端（Flutter）；"
  echo "      docs/handbook/ 是权威文档，docs/INDEX.md 是「要问什么读哪一份」的路由；"
  echo "      AGENTS.md 是接手须知（怎么跑闸、怎么部署）。"
  echo
  echo "怎么跑（硬闸）："
  echo "      cd v2/services/core && npm test"
  echo "      bash scripts/check-client.sh        # 需要 Flutter（仓库里那份 SDK 的路径见 AGENTS.md）"
  echo
  echo "包里**没有**：.git 历史（除非打包时加了 --with-git）、node_modules/、build/、.dart_tool/、"
  echo "            运行时 data/、安卓包 —— 这些都不进 git，装依赖/构建时各自生成。"
  echo
  echo "逐个文件的 sha256："
  ( cd "$STAGE" && find . -type f ! -name SOURCE-MANIFEST.txt -print0 \
      | sort -z | xargs -0 sha256sum )
} > "$STAGE/SOURCE-MANIFEST.txt"

mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" -C "$STAGE" .
SIZE="$(du -h "$OUT" | cut -f1)"
SUM="$(sha256sum "$OUT" | cut -d' ' -f1)"
echo "  ✓ $OUT（$SIZE · $COUNT 个文件）"
echo "  sha256 $SUM"
echo "  ⤷ 放进下载：bash scripts/deploy-web-v2.sh 会把它拷成 web/hupo-source.tar.gz"
