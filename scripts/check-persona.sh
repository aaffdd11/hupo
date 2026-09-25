#!/usr/bin/env bash
# 核一件事：**人格真的进了模型上下文吗**。
#
# 用法：scripts/check-persona.sh
#
# ── 为什么不能只看文件在不在 ────────────────────────────────
# `hupo-persona.yml` 在、YAML 也没写错，**不等于**它进了 prompt：
#   · patch 得作用在 profile **之后**（`dsh --patch`）——写错层就白写
#   · 两个 block scalar 的内容才是喂进去的，键名写错一个字就静默丢掉
#   · 而这一切**都不会报错**：agent 照样起、照样答，只是"说话不像它"
# ⇒ 只有把真 dsh 起起来、把 `system/message` 那一帧抓出来看，才算验过。
#
# ⚠️ 它**必须要起真进程**（慢，几秒），所以不进 `npm test`。
#    内容那一半（禁用词、九条规则）在 `test/persona.test.js` 里，快、每次跑。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PERSONA="$ROOT/v2/services/core/hupo-persona.yml"

[ -f "$PERSONA" ] || { echo "✗ 找不到人格文件：$PERSONA"; exit 2; }
command -v dsh >/dev/null || { echo "✗ 找不到 dsh"; exit 2; }

WORKDIR="${HUPO_AGENT_CWD:-$HOME/hupo-workspace}"
[ -d "$WORKDIR" ] || { echo "✗ 工作目录不存在：$WORKDIR"; exit 2; }

echo "▶ 1/2 组合后的配置树里有没有我们的字"
if dsh --profile sdk --patch "$PERSONA" --dump-config 2>/dev/null \
     | grep -q '主人的私人助理'; then
  echo "  ✓ --dump-config 里有"
else
  echo "  ✗ --dump-config 里**没有** —— patch 没作用上（键名？层级？）"
  exit 1
fi

echo "▶ 2/2 真起一个 dsh，抓它**真正喂给模型**的那份系统提示"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/probe.mjs" <<'JS'
import { spawn } from 'node:child_process';
const [persona, cwd] = process.argv.slice(2);
const child = spawn('dsh', ['--profile', 'sdk', '--patch', persona],
  { cwd, stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
let buf = '', id = 0, system = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined) { pending.get(m.id)?.(m); pending.delete(m.id); continue; }
    const ev = m.params?.event;
    if (ev?.type === 'system/message') {
      system = (ev.data?.message?.content ?? []).map((b) => b.text ?? '').join('\n');
    }
  }
});
const call = (method, params) => {
  const my = ++id;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: my, method, params })}\n`);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('超时：' + method)), 90000);
    pending.set(my, (m) => { clearTimeout(t); res(m); });
  });
};
await call('initialize', { cwd, provider: 'deepseek-official', model: 'deepseek-flash',
  reasoningEffort: 'low', maxTokens: 4000 });
await call('session/prompt', { sessionId: `persona-check-${Date.now()}`,
  contentBlocks: [{ type: 'text', text: '只回两个字：在的' }] });
await new Promise((r) => setTimeout(r, 5000));
console.log(system);
child.kill('SIGKILL');
JS

SYSTEM="$(cd "$ROOT/v2/services/core" && timeout 120 node "$TMP/probe.mjs" "$PERSONA" "$WORKDIR" 2>/dev/null)"
if [ -z "$SYSTEM" ]; then
  echo "  ✗ 没抓到系统提示 —— 这**不能**算通过（负向对照：读不到就是没验到）"
  exit 1
fi

bad=0
check() { # check <描述> <要找的子串>
  if printf '%s' "$SYSTEM" | grep -qF "$2"; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1 —— 系统提示里找不到「$2」"
    bad=1
  fi
}
uncheck() { # uncheck <描述> <不该有的子串>
  if printf '%s' "$SYSTEM" | grep -qF "$2"; then
    echo "  ✗ $1 —— 系统提示里**有**「$2」"
    bad=1
  else
    echo "  ✓ $1"
  fi
}

echo "  系统提示 ${#SYSTEM} 字"
check '人格正文在（"主人的私人助理"）' '主人的私人助理'
check '「先应一声」在' '先应一声'
check '「一步都不许只说一句就结束」在' '必须在同一轮里'
check '「不是围墙」在' '那不是围墙'
check '「sudo 要密码」在' '要密码'
check '「下次开机自动读」在' '下次开机自动读'
# v1.6 第 10 条：被拦住时不许把话题带走 —— 反例要**点名**出现在提示里，
# 只说"态度要好"模型不知道该躲哪句话。
check '🔴 「被拦住不许把话题带走」在（含点名的反例）' '换个话题吧'
check '🔴 「他该跑哪一步」那句例外在（不然改系统那条自相矛盾）' '要一句话说清他该跑哪一步'
check '工作目录占位符被替换成了真路径' "$WORKDIR"
# ★ 2026-09-25 第 11 条（主人亲口加的）：**守正出奇 + 不害怕说真话**。
#   ⚠️ 必须**同时**验两样：那条规则在，而且"不许因为怕他不高兴就不说"这句在 ——
#   只留前半句，模型会读成"别绕开需求"，后半句才是他要的那个态度。
check '🔴 第 11 条「守正出奇」在' '守正出奇'
check '🔴 第 11 条那句"不许因为怕他不高兴就不说"在' '不许因为怕他不高兴就不说'
uncheck '🔴 没有旧那份的"免密"谎话' '免密'
uncheck '🔴 没有"重新派给你"这种做不到的承诺' '重新派给你'

echo
if [ "$bad" = "0" ]; then echo "✅ 通过：人格真的进了模型上下文"; else echo "❌ 不通过"; fi
exit "$bad"
