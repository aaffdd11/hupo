#!/usr/bin/env bash
# **密钥卫生**（本仓库被烧过两次：一次进过 git、一次进过会话日志 ⇒ 这条闸就是为了不再犯）。
#
# ── 它判三件 ────────────────────────────────────────────────
#   ① **工作树里有没有像钥匙的东西**（只看 `git ls-files` 跟踪的文件，**不进历史**）；
#   ② 那几份**本该被忽略**的文件确实在 `.gitignore` 里（`data/asr.env` 等）；
#   ③ 我们自己的**写入路径**有没有把值拼进日志/回执（静态扫那几处关键字）。
#
# 🔴 **只报"哪里、哪一行"和一个打码的预览** —— **绝不打印任何值**（打印了就等于又漏一次）。
#
# 退出码：0 = 干净 · 1 = 有发现 · 3 = 环境不具备（不在仓库里）
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 3
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "✗ 这里不是仓库"; exit 3; }

bad=0
echo "── ① 跟踪的文件里像钥匙的东西（预览一律打码）"
# 形状：**够长、够像真的**才算（≥24 位）—— 阈值太低会满屏假红，而"每次都响的报警等于没有报警"。
#   ① 腾讯 SecretId `AKID…`（真的 36 位）② OpenAI/方舟风格 `sk-…`（真的 30+ 位）
#   ③ 我们自己的字段名后面直接跟一个 ≥24 位的值
PATTERNS='AKID[0-9A-Za-z]{24,}|sk-[A-Za-z0-9_-]{24,}|(TENCENT_SECRET_(ID|KEY)|HUPO_(MODEL|IMAGE|VIDEO)_KEY)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9_/+=-]{24,}'
# 声明式豁免：那一行（或上一行）自己说清楚"这是假的/占位" ⇒ 不算。
# ⚠️ 这条豁免是**故意的**：判据不许靠猜，只认"写了字的声明"。
ALLOW='假|fake|测试|占位|示例|你的|xxx|allow|check-secrets'
HITS="$(git ls-files -z | xargs -0 grep -InE "$PATTERNS" 2>/dev/null | grep -v '^scripts/check-secrets.sh:' \
        | while IFS= read -r line; do
            file="${line%%:*}"; rest="${line#*:}"; ln="${rest%%:*}"
            # 看这一行与上一行有没有声明
            # 往回看 3 行（"假钥匙"那句话常在上上一行 —— 第一版只看一行，当场漏了）
            ctx="$(sed -n "$((ln>3?ln-3:1)),${ln}p" "$file" 2>/dev/null)"
            printf '%s\n' "$ctx" | grep -qE "$ALLOW" && continue
            printf '%s\n' "$line"
          done || true)"
if [ -n "$HITS" ]; then
  bad=1
  printf '%s\n' "$HITS" | while IFS= read -r line; do
    file="${line%%:*}"; rest="${line#*:}"; ln="${rest%%:*}"
    echo "  ✗ $file:$ln  ← 看起来像一把钥匙（值已打码，**我不打印它**）"
  done
else
  echo "  ✓ 没有"
fi

echo "── ② 该被忽略的那几份确实在忽略里"
for f in data/asr.env v2/services/core/data/asr.env v2/services/core/data/creds.yaml v2/services/core/data/tenants.env; do
  if git check-ignore -q "$f" 2>/dev/null; then echo "  ✓ $f 被忽略"; else
    # 路径可能不存在；不存在的按"不适用"算，但要说出来
    if [ -e "$f" ]; then echo "  ✗ $f **存在却没被忽略**"; bad=1; else echo "  · $f 不在盘上（不适用）"; fi
  fi
done
# `data/creds/<他>.yaml`（按人存档）也要在忽略里
if git check-ignore -q "v2/services/core/data/creds/owner.yaml" 2>/dev/null; then
  echo "  ✓ 按人存档 data/creds/*.yaml 被忽略"
else
  echo "  ✗ 按人存档 data/creds/*.yaml **没被忽略**（那份里面有钥匙）"; bad=1
fi

echo "── ③ 我们自己的写入路径：不许把值拼进日志/回执"
if grep -nE "console\.(log|warn|error)\([^)]*\\\$\{[^}]*(key|secret|token)" v2/services/core/src/*.js v2/services/core/src/*.mjs 2>/dev/null \
   | grep -vE "asr-creds|describeVoiceCreds" | head -5 | grep -q . ; then
  echo "  ⚠️ 有几处像是在拼 key/secret/token 进日志 —— 人工看一眼（**只提示，不当失败**）"
  grep -nE "console\.(log|warn|error)\([^)]*\\\$\{[^}]*(key|secret|token)" v2/services/core/src/*.js v2/services/core/src/*.mjs 2>/dev/null \
    | grep -vE "asr-creds|describeVoiceCreds" | head -5 | sed 's/^/     /' 
else
  echo "  ✓ 没看到"
fi

echo "──"
if [ "$bad" = "0" ]; then echo "✅ 干净"; else echo "❌ 有发现（上面那几条）"; fi
[ "$bad" = "0" ]
