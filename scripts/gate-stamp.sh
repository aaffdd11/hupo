#!/usr/bin/env bash
# **全闸那一枚"留戳"**：同一棵树刚跑过 ⇒ 再跑就当场拦住（要真重跑得明写 `--again`）。
#
# 用法：
#   scripts/gate-stamp.sh check  client|server          # 刚跑过（同树、且在窗口内）⇒ 退出 0
#   scripts/gate-stamp.sh write  client|server [一句话] # 跑完写戳
#   scripts/gate-stamp.sh fingerprint client|server     # 只打印指纹
#
# ── 为什么要有它（读数 `docs/dev/212` · 契约 `docs/dev/213`）────────────
#   最贵的那一轮里，**同一道全闸被跑了两遍（还并行）**：工具时间 2,138 秒里
#   **1,454 秒**是它。而"别跑两遍"原来只是**纪律**（`AGENTS.md` §5.0·补 第 2 条）——
#   这个项目的规矩是：**光记纪律没用，改成结构上不可能**。
#
# 🔴 **四条不许破**：
#   ① 指纹**只认内容**：客户端/服务端的源码 ＋ 判据 ＋ 那份依赖清单 ＋ **工具链版本**；
#      任何一样变了 ⇒ 戳作废（照跑，不偷懒）；
#   ② **读不出来 / 文件不在 / 解析失败 ⇒ 一律当"该跑"**（fail-closed，绝不因为"读不出"而跳过）；
#   ③ 窗口只有 **30 分钟**（`WINDOW_S`）：超过就是新的一次收尾，照跑；
#   ④ 戳**只落本机**（`data/` 下那个 json）—— 它不是判据，只是一句"刚跑过"。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/v2/services/core"
APP="$ROOT/v2/apps/mobile"
STAMP="$CORE/data/gate-stamp.json"
WINDOW_S=1800

usage() { echo "用法：scripts/gate-stamp.sh check|write|fingerprint client|server [一句话]" >&2; exit 2; }

fp_of() { # fp_of client|server
  local which="$1" tool="" out=""
  case "$which" in
    client)
      tool="$("${FLUTTER_BIN:-$HOME/sdk/flutter/bin/flutter}" --version 2>/dev/null | head -1)"
      out="$( { find "$APP/lib" "$APP/test" -type f -name '*.dart' -print0 2>/dev/null; \
                printf '%s\0' "$APP/pubspec.yaml" "$APP/pubspec.lock"; } \
              | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 )"
      ;;
    server)
      tool="$(node --version 2>/dev/null)"
      out="$( { find "$CORE/src" "$CORE/test" -type f -print0 2>/dev/null; \
                printf '%s\0' "$CORE/package.json" "$CORE/package-lock.json"; } \
              | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 )"
      ;;
    *) usage ;;
  esac
  # 🔴 任何一个空 ⇒ 空指纹（调用方会当成"该跑"）
  [ -n "$out" ] || { echo ""; return; }
  printf '%s|%s\n' "$out" "$tool"
}

read_field() { # read_field <json 字段名>（数字与字符串两种写法都认）
  [ -f "$STAMP" ] || return 1
  grep -o "\"$1\":[^,}]*" "$STAMP" 2>/dev/null | head -1 | sed -E 's/^"[^"]*":("?)(.*)$/\2/; s/"$//'
}

action="${1:-}"; which="${2:-}"; note="${3:-}"
case "$action" in
  fingerprint)
    fp_of "$which" | cut -d'|' -f1
    ;;
  check)
    cur="$(fp_of "$which")"
    [ -n "$cur" ] || exit 1                       # 指纹读不出 ⇒ 该跑
    cur="${cur%%|*}"                              # ⚠️ 只比**内容那一半**（工具链那半写在戳里备查）
    was="$(read_field "fp_$which")" || exit 1
    [ -n "$was" ] || exit 1
    at="$(read_field "at_$which")" || exit 1
    [ -n "$at" ] || exit 1
    [ "$was" = "$cur" ] || exit 1                 # 树变了 ⇒ 该跑
    now="$(date +%s)"
    [ "$now" -ge "$at" ] || exit 1
    [ "$(( now - at ))" -le "$WINDOW_S" ] || exit 1
    mins=$(( (now - at) / 60 ))
    echo "  （这一版 ${mins} 分钟前刚跑过全闸：$(read_field "note_$which")）"
    echo "  ⇒ 同一棵树、同一个工具链，**不重复跑**；真要再跑一遍：加 --again"
    exit 0
    ;;
  write)
    cur="$(fp_of "$which")"
    [ -n "$cur" ] || { echo "  ⚠️ 指纹算不出来 ⇒ 这一枚戳没写（下次照跑）" >&2; exit 0; }
    fp="${cur%%|*}"; tool="${cur#*|}"
    now="$(date +%s)"
    # 另一侧那份戳要留着（两边各有各的）
    other_fp="$(read_field "fp_$([ "$which" = client ] && echo server || echo client)" || true)"
    other_at="$(read_field "at_$([ "$which" = client ] && echo server || echo client)" || true)"
    other_note="$(read_field "note_$([ "$which" = client ] && echo server || echo client)" || true)"
    mkdir -p "$(dirname "$STAMP")"
    if [ "$which" = client ]; then
      printf '{"fp_client":"%s","at_client":%s,"note_client":"%s","tool_client":"%s","fp_server":"%s","at_server":%s,"note_server":"%s"}\n' \
        "$fp" "$now" "${note:-✅ 硬闸全过}" "${tool//\"/}" "${other_fp:-}" "${other_at:-0}" "${other_note:-}" > "$STAMP"
    else
      printf '{"fp_client":"%s","at_client":%s,"note_client":"%s","fp_server":"%s","at_server":%s,"note_server":"%s","tool_server":"%s"}\n' \
        "${other_fp:-}" "${other_at:-0}" "${other_note:-}" "$fp" "$now" "${note:-✅ 全过}" "${tool//\"/}" > "$STAMP"
    fi
    echo "  （留戳：$which · $now）"
    ;;
  *) usage ;;
esac
