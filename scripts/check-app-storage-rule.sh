#!/usr/bin/env bash
# **「做一个东西（小程序 / app / 游戏）⇒ 有存储就一起做、做完要说完成」的闸**
#   （主人 2026-10-03 定的四条；落地见 `docs/dev/167-APP-STORAGE-RULE.md`，
#     口径 `docs/handbook/05-DECISIONS.md` **D4.25**）。
#
# 用法：
#   bash scripts/check-app-storage-rule.sh
#
# 退出码 = 失败数（0 ⇒ 通过）；末尾固定打印 **`通过 N · 失败 M`**。
#
# ── 它问的是哪一件事（为什么**新开一条**，而不是塞进已有那八条闸）──────
#   已有那八条各管一件事：人格"真的进了模型上下文吗"（`check-persona.sh`）、
#   数据形状随不随 fork（`check-data-shape.sh`）、数据契约与命名空间（`check-data-contract.sh`）……
#   它们**没有一条**问"**用户在对话里说要做一个小程序 / app / 游戏时，助手到底被要求怎么动手**"。
#   这一条问的正是**行为**那一层：触发 ⇒ 造内容 · 判存储（默认有、有就一起做）·
#   上桌面 · 报完成（做不到要当场说清是哪一条）。判据、机制、会坏的方式都不一样 ⇒ **新开一条**。
#
# ── 判据（每条都能反着验）──────────────────────────────────
#   ① **人格里那四条行为在**（源码级：`hupo-persona.yml` 里逐条找得到）；
#   ② **`app_create` 的描述里说清了"建数据格 ＋ `data-shape.json`"**
#      （形状声明怎么给 · 值一个字节都不许进 · 没声明就打包当场拒）；
#   ③ **负向对照**：把这条规矩从人格里**删掉** ⇒ ①必须**红**（否则这条闸在空转）；
#   ④ **负向对照（工具侧）**：把那段描述删掉 ⇒ ②必须**红**。
#
# 🔴 纪律：读不出 / 算不出 ⇒ 如实打印 **`不可算`** 并记**失败**，**绝不安静地绿**。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PERSONA="$ROOT/v2/services/core/hupo-persona.yml"
MCP="$ROOT/v2/services/core/src/mcp-apps-server.mjs"

[ -f "$PERSONA" ] || { echo "✗ 找不到人格文件：$PERSONA"; exit 2; }
[ -f "$MCP" ] || { echo "✗ 找不到工具文件：$MCP"; exit 2; }

pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1"; fail=$((fail + 1)); }

# 文本级判据：ck <文本> <描述> <要找的子串>
ck() { case "$1" in *"$3"*) ok "$2" ;; *) bad "$2 —— 找不到「$3」" ;; esac; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# ══════════════════════════════════════════════════════════════════
echo '── 判据 ①（源码级）：人格里那四条行为在'
P="$(cat "$PERSONA")"
ck "$P" '① 触发：说要做一个东西就**动手造内容**（不是只聊方案）' '动手造内容'
ck "$P" '① 触发：小程序 / app / **游戏** 都在' '游戏'
ck "$P" '② 判断存储：**默认就当有**' '默认就当有'
ck "$P" '② 有数据要存 ⇒ **一起把存储做进去**' '一起把存储做进去'
ck "$P" '② 不许因为"**存不了**"就跳过' '存不了'
ck "$P" '③ 上桌面：做完**桌面要长出**那个图标' '桌面要长出'
ck "$P" '④ 报完成：**做完明确告诉他**"做完了"' '做完明确告诉他'
ck "$P" '④ 做不到 ⇒ **当场如实说清是哪一条做不到**（不许假装）' '当场如实说清是哪一条做不到'

# ══════════════════════════════════════════════════════════════════
echo
echo '── 判据 ②（源码级）：`app_create` 的描述里说清了"建数据格 ＋ `data-shape.json`"'
# ⚠️ 只看 **`app_create` 那一段**（从它的 `name:` 到下一个工具的 `name:`）——
#    不然别的工具里随便出现一个词就能把这条闸哄绿。
desc_of() { # <文件> —— 抽 app_create 的描述段
  awk "/name: 'app_create',/{f=1} f{print} /name: 'app_publish',/{if(f)exit}" "$1"
}
D="$(desc_of "$MCP")"
if [ -z "$D" ]; then
  bad '② 抽不出 `app_create` 那一段（**不可算**）—— 工具改名了？'
else
  ck "$D" '② 说了"**建数据格**"' '建数据格'
  ck "$D" '② 点名 `data-shape.json`' 'data-shape.json'
  ck "$D" '② 说清形状声明怎么给（`packs` / `keys` / `schema`）' '"packs"'
  ck "$D" '② 说清形状的号（`shapeVersion`）' 'shapeVersion'
  ck "$D" '② **值一个字节都不许进**这份文件' '值一个字节都不许进'
  ck "$D" '② 说清数据格落在哪（`.data/`）' '.data/'
  ck "$D" '② 没声明 ⇒ **打包当场拒**（fail-closed）' 'fail-closed'
fi

# ══════════════════════════════════════════════════════════════════
echo
echo '── 判据 ③（负向对照）：把这条规矩从人格里**删掉** ⇒ 判据 ① 必须红'
# ⚠️ 删的是**这条规矩自己的那几行**（每行一个标志词）；别的一条都不动。
cp "$PERSONA" "$T/persona-mutant.yml"
sed -i -e '/动手造内容/d' -e '/默认就当有/d' -e '/一起把存储做进去/d' \
       -e '/桌面要长出/d' -e '/做完明确告诉他/d' -e '/当场如实说清是哪一条做不到/d' \
       "$T/persona-mutant.yml"
PM="$(cat "$T/persona-mutant.yml")"
if [ "$PM" = "$P" ]; then
  bad '③ **不可算**：删完之后文件逐字没变 —— 那几行的标志词一个都没命中，对照不成立'
else
  red=0
  for kw in 动手造内容 默认就当有 一起把存储做进去 桌面要长出 做完明确告诉他 当场如实说清是哪一条做不到; do
    case "$PM" in *"$kw"*) ;; *) red=$((red + 1)) ;; esac
  done
  if [ "$red" -gt 0 ]; then
    ok "③ 删掉规矩后 $red 处变红（对照成立：①确实在量它们）"
  else
    bad '③ 删掉规矩后判据 ① 还是全绿 —— 这条闸在空转（**不可算**）'
  fi
fi

# ══════════════════════════════════════════════════════════════════
echo
echo '── 判据 ④（负向对照 · 工具侧）：把那段描述删掉 ⇒ 判据 ② 必须红'
# ⚠️ 只删**新增那几行**（标志词都在同一段里）；文件别处一个字节不动。
sed -e '/建数据格/d' -e '/data-shape.json/d' -e '/shapeVersion/d' \
    -e '/值一个字节都不许进/d' -e '/fail-closed/d' "$MCP" > "$T/mcp-mutant.mjs"
DM="$(desc_of "$T/mcp-mutant.mjs")"
if [ "$DM" = "$D" ]; then
  bad '④ **不可算**：删完之后描述逐字没变 —— 标志词一个都没命中，对照不成立'
else
  mred=0
  for kw in 建数据格 data-shape.json shapeVersion '值一个字节都不许进' fail-closed; do
    case "$DM" in *"$kw"*) ;; *) mred=$((mred + 1)) ;; esac
  done
  if [ "$mred" -gt 0 ]; then
    ok "④ 删掉描述后 $mred 处变红（对照成立：②确实在量它）"
  else
    bad '④ 删掉描述后判据 ② 还是全绿 —— 这条闸在空转（**不可算**）'
  fi
fi

echo
echo "──────────────────────────────"
if [ "$fail" = "0" ]; then
  echo "✅ 通过 $pass · 失败 $fail"
  exit 0
fi
echo "✗ 通过 $pass · 失败 $fail"
exit 1
