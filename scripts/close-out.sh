#!/usr/bin/env bash
# 收尾 —— **一条命令跑完 `AGENTS.md` §5.0 那几件**。
#
# 用法：
#   scripts/close-out.sh "一句话说明" -- <改动路径...>                  # 跑闸 + 推
#   scripts/close-out.sh "..." -- <路径...> --deploy                   # 客户端改了：连部署一起做
#   scripts/close-out.sh "..." -- <路径...> --dry-run                  # 只跑闸、只打计划，不提交不推
#   scripts/close-out.sh "..." -- <路径...> --allow-others-dirty        # 主人已同意时，绕开"树上还有别人的活"
#
# ── 为什么要有它 ─────────────────────────────────────────
# §5.0 把"收尾"定成四件（外加 APK 那条），而它要跑 **5–6 条命令**，
# 其中客户端那一道闸本身就要**两分多钟**。靠记忆跑 ⇒ 一定漏一件，
# 而漏掉的那件（多半是"部署"或"文档闸"）**不会有人喊**。
# ⇒ 变成一条命令；**每一步都打出它到底跑没跑** ——
#   "没验"不许装成"通过"（这条是抄 `check-client.sh` 的 `--no-token` 那套）。
#
# ── 它**不**替你做的两件（刻意的）────────────────────────
#   · **部署**是"部署期"的动作（`AGENTS.md` §8.1：签字的是主人）
#     ⇒ 要显式给 `--deploy` 才动；没给就直接**拒绝推送**（第 2 件没做完，收尾不算完）。
#   · **APK** 只在主人说了才打（2026-10-01 原话）⇒ 这个脚本**永远不碰** `publish-apk.sh`。
#
# 退出码：0 收尾完成 · 1 有闸没过 · 2 用法/前置不对（**什么都没提交**）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

usage() {
  cat <<'EOF'
用法：
  scripts/close-out.sh "一句话说明" -- <改动路径...>              # 跑闸 + 推
  scripts/close-out.sh "..." -- <路径...> --deploy               # 客户端改了：连部署一起做
  scripts/close-out.sh "..." -- <路径...> --dry-run              # 只跑闸、只打计划
  scripts/close-out.sh "..." -- <路径...> --allow-others-dirty    # 树上还有别人的活（主人已同意）

它跑这几件（`AGENTS.md` §5.0）：
  ① 文档闸          node scripts/check-docs.mjs
  ② 服务端硬闸      cd v2/services/core && npm test        （点名的路径里有服务端才跑）
  ③ 客户端硬闸      bash scripts/check-client.sh           （点名的路径里有客户端才跑）
  ④ 线上漂移        bash scripts/check-web-drift.sh
  ⑤ 部署            bash scripts/deploy-web-v2.sh          （**只在 --deploy 时**；客户端改了就必须做）
  ⑥ 推              bash scripts/push-changes.sh

⚠️ 它**不**打 APK。APK 只在主人说了才打。
EOF
}

if [ $# -eq 0 ]; then usage >&2; exit 2; fi
# ⚠️ `--help` **必须在取 MSG 之前**判：否则它会被当成"说明"吃掉，
#    然后报"必须说清路径" —— 一个问用法的人得到一句莫名其妙的错。
case "${1:-}" in -h|--help) usage; exit 0 ;; esac
# ⚠️ 说明可以是**一段话**，也可以是一个**文件**（要给提交信息带正文时用文件）——
#    单行说明喂给 push-changes.sh —— 那里只收一句话。
if [ -f "${1:-}" ]; then MSG_FILE_IN="$1"; MSG="$(head -1 "$MSG_FILE_IN")"; else MSG_FILE_IN=""; MSG="$1"; fi
shift

PATHS=(); DEPLOY=0; DRY=0; ALLOW=0
# ⚠️ 标志与路径**次序随意**（原来写成"`--` 之后全是路径"，于是 `-- x  --dry-run`
#    会把 `--dry-run` 当成路径名 —— 这种隐藏规则正是要避免的东西）。
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --deploy) DEPLOY=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --allow-others-dirty) ALLOW=1; shift ;;
    --) shift ;;
    -*) echo "✗ 不认识的参数：$1" >&2; usage >&2; exit 2 ;;
    *) PATHS+=("$1"); shift ;;
  esac
done
if [ "${#PATHS[@]}" = "0" ]; then
  echo "✗ 必须说清这次提交哪些路径（见 §5.3：不说清 = 可能把别人的半成品扫进去）" >&2
  usage >&2; exit 2
fi
for p in "${PATHS[@]}"; do
  if [ ! -e "$p" ] && ! git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    echo "✗ 这个路径不存在：$p" >&2; exit 2
  fi
done

# ── 谁改了：我点名的 vs 别人的 ─────────────────────────────
changed=0
OTHERS=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  p="${line:3}"; case "$p" in *' -> '*) p="${p##* -> }" ;; esac
  mine=0
  for q in "${PATHS[@]}"; do case "$p" in "$q"|"$q"/*) mine=1 ;; esac; done
  if [ "$mine" = "1" ]; then changed=$((changed + 1)); else OTHERS="${OTHERS}${p}"$'\n'; fi
done < <(git status --porcelain)

echo "▶ 这一批（你点名的）：${changed} 个路径"
if [ -n "$OTHERS" ]; then
  echo "⚠️ 树上还有**别人的**未提交改动（一个字节都不会碰它们）："
  printf '%s' "$OTHERS" | sed 's/^/      /'
fi

has_prefix() { for p in "${PATHS[@]}"; do case "$p" in "$1"*) return 0 ;; esac; done; return 1; }
SERVER_CHANGED=0; CLIENT_CHANGED=0
has_prefix 'v2/services/core/' && SERVER_CHANGED=1
has_prefix 'v2/apps/mobile/lib/' && CLIENT_CHANGED=1
has_prefix 'v2/apps/mobile/pubspec.yaml' && CLIENT_CHANGED=1
has_prefix 'v2/apps/mobile/web/' && CLIENT_CHANGED=1
has_prefix 'v2/apps/mobile/test/' && CLIENT_CHANGED=1

bad=0
step() { echo; echo "── $1 ──"; }

# ① 文档闸
step "① 文档闸（每个 .md 的指针都要对得上）"
if node scripts/check-docs.mjs; then echo "  ✓ 过"; else echo "  ✗ **没过**"; bad=1; fi

# ② 服务端硬闸
step "② 服务端硬闸"
if [ "$SERVER_CHANGED" = "1" ]; then
  if (cd v2/services/core && npm test 2>&1 | tail -8); then echo "  ✓ 过"; else echo "  ✗ **没过**"; bad=1; fi
else
  echo "  ⏭ 点名的路径里没有服务端 ⇒ **这一条没验**（不是通过）"
fi

# ③ 客户端硬闸
step "③ 客户端硬闸（三道，约两分钟）"
if [ "$CLIENT_CHANGED" = "1" ]; then
  if bash scripts/check-client.sh 2>&1 | tail -6; then echo "  ✓ 过"; else echo "  ✗ **没过**"; bad=1; fi
else
  echo "  ⏭ 点名的路径里没有客户端 ⇒ **这一条没验**（不是通过）"
fi

# ④ 线上漂移
step "④ 线上那份客户端产物 ⇄ 仓库"
DRIFT_OK=0
if bash scripts/check-web-drift.sh; then echo "  ✓ 一致"; DRIFT_OK=1; else echo "  ✗ **落后**（第 ⑤ 件就是为了这个）"; bad=1; fi

# ⑤ 部署（部署期的动作，只在 --deploy 时做）
step "⑤ 部署（部署期的动作，只在 --deploy 时做）"
if [ "$DEPLOY" = "1" ]; then
  if bash scripts/deploy-web-v2.sh; then echo "  ✓ 已部署"; else echo "  ✗ **部署失败**"; bad=1; fi
elif [ "$CLIENT_CHANGED" = "1" ] && [ "$DRIFT_OK" != "1" ]; then
  echo "  ⛔ 客户端源码改了、而线上**还不是这一版** ⇒ **§5.0 第 2 件没做完**"
  echo "     （要么加 --deploy，要么自己跑 scripts/deploy-web-v2.sh）"
  bad=1
elif [ "$CLIENT_CHANGED" = "1" ]; then
  # ⚠️ 漂移闸刚才**已经量过**"线上就是仓库这一版" ⇒ 这一件已经做完了，**不必再部署一遍**。
  #    （2026-10-01：第一版这里只看"客户端改了没有"，于是刚部署完的人会被要求再部署一次。）
  echo "  ✓ 线上已经就是这一版（上面 ④ 的读数）⇒ 第 2 件算做完，不必再部署"
else
  echo "  ⏭ 客户端没改 ⇒ 不必部署"
fi

if [ "$bad" != "0" ]; then
  echo
  echo "❌ 收尾**没完成**（上面打 ✗ / ⛔ 的那几件）⇒ **什么都没提交。**"
  echo "   ⚠️ 有闸没过就不是收尾，是「还没做完」（§5.0）。"
  exit 1
fi

if [ "$DRY" = "1" ]; then
  echo
  echo "✅ 闸都过了（--dry-run：到此为止，**没提交、没推**）"
  echo "   真推就是把下面这条跑一遍："
  echo "     bash scripts/push-changes.sh \"$MSG\" -- ${PATHS[*]}"
  exit 0
fi

# ⑥ 推
step "⑥ 推上去"

# ── 正常那条路：交给 push-changes.sh（它按设计会拦"树上还有别人的活"）──
if [ "$ALLOW" != "1" ]; then
  if bash scripts/push-changes.sh "$MSG" -- "${PATHS[@]}"; then
    echo "  ✓ 推成功"
    exit 0
  fi
  rc=$?
  echo "  ✗ push-changes.sh 退出 $rc"
  if [ -n "$OTHERS" ]; then
    echo
    echo "  原因多半是「树上还有别人的活」。两条路："
    echo "    · 等它落地，再跑一次这条命令（改动都还在工作树上，不会丢）；"
    echo "    · **主人已明确同意**时，加 --allow-others-dirty。"
  fi
  exit "$rc"
fi

# ── --allow-others-dirty：只 add 你点名的那几个，**绝不** `git add -A` ──
#    ⚠️ 这就是 §5.3 那条纪律的"结构上不可能"版本：
#       加完之后**当场核对**暂存区里有没有别人的路径，有就**撤销暂存并退出**。
echo "  ⚠️ --allow-others-dirty：只 add 你点名的这几个（**绝不 `git add -A`**）"
printf '      %s\n' "${PATHS[@]}"
git add -- "${PATHS[@]}" || { echo "  ✗ git add 失败"; exit 1; }

STAGED="$(git diff --cached --name-only)"
# ⚠️ 只警告**不属于你**的那些。实测撞到过：别人一条 `git add -A` 会把**你的**文件
#    也扫进暂存区 —— 那时"暂存区里有东西"对你的文件来说是正常的，对别人的才是信号。
if [ -n "$STAGED" ]; then
  FOREIGN_WARN=""
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    mine=0; for q in "${PATHS[@]}"; do case "$s" in "$q"|"$q"/*) mine=1 ;; esac; done
    [ "$mine" = "0" ] && FOREIGN_WARN="${FOREIGN_WARN}${s}"$'\n'
  done <<< "$STAGED"
  if [ -n "$FOREIGN_WARN" ]; then
    echo "  ⚠️ 暂存区里已经有**别人的**东西（本次一个都不会带上，也不去动它）："
    printf '%s' "$FOREIGN_WARN" | sed 's/^/      /'
  fi
fi

# 🔴 这里是**两步一起**才安全：
#    ① `git add -- <你点名的>`：只加你的，**绝不** `git add -A`；
#       （未跟踪的新文件也必须先 add，否则下面那步提交不到它 —— 实测。）
#    ② `git commit -- <你点名的>`：**路径限定提交**，只提交这几个、**绕开整个暂存区**。
#       为什么非要 ②：`git commit` 不带路径时提交的是**整个暂存区** ——
#       别人 `git add` 过的路径会被**一起**提交上去（实测撞到过：他们正在并行收尾）。
#    ⇒ 即"add 的是我的" ＋ "commit 的也是我的"，而且**不去动别人的暂存**（不 reset 别人）。
git add -- "${PATHS[@]}" || { echo "  ✗ git add 失败"; exit 1; }

MSG_FILE="$(mktemp)"
if [ -n "$MSG_FILE_IN" ]; then cat "$MSG_FILE_IN" > "$MSG_FILE"; else printf '%s\n' "$MSG" > "$MSG_FILE"; fi
if git commit --quiet -F "$MSG_FILE" -- "${PATHS[@]}"; then
  rm -f "$MSG_FILE"
  echo "  ✓ 已提交（**只含你点名的这几个**）：$(git log -1 --oneline)"
else
  rm -f "$MSG_FILE"
  echo "  ✗ 提交失败"; exit 1
fi
if git push origin HEAD; then
  echo "  ✓ 推成功"
else
  echo "  ✗ 推失败（改动**已在本地提交**，下次成功会自动补齐）"
  exit 1
fi
