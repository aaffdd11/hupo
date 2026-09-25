#!/usr/bin/env bash
# 造**租户镜像**（契约 `docs/dev/37-MULTITENANT.md` §4 · `38-ISOLATION-SPLIT.md` §一）。
#
# 用法：
#   bash scripts/build-tenant-image.sh          # 造镜像（不联网）
#   bash scripts/build-tenant-image.sh --run    # 造完顺手跑一台、验它能起来
#
# ── 这个镜像里有什么（初步版）────────────────────────────────
#   node（宿主的那个，连同它依赖的动态库）· 调度器本体（`v2/services/core/src` + `ws`）
#   · 人格层 / 能力层那两份 yml · MCP 服务器那支脚本
#   · **`dsh`（agent 本体）** + 一个三行的启动器（见 ②·dsh 那段）
#   · **shell ＋ 常用命令**（`/bin/bash` ＋ 静态 busybox 那批 applet，见 ①·补 那段）
#   · 空目录 `/data`（**数据挂这里**，不放在容器那层可写层里）
#
# ✅ **2026-09-21：`dsh` 进来了**（多租户 ②-1）⇒ 镜像从 130MB 变成 ~435MB。
#    ⚠️ 但**所有租户共用同一份镜像层**（`podman images` 里只有一份），
#       所以"每人一台"并不等于"每人 435MB" —— 每人真正占的是**他自己的卷**。
#    ⚠️ **没有带 profile 模板**：`dsh` 自带 `sdk` profile，空 `DSH_HOME` 就能起
#       （见 ②·dsh 那三条实测）。
# ✅ **2026-09-25：shell 进来了**（主人拍板「甲」· B18 / `#133`）。
#    ⚠️ **在这之前这个镜像里没有 shell** ⇒ DSH 的 bash 工具（拼的是 `bash -c`）
#       **每条命令都 ENOENT**，而它报的却是一句"沙箱后端起不来"（**原因归错**）。
#       ⇒ 加 shell **不改**沙箱：盒里 landlock 本来就是好的（`--probe` = full）。
#
# ── 三条纪律 ──────────────────────────────────────────────
#   ① **不联网、不拉镜像**：这台机器够不着 Docker Hub（实测），
#      所以 rootfs 全靠**宿主已有的文件**拼（`buildah from scratch`）；
#   ② **容器内绑 `0.0.0.0`，宿主只绑 `127.0.0.1`**：容器里不绑 0.0.0.0，
#      宿主那个回环口就**转不进去**；而宿主那边**必须只绑回环**
#      （实测：容器够得着宿主 `0.0.0.0` 的服务 ⇒ 开在 0.0.0.0 就是把甲的口递给乙）；
#   ③ **数据在卷里**：`/data` 是挂载点 ⇒ **容器可以随时重建**，用户的东西不丢。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
IMG="${HUPO_TENANT_IMAGE:-localhost/hupo-tenant:local}"
DO_RUN=0
[ "${1:-}" = "--run" ] && DO_RUN=1

BUILDAH="${BUILDAH_BIN:-/usr/bin/buildah}"
PODMAN="${PODMAN_BIN:-/usr/bin/podman}"

for b in "$BUILDAH" "$PODMAN"; do
  [ -x "$b" ] || { echo "✗ 找不到 $b"; exit 2; }
done

NODE="$(command -v node || true)"
[ -x "$NODE" ] || { echo "✗ 找不到 node"; exit 2; }

R="$(mktemp -d)"
trap 'rm -rf "$R"' EXIT
echo "▶ 拼 rootfs（$R）"

mkdir -p "$R"/{bin,proc,sys,tmp,dev,etc,data,app,sbin,usr/bin,usr/sbin}

# ── ① node + 它的动态库（连同 loader）──
cp "$NODE" "$R/bin/node"
echo "  node: $NODE"
ldd "$NODE" | while read -r line; do
  case "$line" in
    *"=>"*) lib="${line##*=> }"; lib="${lib%% *}" ;;
    /*)     lib="${line%% *}" ;;
    *)      continue ;;
  esac
  [ -f "$lib" ] || continue
  mkdir -p "$R$(dirname "$lib")"
  cp -n "$lib" "$R$lib" 2>/dev/null || true
done
echo "  库: $(find "$R" -name '*.so*' | wc -l) 个"

# ── ①·补 **shell ＋ 常用命令**（2026-09-25 主人拍板「甲」· 账见 B18 / `#133`）──
#
# 🔴 **为什么非有不可**：DSH 的 bash 工具**写死了** `["bash","-c",命令]`
#    （`dsh-bash-local/lib/index.js` 的 `run()` 与 `start()` 两处），它按 **PATH**
#    找一个**叫 `bash` 的可执行文件**。而本镜像原来是 `scratch + node`：
#    `/bin` 里**只有 `dsh` 与 `node`** ⇒ 那条命令**永远** `ENOENT`；更坏的是
#    DSH 会把这件事报成 **`no sandbox backend is usable on this host`**（原因归错）。
#
#    真机取证（`77-BLOCKERS.md` B18）：盒里 `landlock-run --probe` **是好的**
#    （`fully enforced`，root 与 uid 1000 都试过），坏的只是"**没有 shell**"。
#    ⇒ 补的不是沙箱，是**一个 shell**。
#
# 装两样 —— 都从**宿主已有的文件**来（**不联网、不拉镜像**，纪律①）：
#   · **真 bash**（连它的动态库，沿用上面 node 那套 `ldd` 拷贝）—— DSH 找的就是它；
#   · **busybox**（宿主那份是**静态**的）—— 一个二进制给几十个常用命令，
#     靠 applet 软链（清单**在这儿**，只放"干活真用得上"的那些）。
#
# ⚠️ **不许顺手把宿主整套 rootfs 搬进来**：极简镜像是有意的（`39-PERMISSIONS.md`），
#    多一个字节都是它的攻击面。这里只补"助手干活真正要用的那一小撮"。
# ⚠️ `/bin/sh` 指到 bash（Debian 的形状）—— `/etc/passwd` 里写的登录 shell 就是它
#    （第 ③ 段），两边从此一致。
BASH="$(command -v bash || true)"
BUSYBOX="$(command -v busybox || true)"
if [ -x "$BASH" ]; then
  cp "$BASH" "$R/bin/bash"
  ldd "$BASH" | while read -r line; do
    case "$line" in
      *"=>"*) lib="${line##*=> }"; lib="${lib%% *}" ;;
      /*)     lib="${lib%% *}" ;;
      *)      continue ;;
    esac
    [ -f "$lib" ] || continue
    mkdir -p "$R$(dirname "$lib")"
    cp -n "$lib" "$R$lib" 2>/dev/null || true
  done
  ln -sf bash "$R/bin/sh"
  echo "  shell: $BASH → /bin/bash（＋ /bin/sh 指过去）"
else
  echo "✗ 宿主上没有 bash —— 镜像里就没有 shell，盒里跑不了命令（不许这么造）"; exit 4
fi
if [ -x "$BUSYBOX" ] && file "$BUSYBOX" | grep -q "statically linked"; then
  cp "$BUSYBOX" "$R/bin/busybox"
  # ⚠️ **清单在这里，且只放"干活用得上"的**（不是 `--list` 全量：272 个里大半是
  #    系统管理用的，放进来只会扩大攻击面）。少一个 ⇒ 用到时自己加，别图省事全量。
  APPLETS="[ [[ awk base64 basename bunzip2 bzcat bzip2 cat chgrp chmod chown chroot cmp comm cp cpio cut date dd df diff dirname dmesg dos2unix du echo ed egrep env expand expr false fgrep find fold free getopt grep groups gunzip gzip head hexdump hostname id install join kill less link ln logname ls md5sum mkdir mkfifo mktemp more mv nc netstat nl nproc od paste patch pidof ping printf ps pwd readlink realpath rev rm rmdir sed seq sha1sum sha256sum sha512sum shuf sleep sort split stat strings stty tac tail tar tee test time timeout top touch tr traceroute true truncate ts tty uname unexpand uniq unix2dos unlink unxz uptime usleep uudecode uuencode wc wget which who whoami xargs xxd xz xzcat yes zcat"
  for a in $APPLETS; do
    # ⚠️ **`-F` 不能省**：清单里有 `[` 与 `[[` —— 当正则用是**没配对的方括号**，
    #    `grep` 会报错、那两条就**悄悄不漏链**（`[` 是脚本里最常用的命令之一）。
    if "$BUSYBOX" --list 2>/dev/null | grep -qxF -- "$a"; then ln -sf busybox "$R/bin/$a"; fi
  done
  # `/usr/bin/env`：一堆脚本的 shebang 写的是绝对路径 `/usr/bin/env`（本镜像原来**没有 /usr/bin**）
  ln -sf /bin/busybox "$R/usr/bin/env"
  ln -sf /bin/bash "$R/usr/bin/bash"
  ln -sf /bin/bash "$R/usr/bin/sh"
  echo "  busybox: $BUSYBOX → /bin/busybox ＋ $(find "$R/bin" -maxdepth 1 -type l | wc -l) 个 applet 软链"
else
  echo "✗ 宿主上的 busybox 不在或不是静态的 —— 盒里就只有 bash、没有常用命令（不许这么造）"; exit 4
fi

# ── ② 调度器本体 ──
#
# 🔴 **2026-09-23（账 #42）：这里**不再**拷 `src/` 进镜像。**
#    原来镜像里带一份 `src/` 当**兜底**（产品层认不到时回落到它）——
#    代价是"**两处代码**"：跑着的那份到底是哪一份，得看挂载在不在，
#    而"悄悄跑一份旧的"正是这套东西最该防的状态（`45-TENANT-UPDATE.md`）。
#    ⚠️ 拿掉它的**条件**（两台都迁移完、`check-tenant-update.sh --live` 绿）已经满足；
#    拿掉之后**认不到产品层就起不来**（薄加载器会说清为什么，见下面那段）。
#    仍然留在镜像里的那几样是**几 KB 的指针/配置**（人格 · 能力 · 模型代理 patch），
#    它们不是"第二份代码"（`ws` 也在：产品层只带自己的 `src/`，不带 node_modules）。
cp "$CORE/package.json" "$R/app/package.json"
mkdir -p "$R/app/node_modules"
# ⚠️ 只带**真正用到的那一个依赖**（`ws`）—— 不带整个 node_modules（那会把 dev 依赖也搬进去）
if [ -d "$CORE/node_modules/ws" ]; then cp -r "$CORE/node_modules/ws" "$R/app/node_modules/ws"; fi
# 人格层 + 能力层 + MCP 那支脚本（服务开机 preflight 会查它们在不在）
cp "$CORE/hupo-persona.yml" "$R/app/hupo-persona.yml"
[ -f "$CORE/hupo-capabilities.yml" ] && cp "$CORE/hupo-capabilities.yml" "$R/app/hupo-capabilities.yml"

# ── ②·代理：让模型那条路走盒内的 root 小代理（多租户 ②-3）──
# ⚠️ **它现在是仓库里一个真文件**（2026-09-21 改）：
#    原来是这一段 heredoc **生成**出来的 —— 而"生成出来的东西"**进不了产品层的指纹、
#    也进不了评审**。⇒ 搬进 `v2/services/core/hupo-model-proxy.yml`，
#    由**产品层**带着走（`docs/dev/45-TENANT-UPDATE.md`）。
#    这里仍然拷一份：那是**兜底**（新入口优先认产品层，认不到才用镜像里这份）。
MODEL_PATCH="$CORE/hupo-model-proxy.yml"
[ -f "$MODEL_PATCH" ] || { echo "✗ 找不到 $MODEL_PATCH"; exit 2; }
cp "$MODEL_PATCH" "$R/app/hupo-model-proxy.yml"
echo "  模型代理 patch: /app/hupo-model-proxy.yml（兜底那份）"
echo "  服务: **不在镜像里**（在产品层；这里只有一个薄加载器 + ws）"

# ── ②·dsh：**agent 本体**（多租户 ②-1）──
#
# ⚠️ 为什么必须带它：少了它，容器起来了也**没有 agent 可跑** ——
#    服务会 spawn 一个不存在的程序，现象只是"它不理我"（`agent-runtime.js` 里
#    那个 `ENOENT` 还分不清"程序找不到"和"工作目录不存在"）。
#
# ⚠️ **三条实测事实**（2026-09-21，都是先测了才写的）：
#   ① `dsh` 自带 `sdk` profile ⇒ **镜像里不需要带 profile 模板**。
#      空 `DSH_HOME` 直接 `dsh --profile sdk --dump-config` 就出 11178 字节的树；
#      我自己往镜像里塞模板是**多余**的（而且会多一份会漂的东西）。
#      （实测踩过：`--from-default-profile sdk` 会被它自己拒掉 ——
#        "profile sdk is shipped and cannot be a custom profile target"。）
#   ② 起的过程中**不碰任何包管理器 / registry**（实测 grep `pnpm|npm install|registry` = 0）
#      ⇒ 这台机器够不着 Docker Hub 也不影响。
#   ③ `bin.js` 只用 `process.argv.slice(2)`（**不看 argv[1]**），而且
#      **不直接调 shell**（没有 `exec(` / `shell:true` / `/bin/sh` 字面量）
#      ⇒ 可以用一个三行的启动器，也**不需要**往镜像里塞 `/bin/sh`。
#
# ⚠️ **启动器为什么是"改 shebang"而不是"包一层"**（2026-09-21，我两种都真的试了）：
#    镜像里没有 `/usr/bin/env`，而 `bin.js` 的 shebang 正是 `#!/usr/bin/env node`
#    ⇒ 直接执行它一定失败。
#    * ❌ **包一层不行**：写个 `import '.../bin.js'` 的启动器，进程会**静默退出 0、一个字都不输出**。
#      根因在 `bin.js` 最后一行：`if (import.meta.main) await runCli();` ——
#      被 import 时 `import.meta.main` 是 **false**（入口变成了启动器），
#      于是 `runCli()` **一次都没调**。⇒ 这类"包装一下就哑了"的坑正好是这个项目最忌的。
#    * ✅ **改 shebang 可以**：把**拷进来那一份**的第一行换成 `#!/bin/node`，
#      然后 `/bin/dsh` 直接指向它。此时它**仍然是被执行的入口** ⇒ `import.meta.main` 为真、
#      它自己那些**相对路径**的 `import("./plugin-….js")` 也照旧解析（没有搬家）。
DSH_BIN="$(command -v dsh || true)"
if [ -n "$DSH_BIN" ]; then
  DSH_PKG="$(dirname "$(dirname "$(readlink -f "$DSH_BIN")")")"
  if [ -d "$DSH_PKG/node_modules" ]; then
    mkdir -p "$R/app/node_modules/@deepseek-ai"
    echo "  dsh:  $DSH_PKG（$(du -sh "$DSH_PKG" | cut -f1)）—— 拷进去要一会儿"
    cp -r "$DSH_PKG" "$R/app/node_modules/@deepseek-ai/dsh"
    DSH_ENTRY="$R/app/node_modules/@deepseek-ai/dsh/lib/bin.js"
    sed -i '1s|^#!/usr/bin/env node$|#!/bin/node|' "$DSH_ENTRY"
    # ⚠️ **判据要卡在"真换了没有"上**：sed 没匹配上会**静默不改**，而那种镜像
    #    照样能 commit（现象是容器里 `dsh` 起不来）。
    [ "$(head -1 "$DSH_ENTRY")" = '#!/bin/node' ] \
      || { echo "✗ dsh 的 shebang 没换成 /bin/node —— 镜像里没有 /usr/bin/env，它一定跑不动"; exit 4; }
    chmod 755 "$DSH_ENTRY"
    ln -sf /app/node_modules/@deepseek-ai/dsh/lib/bin.js "$R/bin/dsh"
    echo "  dsh:  已放进 /app/node_modules + /bin/dsh（shebang 换成 /bin/node）"
  else
    echo "  ⚠️ dsh 的 node_modules 不在 $DSH_PKG —— 跳过了（agent 会在容器里起不来）"
  fi
else
  echo "  ⚠️ 宿主上没有 dsh —— 跳过了（agent 会在容器里起不来）"
fi

# ── ②′ 入口：先把卷里的目录建出来，再起服务 ──
# ⚠️ 为什么不能在镜像里建 `/data/hupo-workspace`：`/data` 是**挂载卷**
#    ⇒ 镜像里那一层会被卷**盖住**（第一次跑就是个空卷）。
#    所以"开机建目录"这件事必须由一个**入口**来做，而 scratch 里没有 shell
#    ⇒ 用一个 30 行的 node 入口（node 本来就在镜像里）。
cat > "$R/app/entry.mjs" <<'ENTRY'
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { pathToFileURL } from 'node:url';

// ════════════════════════════════════════════════════════════
// **镜像里的入口：一个薄加载器**（契约 `docs/dev/45-TENANT-UPDATE.md`）。
//
//   它只做三件：① 找到**产品层**在哪（找不到就回落到镜像里那份）② 把**版本指纹**
//   从产品层的 `manifest.json` 读出来塞进 env ③ 把产品层那个真入口跑起来。
//
//   ⚠️ **别往这里加东西**：这里的东西**只能靠重造镜像改**，
//      而"改一次接线就要重造镜像"已经在这个项目里连栽两次（见产品层 `src/entry.mjs` 那段）。
//   ⚠️ 回落到镜像里那份时 `manifest.json` 不在 ⇒ 版本是 `dev` ⇒ **宿主会看见并如实说**
//      （不许静默：一台悄悄跑着旧的，是这套东西最该防的那种状态）。
// ════════════════════════════════════════════════════════════
function pickCodeDir() {
  const want = process.env.HUPO_CODE_DIR ?? '';
  if (!want) return { dir: '', why: '宿主没给 HUPO_CODE_DIR' };
  if (!nodeFs.existsSync(nodePath.join(want, 'src', 'entry.mjs'))) {
    return { dir: '', why: `产品层里没有 ${want}/src/entry.mjs` };
  }
  return { dir: want, why: '' };
}

const picked = pickCodeDir();
// 🔴 **2026-09-23（账 #42）：镜像里那份 `src/` 兜底**已经拿掉** ⇒ 认不到产品层就**起不来**。
//    为什么不悄悄回落：那会变成"两台跑着不同的代码，而界面上看不出来"。
//    ⇒ 跑不了就说跑不了，并说清**怎么办**（宿主上那条软链 + 重开一次）。
if (!picked.dir) {
  console.error('  ✗ 找不到产品层，这一台起不了：' + picked.why);
  console.error('    怎么办：在宿主上确认 /srv/hupo/tenant-code/current 在（bash scripts/build-tenant-code.sh --list），');
  console.error('    然后重开这一台（宿主会发现指纹不同、叫它重开；或由主人显式重启那个单元）。');
  process.exit(1);
}
const CODE = picked.dir;
process.env.HUPO_CODE_DIR = CODE;

// 🔴 **指纹**：容器要能如实说"我跑的是哪一版"。它**只**来自产品层的 `manifest.json`
//    —— 算指纹的地方**只有一处**（`scripts/build-tenant-code.sh`），这里**不许**再算一遍。
let BUILD = 'dev';
try {
  const m = JSON.parse(nodeFs.readFileSync(nodePath.join(CODE, 'manifest.json'), 'utf8'));
  if (typeof m?.fingerprint === 'string' && m.fingerprint) BUILD = m.fingerprint;
} catch {
  /* 产品层少了 manifest（按理不会）⇒ 如实报 `dev`，**不许**编一个指纹出来 */
}
// ⚠️ **必须在产品层那个入口被 import 之前设**：`config.js` 是**被 import 的那一刻**读 env 的。
process.env.HUPO_BUILD_ID = BUILD;
console.log(`  产品层：${CODE} · 版本 ${BUILD}`);

await import(pathToFileURL(nodePath.join(CODE, 'src', 'entry.mjs')).href);

ENTRY
echo "  入口: /app/entry.mjs（薄加载器 —— 真正的入口在产品层 src/entry.mjs）"

# ── ③ 最小的 /etc（node 与 shell 都要用）──
# ⚠️ 两个身份（容器内权限席的结论）：**服务/终端 = root**（uid0→宿主租户），
#    **agent 的手 = uid 1000**。理由：userns 的 root 有 CAP_DAC_OVERRIDE
#    ⇒ agent 若是 uid0，**任何权限位都拦不住它读 key**。
#
# 🔴 主人 2026-09-21 拍板 ①：**agent 读不到自己的 key**（"原则上就是 agent 读不到"）。
#    ⇒ 由此**推出运行时要带哪几条能力**（实测验出来的，见 39-PERMISSIONS.md §5.4）：
#
#      --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE \
#                     --cap-add=SETUID --cap-add=SETGID --security-opt=no-new-privileges
#
#    · SETUID/SETGID  ：root 服务**把 agent 降权到 1000** 的唯一办法。
#                       实测：全丢 ⇒ 降权 EPERM（边界根本装不上）；补上 ⇒ 成。
#    · CHOWN          ：把 main/workspaces/hupo 交给 1000。实测：没有它 ⇒ chown EPERM。
#    · DAC_OVERRIDE   ：服务要读**用户自己的**话（/data/main 是 1000:0700）。
#                       实测：没有它 ⇒ root 读 main.jsonl 也 EACCES（那是它该读的东西）。
#    · ⚠️ **`FOWNER` 又加回来了**（2026-09-21 真重启之后改的）：
#      "chmod 放在 chown 之前"那条只对**第一次**开机成立 —— 重启时那几格**已经属于 agent**，
#      root 再 chmod 就需要 `FOWNER`，少了它**容器第二次就起不来**。
#      多这一条**不改变边界**：root 本来就有 `DAC_OVERRIDE`（比它更强），
#      而"agent 是 uid 1000、不是 root"这条没动。
#    · ❌ **dpkg 那组（FSETID/SETFCAP/MKNOD/KILL/SYS_CHROOT）已经不给了** ——
#      它们原来的理由是"agent 要 apt 装包"，而决定 ① 把这个理由拿掉了
#      （apt = root = 读得到 key，与 ① 不可兼得）。⇒ 10 条收到 4 条。
cat > "$R/etc/passwd" <<'EOF'
root:x:0:0:root:/data:/bin/sh
agent:x:1000:1000:agent:/data/main:/bin/sh
EOF
cat > "$R/etc/group" <<'EOF'
root:x:0:
agent:x:1000:
EOF
echo "127.0.0.1 localhost" > "$R/etc/hosts"
echo "nameserver 10.0.2.3" > "$R/etc/resolv.conf"

# ── ③·补 🔴 **agent（uid 1000）必须读得到 /app**（2026-09-21 真机抓到的）
#
# 现象：新号在界面上说什么，盒子里的时间线**永远只出一句**
#       "你刚才那句我没来得及做，就卡住了。再说一次吧。"
#       —— 而盒内日志**一行都不多**（那个退是被 `#closeUndelivered` 收掉的）。
#
# 根因：dsh 是**以 agent 的身份（uid 1000）**起来的，而它开机第一件事就是读
#   `--patch` 那几份文件。`cp` 把仓库里的权限一起带过来了（`hupo-persona.yml`
#   与 `hupo-capabilities.yml` 在仓库里是 **600**），于是：
#
#       Error: dsh: failed to read overlay /app/hupo-persona.yml:
#              EACCES: permission denied
#
#   ⇒ dsh 当场退（status 1），**一个字都没机会说**。
#   `A9` 之外的另一半：**"权限位"不只在"不许谁读"，也在"该读的人读不读得到"**。
#
# ⚠️ 为什么 `a+rX` 是安全的：镜像里**没有任何秘密** ——
#    那把 key 是**运行时**才进 `/data/creds.yaml`（它的来源见 `46-KEY-DELIVERY.md`），
#    **不在镜像里**。而 `/app` 里是 dsh、调度器源码、人格/能力 patch（都在 git 里）。
#    决策 ① 要保护的是"**agent 读不到自己的 key**"，不是"agent 读不到代码"。
# ⚠️ `X`（大写）只给**目录**和**本来就可执行**的文件加 x —— 不会把数据文件变成可执行。
chmod -R a+rX "$R/app"

# ── ③·补2 🔴 **原生模块自己的动态库也要带上**（2026-09-21 真机抓到的第二个断点）
#
# 上面 ① 只 `ldd` 了 **node 自己**的依赖 ⇒ node 跑得起来，
# 但 `node-pty` 那个 `.node` 有**它自己的**依赖，而 scratch 镜像里没有：
#
#     ERR_DLOPEN_FAILED libutil.so.1: cannot open shared object file
#
# 而它的表现极难查：dsh 报的是
#     `dsh: plugin tree failed to load: ... failed to import loader entry subprocess`
#   —— **一个字都没提"缺库"**，因为 node-pty 的加载器把 dlopen 的失败
#      吞成了"找不到模块"（`Cannot find module './prebuilds/linux-x64/pty.node'`）。
#   ⇒ 现象和"文件没拷进去"**一模一样**，而文件明明在那儿。
#
# ⚠️ 所以：**凡是从别处拷进来的二进制（可执行的、或要被 dlopen 的），
#    都得对它自己 ldd 一遍**。（node 那一条覆盖不到 `.node`。）
for so in $(find "$R/app" -name '*.node' 2>/dev/null); do
  ldd "$so" 2>/dev/null | while read -r line; do
    case "$line" in
      *"=>"*) lib="${line##*=> }"; lib="${lib%% *}" ;;
      /*)     lib="${line%% *}" ;;
      *)      continue ;;
    esac
    [ -f "$lib" ] || continue
    mkdir -p "$R$(dirname "$lib")"
    cp -n "$lib" "$R$lib" 2>/dev/null || true
  done
done
echo "  库（含原生模块的）: $(find "$R" -name '*.so*' | wc -l) 个"

# ── ④ 提交成镜像 ──
ctr="$("$BUILDAH" from scratch)"
"$BUILDAH" copy "$ctr" "$R/" / >/dev/null
# ⚠️ **`HUPO_DSH_BIN` 要给绝对路径**：scratch 镜像的 PATH 不由我们决定，
#    而 `resolveDshBin()` 默认只是 `dsh` ⇒ 不给这一条就可能 spawn 不到。
# ⚠️ **注释不许写在续行命令中间**（2026-09-21 我真踩了）：`\` 之后那一行的 `#`
#    **不是注释**（那一行已经被拼进同一条命令了）⇒ 整条 `buildah config` 会失败，
#    镜像**没有 Cmd/Env**，而脚本**照样打印"镜像好了"**（因为 commit 还是成功的）。
#    ⇒ 所以注释放在**整条命令之前**。
"$BUILDAH" config \
  --workingdir /app \
  --env HUPO_DATA=/data \
  --env HUPO_PORT=8080 \
  --env HUPO_HOST=0.0.0.0 \
  --env HUPO_WEB=/nonexistent \
  --env HUPO_AGENT_CWD=/data/main \
  --env HUPO_DSH_BIN=/bin/dsh \
  --env HUPO_AGENT_UID=1000 \
  --env HUPO_AGENT_GID=1000 \
  --env DSH_HOME=/data/dsh \
  --env HUPO_MODEL_TICKET=hupo-local-model-proxy \
  --env HUPO_TRUSTED_SOCKET=/run/hupo/local-api.sock \
  --env HUPO_LOCAL_TARGET=/run/hupo/local-api.sock \
  --cmd '["/bin/node","/app/entry.mjs"]' \
  "$ctr" >/dev/null || { echo "✗ buildah config 失败 —— 镜像会缺 Cmd/Env，不许往下走"; exit 3; }
"$BUILDAH" commit "$ctr" "$IMG" >/dev/null
"$BUILDAH" rm "$ctr" >/dev/null
echo "✅ 镜像好了：$IMG（$( "$PODMAN" images --format '{{.Size}}' "$IMG" | head -1)）"

[ "$DO_RUN" = "1" ] || { echo "（想顺手跑一台：加 --run）"; exit 0; }

# ── ⑤ 跑两台：**没产品层必须起不来 · 有产品层必须起来**（账 #42 · 2026-09-23）──
#
# ⚠️ 为什么是两台：镜像里那份 `src/` 兜底拿掉之后，"认不到产品层"**不再是**一个
#    "悄悄跑旧的"的分支，而是一个**必须说出来**的失败。⇒ 判据也得两边都钉：
#    只验"能起来"的话，回落那条路**永远验不到**（而它正是刚刚被拿掉的那个东西）。
echo "▶ ⑤·甲 没挂产品层 ⇒ **必须起不来**（拿掉兜底之后这是正确行为）"
PORT="${HUPO_TENANT_PORT:-18090}"
DATA="$(mktemp -d)"
PASS=0; FAIL=0
ok() { printf '  ✅ %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  ✗ %s\n' "$*"; FAIL=$((FAIL + 1)); }

# ⚠️ 这一台**本来就该立刻退**（loader `process.exit(1)`）⇒ **前台跑**、直接抓它的
#    stdout/stderr。用 `-d` + `podman logs` 会**扑空**：`--rm` 在它退出那一刻就把容器收了
#    （第一版就是这么扑空的：日志尾巴是一句 "no such container"）。
out="$("$PODMAN" run --rm \
    -p "127.0.0.1:$PORT:8080" -v "$DATA:/data" \
    --read-only --tmpfs /tmp --tmpfs /run/hupo:rw,nosuid,nodev,mode=0700 \
    --security-opt=no-new-privileges \
    --cap-drop=ALL \
    --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID --cap-add=FOWNER \
    --pids-limit=512 --memory=768m --memory-swap=768m \
    "$IMG" 2>&1)"
rc=$?
echo "  退出码 $rc（**不为 0 才对**）· 数据 $DATA · 口 127.0.0.1:$PORT"
[ "$rc" -ne 0 ] && ok "它**退出了**（没有赖着起一个没有代码的服务）" || bad "退出码 0 —— 它起来了？"
if printf '%s' "$out" | grep -q '找不到产品层'; then
  ok "它**说清了**为什么起不来（那句人话在）"
else
  bad "没看到那句人话 —— 输出尾巴：$(printf '%s' "$out" | tail -2 | tr '\n' ' ')"
fi
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/version" 2>/dev/null || true)"
[ "$code" != "200" ] && ok "接口**没有**起来（code=${code:-无}）" || bad "竟然起来了（code=200）—— 说明兜底还在"

echo "▶ ⑤·乙 挂了产品层 ⇒ **必须起来**，而且自报当前指纹"
CODE_ROOT="${HUPO_CODE_ROOT:-/srv/hupo/tenant-code}"
CODE_NOW="$(readlink "$CODE_ROOT/current" 2>/dev/null | sed 's|.*/||')"
if [ -z "$CODE_NOW" ] || [ ! -d "$CODE_ROOT/current/src" ]; then
  bad "宿主上没有可用的产品层（$CODE_ROOT/current）⇒ 这一半**没验**"
else
  PORT2=$((PORT + 1))
  cid2="$("$PODMAN" run -d --rm \
      -p "127.0.0.1:$PORT2:8080" -v "$DATA:/data" \
      -v "$CODE_ROOT/current:/app/code:ro" --env HUPO_CODE_DIR=/app/code \
      --read-only --tmpfs /tmp --tmpfs /run/hupo:rw,nosuid,nodev,mode=0700 \
      --security-opt=no-new-privileges \
      --cap-drop=ALL \
      --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=SETUID --cap-add=SETGID --cap-add=FOWNER \
      --pids-limit=512 --memory=768m --memory-swap=768m \
      "$IMG" 2>&1 | tail -1)"
  for _ in $(seq 1 20); do
    code2="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT2/api/version" 2>/dev/null || true)"
    [ "$code2" = "200" ] && break
    sleep 0.5
  done
  [ "$code2" = "200" ] && ok "/api/version → 200" || bad "/api/version → ${code2:-（没起来）}"
  logs2="$("$PODMAN" logs "$cid2" 2>&1 || true)"
  printf '%s' "$logs2" | grep -q "版本 $CODE_NOW" && ok "自报版本 = 当前指纹（$CODE_NOW）" || bad "没自报当前指纹（应为 $CODE_NOW）"
  echo -n "  对外开了吗："; ss -ltn 2>/dev/null | grep ":$PORT2" | awk '{print $4}' | tr '\n' ' '; echo "（应只有 127.0.0.1）"
  echo -n "  根真只读吗（挑存在的 /etc/hosts）："
  "$PODMAN" exec "$cid2" /bin/node -e 'try{require("node:fs").appendFileSync("/etc/hosts","# canary\n");console.log("🔴 写得进去 —— 根不是只读")}catch(e){console.log("✅ 【"+e.code+"】")}' 2>/dev/null

  # ── ⑤·丙 **盒里那条命令真跑得起来**（2026-09-25 主人拍板「甲」· B18）──────────
  #
  # 🔴 判据要打在**DSH 真正会拼的那条 argv** 上：DSH 的 bash 工具是
  #    `["bash","-c",命令]`（`dsh-bash-local` 里写死的），**按 PATH 找 `bash`**。
  #    ⇒ 这里**故意写 `bash`（不写绝对路径）**：那才是它那条路；
  #      顺带验 `/bin/bash`、`/bin/sh`、applet、以及 `/usr/bin/env`（shebang 那一路）。
  insh() { "$PODMAN" exec "$cid2" /bin/bash -c "$1" 2>&1; }
  echo "  盒里那条命令（DSH 拼的就是 bash -c 这一条）："
  out_p="$(insh 'bash -c "echo hi"')"
  printf '%s' "$out_p" | grep -qx 'hi' && ok "`bash -c 'echo hi'` → hi（**PATH 上找得到 bash**）" \
                                     || bad "跑不起来：$(printf '%s' "$out_p" | tail -1)（盒里还是没 shell？）"
  [ "$(insh 'readlink -f /bin/sh')" = "/bin/bash" ] && ok "/bin/sh → /bin/bash（与 /etc/passwd 里写的那个一致）" \
                                                  || bad "/bin/sh 没指到 bash：$(insh 'ls -l /bin/sh')"
  a_ok=1
  for a in ls cat grep sed awk env find cp mv rm chmod tar; do
    insh "command -v $a >/dev/null" || { a_ok=0; echo "    ✗ 缺 $a"; }
  done
  [ "$a_ok" = "1" ] && ok "常用命令都在（ls/cat/grep/sed/awk/env/find/cp/mv/rm/chmod/tar）" || bad "有常用命令缺（见上）"
  [ "$(insh '/usr/bin/env node -e "console.log(1)"')" = "1" ] && ok "/usr/bin/env node …（shebang 那一路通）" || bad "/usr/bin/env 那一路不通"
  # ⚠️ **负向对照**：我们装的是**一个 shell ＋ 一小撮命令**，不是"什么都有" ——
  #    `python3` 不在里面，它必须**照样找不到**（否则说明这份清单根本没被当回事）。
  if insh 'command -v python3 >/dev/null'; then bad "python3 居然在 —— 我们装多了？（判据失去意义）"; else ok "负向对照：python3 仍然**不在**（只补了该补的）"; fi

  # ⚠️ **先取日志、再杀**：`--rm` 一杀就什么都没了（上面那一台已经栽过一次）
  echo "  日志尾巴（有产品层那台）："
  "$PODMAN" logs "$cid2" 2>&1 | tail -4 | sed 's/^/    /' || true
  "$PODMAN" kill "$cid2" >/dev/null 2>&1
fi

echo "（容器已收，数据留在 $DATA）"
echo
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 镜像自检全过（$PASS 条）—— 没产品层起不来 · 有产品层起得来"
else
  echo "✗ 镜像自检有 $FAIL 条没过（过 $PASS 条）"
  exit 1
fi
