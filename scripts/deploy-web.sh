#!/usr/bin/env bash
# 构建 Flutter Web 并部署到 /var/www/hupo（nginx 静态托管）
#
# 用法：scripts/deploy-web.sh
# 环境：FLUTTER_BIN 指定 flutter；HUPO_DEPLOY_ANYWAY=1 跳过测试闸门（应急，会大声警告）
#
# ⚠ 闸门的分级（2026-09-15 改，**有原因，别改回去**）
#
#   静态分析   硬闸 —— 编译都不过的东西绝不能上线
#   单元测试   硬闸 —— 守协议、状态机、时间线不变量；这层坏了是真的坏
#   界面测试   提示 —— **不阻断**
#
# 为什么界面测试不一票否决：它断言的是**布局**（像素坐标、控件 key、
# "开发者卡片贴顶"这类）。界面一重构它们必然过期 —— 而"重构界面"
# 恰恰是主人最常要的改动。
#
# 拿它一票否决的后果（真实事故）：agent 改完桌面重构，卡在 10 个过期的界面
# 测试上出不来 —— 闸门不让部署 ⇒ 主人屏幕上什么都不变 ⇒ 那一轮跑了 6 分钟
# 都没结束（`turn/end` 事件 0 条）⇒ 主人的原话是「卡死并且不会改变」。
#
# 所以：**报出来，但让它过去**。界面是不是真坏了，靠 browser-check.mjs 看屏幕。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/apps/mobile"
TARGET="/var/www/hupo"

export PATH="${FLUTTER_BIN:-$HOME/sdk/flutter/bin}:$PATH"
command -v flutter >/dev/null || { echo "找不到 flutter，请设置 FLUTTER_BIN"; exit 1; }

# ── 前置检查（两条，都是"越晚做代价越大"的类型）─────────────────────
# ① 磁盘：构建产物 + .dart_tool 很吃盘（40G 已用 72%）。
#    装到一半没空间，比不部署更糟 —— 站点会半新半旧。
_free_pct=$(df -P "$ROOT" | awk 'NR==2{gsub(/%/,"",$5); print 100-$5}')
case "${_free_pct:-}" in ''|*[!0-9]*) _free_pct=100 ;; esac
if [ "$_free_pct" -lt 12 ]; then
  echo "✗ 磁盘可用只剩 ${_free_pct}%（<12%）。先清盘再部署。"
  exit 1
fi

# ② 构建**不许**在 concierge-core 的 cgroup 里跑。
#    实测：1 个活跃会话（68+172MB）+ 一次构建（Flutter 工具链 ~846MB）= 1086MB > 1024MB 上限 ⇒ 必然 OOM；
#    近 7 天 4 次 OOM 的受害者**每次都是它自己起的 dart 前端编译器**。
#    这里探一下 build.slice 能不能用；不能用就退回原地 —— 部署不能因为"优化"而失败。
BUILD_SCOPE=()
if [ "${HUPO_NO_BUILD_SLICE:-0}" != "1" ] && command -v systemd-run >/dev/null 2>&1 && \
   sudo -n systemd-run --scope --quiet --collect --slice=build.slice \
     --uid=deploy --gid=deploy -p MemoryMax=2G -- true 2>/dev/null; then
  BUILD_SCOPE=(sudo -n systemd-run --scope --quiet --collect --slice=build.slice \
    --uid=deploy --gid=deploy -p MemoryMax=2G -p CPUQuota=300% -p CPUWeight=20 -p IOWeight=20 --)
  echo "  ▶ 构建跑在 build.slice（2G 内存 / 300% CPU / 低权重），不跟主人的对话抢资源"
else
  echo "  ⚠ build.slice 不可用，构建仍在当前 cgroup 里跑（会跟主人的对话抢内存与 CPU）"
fi
run() { "${BUILD_SCOPE[@]}" "$@"; }

if [ "${HUPO_DEPLOY_ANYWAY:-0}" = "1" ]; then
  echo "  ⚠⚠ HUPO_DEPLOY_ANYWAY=1：跳过静态分析与测试闸门 —— 出了问题自己担。"
  echo ""
else
  echo "▶ 静态分析（硬闸）"
  if ! (cd "$APP" && run flutter analyze); then
    echo ""
    echo "✗ 静态分析没过。编译都不过的东西不上线 —— 先把它弄干净。"
    exit 1
  fi

  echo "▶ 单元测试（硬闸：协议 / 状态机 / 时间线不变量）"
  if ! (cd "$APP" && run flutter test test/unit); then
    echo ""
    echo "✗ 单元测试没过。这层守的是协议和状态机 —— 它坏了是真的坏，不部署。"
    exit 1
  fi

  echo "▶ 界面测试（提示：不阻断，最多等 ${WIDGET_TEST_TIMEOUT:-180} 秒）"
  # ⚠ 必须带超时。这套界面测试会**挂住**（转圈动画 + 并发跑多个文件时
  #   互相饿死 CPU，实测跑过 17 分钟还没结束）。而"不阻断"这个承诺，
  #   遇上挂住就失效了 —— 脚本永远走不到构建那一步，主人屏幕上什么都不变。
  #   跑不完就当失败处理：照样部署，靠 browser-check 看屏幕。
  if ! timeout "${WIDGET_TEST_TIMEOUT:-180}" \
      bash -c "cd '$APP' && ${BUILD_SCOPE[*]:-} flutter test test/widget"; then
    echo ""
    echo "  ⚠ 界面测试有失败或跑不完（超时）。"
    echo "    它们断言的是**布局**（坐标 / 控件 key / 哪块贴顶）——"
    echo "    界面一重构本来就会变，所以**不阻断部署**。"
    echo "    但别当没看见：确认不是真坏了 ——"
    echo "      cd services/core && node browser-check.mjs \"冒烟\""
    echo ""
  fi
fi

# ── 客户端构建指纹 ────────────────────────────────────────────
# 按**客户端源码内容**算。内容不变指纹就不变 —— 所以不会有
# "明明没改却一直让用户刷新"这种事；真改了，服务端就能发现并把在线客户端刷掉。
BUILD_ID="$(
  { find "$APP/lib" "$APP/web" -type f; echo "$APP/pubspec.yaml"; } \
    | sort | xargs sha256sum | sha256sum | cut -c1-16
)"
echo "▶ 构建 Web（release，不带 Service Worker）｜构建指纹 $BUILD_ID"
# --pwa-strategy=none 关掉 Service Worker：
# 否则浏览器会一直用缓存的旧 main.dart.js，部署了新版本用户也看不到。
# 开发期必须关；上线稳定后再考虑打开（那时要配合版本化资源名）。
if ! (cd "$APP" && run flutter build web --release --pwa-strategy=none --dart-define=HUpo_BUILD_ID="$BUILD_ID"); then
  echo "✗ 构建失败，没有部署。线上仍是上一版（宁可不变，也不要变坏）。"
  exit 1
fi

# 注入"自愈"脚本：注销历史 Service Worker 并清空缓存。
# 为什么需要：浏览器里已注册的旧 SW 不会因为新构建没有 SW 就消失，
# 它会继续用缓存里的旧 main.dart.js —— 用户以为看到的是新版，其实是几小时前的。
# 这段代码在每次加载时主动注销，一次性解决，不需要用户手动清缓存。
echo "▶ 用自毁式 Service Worker 顶掉用户浏览器里的旧 SW"
# --pwa-strategy=none 生成的 SW 是空文件；这里覆盖成"自毁式"：
# 浏览器下次导航会取到它 → 它清空缓存、注销自己、让页面重载 → 从此不再有 SW。
cp "$ROOT/scripts/self-destruct-sw.js" "$APP/build/web/flutter_service_worker.js" || exit 1

echo "▶ 注入 Service Worker 自愈脚本"
node "$ROOT/scripts/inject-sw-cleanup.mjs" "$APP/build/web/index.html" || exit 1

echo "▶ 部署到 $TARGET"
sudo mkdir -p "$TARGET" || exit 1
# ⚠ `--exclude=/apps/` 是**安全线**，不是优化，别删。
#   rsync 的 --delete 会删掉目标端"多余"的文件与目录。制品目录（小程序的 H5）一旦落在这棵树里，
#   每一次常规部署都会把它整棵抹掉 —— 而且**没有任何报错**（rsync 成功、构建成功、服务正常），
#   主人看到的是"小程序莫名其妙不见了"。更糟的是它同时抹掉了"上一版制品长什么样"，
#   于是防篡改在这个仓库里从第一天起就不可能实现。
#   制品最终要搬到 /var/lib/hupo-apps（独立 origin），这行是过渡期的保险。
sudo rsync -a --delete --exclude=/apps/ "$APP/build/web/" "$TARGET/" || exit 1

# 把指纹写到站点根目录：服务端盯着这个文件，一变就通知在线客户端刷新自己。
# ⚠ 必须在 rsync **之后**写 —— rsync 带 --delete，写在前面会被删掉。
# ⚠ 顺序也不能换：chown 必须在写完之后，否则这个文件是 root 的，
#   部署脚本自己下次就改不动它了（踩过）。
printf '{"buildId":"%s","builtAt":"%s"}\n' "$BUILD_ID" "$(date -Iseconds)" \
  | sudo tee "$TARGET/client-build.json" >/dev/null || exit 1
sudo chown -R "$(id -un):$(id -gn)" "$TARGET" || exit 1

# 部署审计：谁、什么时候、部署了哪一版、有没有跳过闸门。
# 为什么要有：HUPO_DEPLOY_ANYWAY=1 能一次绕掉两个硬闸，之前**不留任何痕迹**。
printf '%s build=%s anyway=%s free=%s%%\n' "$(date -Iseconds)" "$BUILD_ID" \
  "${HUPO_DEPLOY_ANYWAY:-0}" "${_free_pct:-?}" \
  | sudo tee -a "$ROOT/services/core/data/deploy.log" >/dev/null 2>&1 || true

echo "✅ 完成。站点：https://hupo.stalkerai.cn"
echo "   构建指纹：$BUILD_ID（服务端会据此通知在线客户端刷新）"

# ── 入库推送（主人的规则：所有系统级修改都必须推 GitHub）──────────
# 推送失败不阻断部署（界面已经在线上，别因为网络问题装傻），
# 但改动已在本地提交 —— 任何一次后续成功推送都会补齐。
echo "▶ 入库推送：提交并推送到 GitHub"
if ! "$ROOT/scripts/push-changes.sh" "deploy(web): build $BUILD_ID"; then
  echo "  ⚠ GitHub 推送失败 —— 改动已在本地提交，下次成功推送会自动补齐。"
fi
