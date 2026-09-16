#!/usr/bin/env python3
# 生成 docs/diagrams-v7.html（v7 架构图 · 自包含，直接开浏览器看）
#
# 为什么用脚本生成而不是手写 SVG：七张图、几十个盒子，手写坐标一定会错位；
# 脚本里坐标是算出来的，改一处只动一个数。
import html

BG, PANEL, LINE = "#0f1419", "#161d26", "#232c36"
TXT, MUTED = "#e6edf3", "#8b949e"
BLUE, GREEN, AMBER, RED, PURPLE, CYAN = "#4A90D9", "#3fb950", "#d29922", "#f85149", "#a371f7", "#39c5cf"

parts = []          # 每个 section 的 html
navs = []


def esc(s):
    return html.escape(str(s), quote=False)


def svg_open(w, h):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
            f'font-family="\'PingFang SC\',\'Microsoft YaHei\',\'Noto Sans CJK SC\',system-ui,sans-serif">'
            f'<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
            f'orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="{MUTED}"/></marker>'
            f'<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
            f'orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="{RED}"/></marker></defs>'
            f'<rect width="{w}" height="{h}" fill="{BG}"/>')


def band(x, y, w, h, label, color=LINE):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{PANEL}" stroke="{color}" '
            f'stroke-width="1"/><text x="{x+14}" y="{y+22}" fill="{MUTED}" font-size="12" '
            f'font-weight="700">{esc(label)}</text>')


def box(x, y, w, h, title, lines=(), color=BLUE, tsize=13, lsize=11):
    out = (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="7" fill="#1b232e" stroke="{color}" '
           f'stroke-width="1.5"/>'
           f'<text x="{x+w/2}" y="{y+21}" fill="{color}" font-size="{tsize}" font-weight="700" '
           f'text-anchor="middle">{esc(title)}</text>')
    for i, ln in enumerate(lines):
        out += (f'<text x="{x+10}" y="{y+40+i*16}" fill="{TXT}" font-size="{lsize}">{esc(ln)}</text>')
    return out


def note(x, y, text, color=MUTED, size=11, anchor="start"):
    return (f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" text-anchor="{anchor}">'
            f'{esc(text)}</text>')


def arrow(x1, y1, x2, y2, label="", color=MUTED, dash=False, lx=None, ly=None):
    d = ' stroke-dasharray="4 3"' if dash else ''
    out = (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="1.8"{d} '
           f'marker-end="url(#a)"/>')
    if label:
        out += note(lx if lx is not None else (x1 + x2) / 2, ly if ly is not None else (y1 + y2) / 2 - 5,
                    label, color, 11, "middle")
    return out


def title(text, x=24, y=30):
    return note(x, y, text, TXT, 17)


def section(anchor, heading, svg):
    navs.append((anchor, heading))
    parts.append(f'<section id="{anchor}"><h2>{esc(heading)}</h2>'
                 f'<div class="fig">{svg}</svg></div></section>')


# ─────────────────────────────────────────────────────────────────────────────
# 图 1 · 三层 + 旁路（全景）
# ─────────────────────────────────────────────────────────────────────────────
W, H = 1260, 880
s = [svg_open(W, H), title("图 1 · 三层 + 一个旁路：谁负责什么，以及谁绝不能做什么")]

s.append(band(20, 46, 900, 178, "L1 终端层（Flutter：Web / iOS / Android）—— 只上报事实，不做判断", BLUE))
s.append(box(36, 78, 200, 128, "壳 · 一条时间线", [
    "按 seq 排，绝不配对", "quick+deep 同气泡", "status 与正文不互转",
    "来源独立通道（空则不显示）", "断线无限重连（封顶 8s）"], BLUE))
s.append(box(248, 78, 200, 128, "浮窗（三档）", [
    "收起 124px / 半开 50% / 最大", "四边留缝 10/10/10/12",
    "永远在有 z 序最上", "覆盖退让 .35 / .98 / 180ms", "触控 ≥44"], BLUE))
s.append(box(460, 78, 200, 128, "小程序运行时", [
    "沙箱 iframe / 受限 WebView", "独立 origin · 无令牌", "manifest + sha256 校验",
    "不联网 · 无权限生态", "不许反向给对话发话"], AMBER))
s.append(box(672, 78, 232, 128, "桌面 + 状态", [
    "图标墙（浮窗后面那层）", "点空白 = 收起聊天",
    "重启中：抽色变灰 + 不可触达", "恢复后「我已经升级好了」", "（来源：对话上下文）"], BLUE))

s.append(arrow(470, 224, 470, 252, "HTTPS + WSS ｜ Bearer 令牌（WS 走子协议）", BLUE))

s.append(band(20, 254, 900, 300, "L2 调度层（services/core · 永续 · 127.0.0.1:8091）—— 只管节奏，不能有表达欲", GREEN))
s.append(box(36, 286, 168, 116, "入口", ["/api/say（幂等）", "/api/stream（续传）", "/api/receipt", "公开路由只有 3 条"], GREEN))
s.append(box(214, 286, 168, 116, "账本", ["conversation/message", "/task 三段 ID", "created→completed", "配对不能破"], GREEN))
s.append(box(392, 286, 168, 116, "节奏", ["15s 挪走（先收口）", "180s 硬收口", "cancel 的诚实边界", "失败必有合法收尾"], GREEN))
s.append(box(570, 286, 168, 116, "闸门", ["内存 0.75 即拒", "预算 75/90/100", "计数 12/30/6", "拒绝给人话"], AMBER))
s.append(box(748, 286, 156, 116, "来源策略", ["P0~P3 分级", "两档能力", "taint 棘轮", "清 taint 只在 host"], AMBER))
s.append(box(36, 416, 168, 116, "制品服务", ["清单 / 上传", "版本不可变", "current 指针", "特权口不在公网"], AMBER))
s.append(box(214, 416, 168, 116, "鉴权", ["fail-closed", "XFF 最后一跳", "令牌撤销表", "归属校验 404"], GREEN))
s.append(box(392, 416, 168, 116, "对账续做", ["全局 1 件", "6h / ≤3 次", "OOM 失败豁免", "崩溃时降级启动"], GREEN))
s.append(box(570, 416, 168, 116, "观测", ["每轮 trace", "metrics 采样", "审计 append-only", "告警复用主动开口"], GREEN))
s.append(box(748, 416, 156, 116, "代理层", ["协议翻译", "dev 通道是附加", "绝不静默", "来源标记落事件"], GREEN))

s.append(arrow(470, 554, 470, 582, "stdio JSON-RPC：dsh --profile sdk --patch <role>", GREEN))

s.append(band(20, 584, 900, 190, "L3 工作层（可死可重启：一个会话 = 一个真 agent 进程）—— 话由它说，但它只有两档权力", CYAN))
s.append(box(36, 616, 200, 140, "主 agent", [
    "人格（patch 层）", "工具 + 上下文装配", "跨重启接记忆（时间流水）",
    "说话画像（贴合不迎合）", "前缀只追加、字节不变"], CYAN))
s.append(box(248, 616, 200, 140, "子 agent（后做）", [
    "类型登记表", "spawn_agent + 记账", "toolFilter / maxDepth 1",
    "输出契约校验", "禁孙 agent"], MUTED))
s.append(box(460, 616, 200, 140, "知识层 facts（后做）", [
    "带 source / trust", "无出处不写", "只给主 agent 装配简报",
    "不给「直接出话」出口", "派生、可重建"], MUTED))
s.append(box(672, 616, 232, 140, "工作区 ~/hupo-workspace", [
    "产物草稿 / 脚本", "配额 + 快照回退", "与仓库的边界", "（agent 的 cwd）"], CYAN))

s.append(band(936, 254, 302, 520, "旁路 · 监控层（独立 debug:<会话> 进程 · role=monitor 只读）", PURPLE))
s.append(box(952, 286, 270, 108, "时效计量（免费 · 每轮）", [
    "首句 / 整轮 / 空窗 / 结论", "阈值：6s / 30s / 8s", "结果直接进开发卡片"], PURPLE))
s.append(box(952, 406, 270, 108, "语义判断（花钱 · 按需）", [
    "只在机械规则报错时才叫", "同会话 60s 冷却", "合理性 / 个性适配"], PURPLE))
s.append(box(952, 526, 270, 108, "任务簿（按类别立项）", [
    "同一类毛病累加 seenCount", "title 只许闭集 + 引用原文", "⚠ 不许进「指令位」"], RED))
s.append(box(952, 646, 270, 112, "为什么它必须降权", [
    "它的输入 = 主 agent 的输出", "（里面带着刚抓来的网页正文）",
    "它曾是同权的第二个执行体", "→ 现在只读"], RED))
s.append(arrow(936, 470, 916, 470, "", PURPLE, True))
s.append(note(960, 800, "图例：蓝=L1  绿=L2  青=L3  黄=闸门/制品  紫=旁路  红=危险/纪律", MUTED, 11))
s.append(note(960, 820, "矩形 = 模块；箭头 = 只有这一条路能说话（其余都是旁路，见架构 v7 §3）", MUTED, 11))
section("01", "图 1 · 三层 + 旁路（全景）", "".join(s))

# ─────────────────────────────────────────────────────────────────────────────
# 图 2 · 一轮对话
# ─────────────────────────────────────────────────────────────────────────────
W, H = 1260, 620
s = [svg_open(W, H), title("图 2 · 一轮对话：两块回答拼成一个人的一句话，以及 taint 在哪一刻置位")]

s.append(note(30, 70, "主人", MUTED, 12))
s.append(box(30, 80, 150, 46, "「上海天气如何」", [], BLUE, 12))
s.append(note(210, 70, "L2 调度器", MUTED, 12))
s.append(box(210, 80, 200, 46, "幂等 → 内存闸 → user/echo", [], GREEN, 12))
s.append(note(440, 70, "L3 主 agent", MUTED, 12))
s.append(box(440, 80, 340, 46, "第一段文本 = 应声（排在所有工具调用之前）", [], CYAN, 12))
s.append(box(440, 146, 340, 46, "调 web_search / web_fetch", [], AMBER, 12))
s.append(box(440, 212, 340, 70, "工具跑完 → 最终文本 = 结论", [
    "第一句天然承接应声（像一个人一次说完）"], CYAN, 12))
s.append(box(440, 302, 340, 46, "两条一起落成一个气泡", [], CYAN, 12))

s.append(arrow(180, 103, 210, 103))
s.append(arrow(410, 103, 440, 103))
s.append(arrow(610, 126, 610, 146))
s.append(arrow(610, 192, 610, 212))
s.append(arrow(610, 282, 610, 302))

s.append(box(820, 80, 410, 46, "t=0 —— 主人说话", [], MUTED, 12))
s.append(box(820, 146, 410, 70, "⚠ t≈1.5s 置 taint（本会话）", [
    "吃到 P2/P3 ⇒ 当场降只读档：bash / 写文件 / 改系统 / 对外发送 全 deny",
    "只有主人下一条原话才清 —— 且清的动作只在 host 进程里做"], RED, 12))
s.append(box(820, 232, 410, 70, "来源走独立通道，不塞进正文", [
    "message/*.sources；没联网就传空数组，界面一个字都不显示",
    "（正文是「说给你的话」，来源是「你可以去核」）"], GREEN, 12))
s.append(box(820, 318, 410, 70, "15s 还没完 ⇒ 挪走", [
    "① 先收口当前气泡 ② 再另起一条说「我单独拿去做」",
    "③ task/created 存**原话** ④ 做完主动开口报结果"], AMBER, 12))
s.append(box(30, 380, 1200, 96, "不变量（这三条一破，用户就会觉得「换人了」或「时间倒流了」）", [
    "① 消息之间不许交叉 —— 一条消息开始后，不许再有别的消息正文写进更早那条（v6 附九）",
    "② 同一 messageId 的 quick 与 deep 渲染成同一个气泡 —— 用户应感觉是一个人在一次回答里说了两段",
    "③ 每个「进行中」都必须有配对收口 + 超时 —— 否则界面会替服务端说一句假话（已两次真实事故）"], RED, 13))

s.append(note(30, 510, "时间轴", MUTED, 12))
for i, (x, t, c) in enumerate([(30, "t=0", BLUE), (190, "t≈10ms", GREEN), (390, "t≈1.1s", CYAN),
                               (560, "t≈1.5s", RED), (720, "t≈6–14s", CYAN), (900, "t=end", MUTED)]):
    s.append(note(x, 540, t, c, 12))
    s.append(f'<line x1="{x}" y1="552" x2="{x+140}" y2="552" stroke="{c}" stroke-width="2"/>')
s.append(note(30, 578, "主人说 → 进调度 → 应声 → 置 taint（要查） → 结论 → 收口 + 计量 → 规则触发才叫监控 agent", MUTED, 12))
section("02", "图 2 · 一轮对话（含 taint 置位）", "".join(s))

# ─────────────────────────────────────────────────────────────────────────────
# 图 3 · 交付闭环
# ─────────────────────────────────────────────────────────────────────────────
W, H = 1260, 560
s = [svg_open(W, H), title("图 3 · 一次交付闭环：从「帮我做个能筛选的表」到「屏幕上点开」")]
steps = [
    ("① 主人开口", ["「把上周那几篇论文", "整理成一个能筛选的表」"], BLUE),
    ("② L3 写 H5", ["在工作区里写", "manifest + 静态文件", "（含 sha256）"], CYAN),
    ("③ 特权口上传", ["不在公网 nginx 路径上", "只允许追加新版本目录", "写一条不可变审计"], AMBER),
    ("④ 制品库", ["/var/lib/hupo-apps/<id>/<ver>", "current 指针（ln -sfn 原子）", "保留最近 3 版"], GREEN),
    ("⑤ 清单", ["GET /api/apps", "id/name/version/", "sha256/permissions"], GREEN),
    ("⑥ 壳下载并校验", ["校验 sha256", "失败 ⇒ 回退", "last-known-good"], BLUE),
    ("⑦ 沙箱里打开", ["独立 origin · 无令牌", "connect-src 'none' 不联网", "不能反向给对话发话"], AMBER),
    ("⑧ 主动回报", ["agent 主动开口", "必要时打断当前话题"], CYAN),
]
x = 24
for i, (t, lines, c) in enumerate(steps):
    s.append(box(x, 80, 148, 104, t, lines, c, 12, 10))
    if i < len(steps) - 1:
        s.append(arrow(x + 148, 132, x + 156, 132, "", c))
    x += 156

s.append(box(24, 210, 1212, 120, "三个前提：缺一不做（它们不是「以后再补的地基」，是最小形态的一部分）", [
    "① 独立 origin —— 否则小程序和 API 同源，一行 localStorage 就能读走令牌 ⇒ 指挥那个有免密 sudo 的 agent",
    "② 制品搬出站点根 + deploy-web.sh 加 --exclude=/apps/ —— 否则每次部署都被 rsync -a --delete 抹掉，而且没有报错",
    "③ 发布走特权管线 —— ⚠ nginx 让所有外部请求的源地址都变成 127.0.0.1，用「是不是本机 IP」判写权当场失效"], AMBER, 13))

s.append(box(24, 348, 596, 176, "本轮明确不做（收窄，不是砍掉）", [
    "小程序联网（第一版白名单 = 空）", "权限生态：剪贴板 / 通知 / 相机 / 文件 全不给",
    "商店 / 完整清单 / 年龄门", "小程序反向给对话发话（它是一条提权回路）",
    "iOS 商店版不发运行时（只发 T1/T2）", "→ 分工：做小工具在网页/桌面，手机仍是完整助手"], MUTED, 13))

s.append(box(640, 348, 596, 176, "验收判据（可测）", [
    "从说完到屏幕上能点开 ≤ 1 轮对话 + 1 次刷新", "下次部署整包后，已装的小程序**逐字节不变**",
    "小程序里的代码读不到 localStorage 里的令牌", "小程序连不上网（connect-src 'none'）",
    "对浮窗中心 hit test，命中的是聊天而不是小程序", "grep 原生桥 = 0（Apple 4.7.2）"], GREEN, 13))
section("03", "图 3 · 小程序交付闭环", "".join(s))

# ─────────────────────────────────────────────────────────────────────────────
# 图 4 · 信任与权限
# ─────────────────────────────────────────────────────────────────────────────
W, H = 1260, 620
s = [svg_open(W, H), title("图 4 · 信任边界：进入 agent 的一切都带来源，能力按来源分级")]

s.append(band(20, 50, 330, 380, "来源分级（谁说的）", BLUE))
srcs = [("P0 主人原话", "经鉴权通道 + 设备/构建指纹", GREEN),
        ("P1 产品自产物", "固定话术 / 画像块（不带工具调用）", CYAN),
        ("P2 派生不可信", "网页 / 子 agent / 监控层 / 未复核 KV", AMBER),
        ("P3 他源", "小程序输入 / 制品内容 / 别的会话", RED)]
for i, (t, d, c) in enumerate(srcs):
    s.append(box(36, 88 + i * 86, 298, 72, t, [d], c, 12, 11))

s.append(arrow(350, 240, 410, 240, "决定档位", MUTED))

s.append(band(410, 50, 380, 380, "能力档（能干什么）—— 只有两档", GREEN))
s.append(box(426, 88, 348, 150, "受信档（P0 / P1）", [
    "只读 · 写工作区 · 改系统 · 对外发送", "改系统 / 对外发送 每次都落审计",
    "「主人说改」这条路上零摩擦"], GREEN, 13))
s.append(box(426, 252, 348, 162, "只读档（吃到 P2/P3 即降）", [
    "bash / 写文件 / 改系统 / 对外发送 全 deny",
    "只读工具与「写工作区」不受限", "（否则 agent 变废人，主人也用不了它）",
    "问的方式：对话里一句带新信息的话", "「查到了 3.2.1，要我直接升上去吗」"], RED, 13))

s.append(band(810, 50, 430, 380, "污点棘轮（关键在「动态」）", AMBER))
s.append(box(826, 88, 398, 100, "① 吃到不可信内容 ⇒ 当场降档", [
    "不是「看一眼风险表」，是「这一轮就没了改系统的权」"], AMBER, 12))
s.append(arrow(1025, 188, 1025, 208, "", AMBER))
s.append(box(826, 208, 398, 100, "② 只有主人下一条原话才清", [
    "清 taint 的动作**只在 host 进程**里做 —— 模型碰不到",
    "所以它没法自己给自己解封"], AMBER, 12))
s.append(arrow(1025, 308, 1025, 328, "", AMBER))
s.append(box(826, 328, 398, 86, "③ 代价（量化后才敢上）", [
    "只读与写工作区零影响；预估 1–2 次/天",
    "7 天日志校准：拦 >3 次/天 或误拦 >0 ⇒ 修人格"], MUTED, 12))

s.append(box(20, 452, 1220, 148, "⚠ 这一版没有解决的问题：agent 自己的手有多大", [
    "上面这套解决的是「网页借 agent 的手」—— 但 agent 本身仍挂着 danger-full-access + **免密 sudo**（实测 sudo -n true 通过）。",
    "所以一次成功的注入、或一次被诱导的主人原话轮次，**仍然能改系统** —— 现在只是多了一道 taint 闸，而不是把刀收起来。",
    "彻底的做法是把 agent 从 deploy + 免密 sudo 里摘出来，改系统一律走特权管线（提申请 → 被校验 → 生效 → 可回退）。",
    "这一条**不在本轮 S0 范围内**，留到下一轮拍板（v7 §15 第 1 项）。"], RED, 13))
section("04", "图 4 · 信任边界与两档权力", "".join(s))

# ─────────────────────────────────────────────────────────────────────────────
# 图 5 · 部署与资源
# ─────────────────────────────────────────────────────────────────────────────
W, H = 1260, 660
s = [svg_open(W, H), title("图 5 · 部署与资源：今天刚改掉的那条 OOM 连环，就在 cgroup 这一层")]

s.append(band(20, 50, 1220, 120, "nginx（唯一对公网开着的进程）", MUTED))
s.append(box(36, 84, 380, 72, "hupo.stalkerai.cn", [
    "壳（/var/www/hupo/current）+ /api/ 反代 127.0.0.1:8091",
    "安全头 + limit_req/limit_conn ｜ XFF 只传真对端"], GREEN, 12, 11))
s.append(box(432, 84, 380, 72, "apps.<域>（制品，独立 origin）", [
    "只做静态，**绝不代理 /api/**", "CSP connect-src 'none'"], AMBER, 12, 11))
s.append(box(828, 84, 396, 72, "hupo.chat（明文，共用同一棵根）", [
    "⚠ 本轮未动：建议 301 到主域", "它与主站同根 + 是明文 ⇒ 中间人可改制品"], RED, 12, 11))

s.append(band(20, 190, 1220, 300, "systemd：一个主单元 + 两个 slice（今天标 ✅ 的是新改的）", MUTED))
s.append(box(36, 224, 380, 250, "concierge-core.service（调度器）", [
    "✅ OOMPolicy=continue", "✅ MemoryHigh=640M", "✅ MemoryMin=256M",
    "✅ MemorySwapMax=0", "✅ OOMScoreAdjust=-500", "✅ StartLimit 300s / 6 次",
    "✅ RestartSec=5（原 3s）", "MemoryMax=1G ｜ CPUQuota=150%",
    "实测：193MB / 1G，NRestarts=0"], GREEN, 13, 11))
s.append(box(432, 224, 380, 250, "concierge-agents.slice（后做）", [
    "每个 agent 子进程走", "systemd-run --scope", "",
    "MemoryMax=700M", "单 agent 软限 512M", "",
    "为什么需要：", "MemoryMax 管不到", "Node 拉起的子进程"], MUTED, 13, 11))
s.append(box(828, 224, 396, 250, "build.slice（今天新建）", [
    "✅ MemoryMax=2G", "✅ CPUQuota=300%", "✅ CPUWeight=20 ｜ IOWeight=20", "",
    "把 Flutter 工具链从调度器的", "cgroup 里挪出来：", "",
    "1 会话 + 1 构建", "= 68+172+846 = 1086MB", "> 1024MB ⇒ 必然 OOM", "",
    "实测：flutter 现在跑在", "/build.slice/…scope"], AMBER, 13, 11))

s.append(box(20, 506, 600, 130, "改前：一整条连环（近 7 天实测 4 次）", [
    "「改个界面」→ agent 在自己 cgroup 里跑构建 → 撞满 1G",
    "→ 内核杀 dart 编译器 → OOMPolicy=stop ⇒ **整个单元停机**",
    "→ 3 秒后重启 → 对账把「改界面」原话重派 → 又 OOM",
    "→ 三次额度烧完 → 主人收到「可能没做完」（假话）"], RED, 13, 11))
s.append(box(640, 506, 600, 130, "改后：一个子进程死亡 + 一次如实收口", [
    "构建跑在 build.slice（2G，且 CPU 低权重）⇒ 不再和对话抢资源",
    "OOMPolicy=continue ⇒ 死一个子进程，调度器活着收口",
    "OOM / 上游失败**不计入**续做额度 ⇒ 不烧主人的活",
    "崩溃环时（5 分钟 ≥3 次）降级启动：只服务对话，不续做"], GREEN, 13, 11))
section("05", "图 5 · 部署与资源", "".join(s))

# ─────────────────────────────────────────────────────────────────────────────
# 图 6 · 状态机
# ─────────────────────────────────────────────────────────────────────────────
W, H = 1260, 560
s = [svg_open(W, H), title("图 6 · 五条状态机：每一条都必须能回答「出事时怎么办」")]

rows = [
    ("一条消息", "start → text* → end", ["completed ｜ aborted ｜ failed"],
     "撞上 max-tokens / 被中断 ⇒ 必须补一句 + 标 failed，**不许把半句当完整回答**", RED),
    ("一件任务", "created → (resumed*) → completed", ["completed ｜ interrupted ｜ deferred"],
     "created/completed 必须配对 —— 配不上，界面就会一直说「还有件事在处理」", RED),
    ("小程序", "requested → downloading → installed → running ⇄ closed", ["failed"],
     "每个状态**必有超时与收口**；hash 不符 ⇒ 回退 last-known-good + 报 app/load-failed", AMBER),
    ("预算", "normal → warn(75%) → degraded(90%) → stopped(100%)", [],
     "不许静默；**必须在开口之前停**（不能留半句）；第一版只能按计数，不能按花销", AMBER),
    ("熔断 / 准入 / 降级", "closed → open(60s) → half-open ｜ accept ｜ reject ｜ normal ｜ degraded", [],
     "上游不通要说「上游不通」（不是「没做完」）；满了要给人话 + 可重试 + 不建空文件", GREEN),
]
y = 66
for t, flow, extra, danger, c in rows:
    s.append(box(24, y, 340, 74, t, [flow] + extra, c, 13, 11))
    s.append(box(376, y, 860, 74, "出事时", [danger], RED, 12, 11))
    y += 88

s.append(box(24, 500, 1212, 44, "共同不变量：每个「进行中」都必须有配对收口 + 超时，而且写进状态的那个人负责写收口（N7）", [], GREEN, 13))
section("06", "图 6 · 状态机与「出事时」", "".join(s))

# ─────────────────────────────────────────────────────────────────────────────
# 图 7 · 权限地图（谁碰得到什么）
# ─────────────────────────────────────────────────────────────────────────────
W, H = 1260, 520
s = [svg_open(W, H), title("图 7 · 权限地图：同一个 deploy 身份，谁握着什么")]
s.append(box(24, 70, 290, 180, "agent 子进程（主）", [
    "cwd：~/hupo-workspace", "env：process.env（⚠ 含 API key）",
    "文件：整个 /home/deploy 可写", "sudo：免密 ⚠",
    "网络：任意出站 ⚠"], RED, 13, 11))
s.append(box(324, 70, 290, 180, "监控 agent（旁路）", [
    "role=monitor（只读档）", "输入 = 主 agent 的输出",
    "产出不许进「指令位」", "今天：与主 agent 同权 ⚠",
    "（S6 才降权）"], AMBER, 13, 11))
s.append(box(624, 70, 290, 180, "调度器（永续）", [
    "监听 127.0.0.1:8091", "data/ 700（今天收紧）",
    "auth.json 600 · 可自签令牌", "spawn 时透传 process.env ⚠",
    "不直接执行主人的命令"], GREEN, 13, 11))
s.append(box(924, 70, 312, 180, "nginx（唯一公网入口）", [
    "只反代 /api/ → 8091", "安全头 + 限速 + 限连接",
    "XFF 只传真对端（今天改）", "制品站只静态、不碰 /api/",
    "/var/www/hupo 属 deploy ⚠"], GREEN, 13, 11))
s.append(box(24, 270, 1212, 108, "今天收紧的与仍然敞开的", [
    "✅ 今天收紧：data/ 递归 700/600（0 个其他人可读）｜ 鉴权 fail-closed ｜ XFF 取最后一跳 ｜ 安全响应头 ｜ rsync --exclude",
    "⚠ 仍然敞开（下一轮）：agent 的免密 sudo ｜ API key 透传进子进程 env ｜ ~/.ssh 可读 ｜ /var/www/hupo 属 deploy（客户端可被 agent 直接改写）",
    "⚠ 仍然敞开（S1/S3）：策略文件完整性校验 ｜ 密钥白名单 env ｜ 审计根属主 append-only ｜ 备份"], AMBER, 12))

s.append(box(24, 396, 1212, 100, "一条真实可用的事故链（写给未来的自己）", [
    "你问「这个链接说的对不对」→ agent 抓网页（无来源标记）→ 页面里藏着指令 →",
    "agent 有 danger-full-access + 免密 sudo + 无审批 ⇒ 读密钥外发 / 写进记忆当永久后门 / 改自己的人格 / 写个制品等你点开",
    "—— 四条分支任意一条得手，前面所有对话历史与整台机器一起丢。而你在屏幕上看到的只是「它在帮我查东西」"], RED, 12))
section("07", "图 7 · 权限地图", "".join(s))

# ─────────────────────────────────────────────────────────────────────────────
nav = "".join(f'<a href="#{a}">{esc(h)}</a>' for a, h in navs)
doc = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>个人 AI 助理 · 架构图 v7</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin:0; background:{BG}; color:{TXT};
         font-family:'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',system-ui,sans-serif; }}
  header {{ position:sticky; top:0; z-index:9; background:#0f1419ee; backdrop-filter:blur(6px);
           border-bottom:1px solid {LINE}; padding:14px 24px; }}
  h1 {{ margin:0 0 8px; font-size:16px; }}
  nav a {{ display:inline-block; margin-right:8px; padding:4px 10px; border-radius:6px;
          background:#1b2530; color:{MUTED}; text-decoration:none; font-size:12px; }}
  nav a:hover {{ background:#243040; color:{TXT}; }}
  main {{ padding:20px 24px 60px; }}
  section {{ margin-bottom:34px; }}
  h2 {{ font-size:13px; color:{MUTED}; font-weight:600; margin:0 0 10px; }}
  .fig {{ background:{PANEL}; border:1px solid {LINE}; border-radius:10px; overflow:auto; padding:6px; }}
  .fig svg {{ display:block; max-width:100%; height:auto; }}
  footer {{ color:{MUTED}; font-size:12px; border-top:1px solid {LINE}; padding:14px 24px; }}
</style></head>
<body>
<header>
  <h1>个人 AI 助理 · 架构图 v7（对齐 11 条拍板 + 今天的 S0 止损）</h1>
  <nav>{nav}</nav>
</header>
<main>
{"".join(parts)}
</main>
<footer>
  来源：<code>ARCHITECTURE-v7.md</code>（大架构）· <code>docs/design/</code>（子架构）·
  <code>docs/pm-panel/DECISIONS.md</code>（11 条拍板）· <code>services/core/deploy/README.md</code>（S0 变更单）<br/>
  旧的 <code>diagrams.html</code> 是 v3 时代的图（4 角色 + 控制器），已被这一套取代。
</footer>
</body></html>
"""
open('/home/deploy/projects/assistant/docs/diagrams-v7.html', 'w', encoding='utf-8').write(doc)
print("已写出 docs/diagrams-v7.html")
print("字节数：", len(doc.encode('utf-8')))
