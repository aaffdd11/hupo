# 74 · 验收文档（对照 v2 开发文档与实际做出来的东西）

> **只读审计产出**（2026-09-24）。审计期间**没有修改、创建、删除任何文件**，除了本文件本身。
> 本文件是这次验收唯一的新文件；所有结论都回到 `文件:行` / 测试名 / 本机读数。

---

## 一、怎么读这一份

**这份文档回答一件事：文档说要什么，代码里到底有没有。**

材料按三路对：① 文档侧（`docs/INDEX.md` 的 L0 路由、`docs/handbook/**` 的要什么/为什么、`docs/dev/**` 的怎么实现/验收）；② 代码侧（`v2/services/core/**` 服务端 + `v2/apps/mobile/**` 客户端）；③ 脚本侧（`scripts/**` 发布与检查）。三路的对法沿用仓库自己那次「三路只读审计」的方法（`docs/dev/65-ALIGNMENT-2026-09-23.md:17-19`）：**每条结论都要能指到文件:行，指不到的算文档在说假话。**

⚠️ **先把三件事说清**：

1. 作为子 agent，**我没有拿到那三轮对话的原始材料**。凡本文出现的结论，都由我回到仓库文件、测试名、本机读数复核过；仓库里已记下的两轮独立评审（`docs/handbook/07-APPENDIX.md:125-150`，各三席）、三路只读审计（`docs/dev/65-ALIGNMENT-2026-09-23.md`）、三位工程师讨论（`docs/dev/66-NEXT-STEPS.md`）被当作 §六 五席判据的**书面来源**，不是转述。
2. **裁决顺序仍然是「手册 → 代码 → 其他」，但冲突时先按代码确认事实**，不一致如实写进 §三 或 §五。
3. **纪律**：只写有证据的结论；不写"以后再说"；要砍就明说砍了。

**状态只用这五个**：`✅已做完` · `🚧做一半` · `📄只在文档里` · `🧩代码有但文档没写` · `❌文档与代码不一致`。

**读的时候注意三点**：

- **本文件与 `docs/dev/74-TENANT-CHANNELS.md` 撞号**（两篇都是 74）。这是任务指定的文件名，如实记在这里。
- 本文件**不在** `scripts/check-docs.mjs:30-58` 的 RATCHET 名单里（进名单要改那个脚本；本次只读，不允许改别的文件）。所以它里面的链接/锚点**不会被文档闸判红**。
- 审计期间**树上有在飞的改动**（`git status` 开始是 13 个已跟踪文件被改 + 3 个未跟踪新文件；审计结束时已长成 **15 个 `M` + 4 个 `??`**，见 §五·1）。**服务最后一次起是 02:26:35**（`ps -o lstart -p 2011862`），而在飞的文件一直改到 **02:50**（`model-proxy.mjs`）⇒ **线上跑的不是工作树最新那一版** —— 按仓库纪律（`AGENTS.md` §5.0）此刻**不能当收尾结论**。

---

## 二、逐块验收表

| 块 | 文档在哪 | 代码与判据在哪 | 状态 | 证据 | 缺口 |
|---|---|---|---|---|---|
| **文档与代码一致性**（本表所有"文档在哪"的可信度） | `docs/handbook/03-DEVELOPMENT.md` §5/§6/§7 · `08-SPEC.md` §2.4/§2.5/§8.2 · `02-ARCHITECTURE.md` §五 · `README.md` · `AGENTS.md` | 代码事实 | ❌文档与代码不一致 | 见 §三（28 条） | 手册是 strict 文件，改它要主人重建清单（`00-PROGRESS.md:329-333`）⇒ 攒着没改 |
| **地基·可见时间线内核**（落盘上抛 / 唯一取号 / 收口 / 单调） | `01-FOUNDATION.md` · `03-DEVELOPMENT.md` §5.1 · `08-SPEC.md` N22 | `src/store.js` · `src/timeline.js:75,98`（`#nextSeq`） · `src/message-writer.js` · `test/store-append.test.js` · `test/seq-monotonic.test.js` · `test/message-writer.test.js` | ✅已做完 | `timeline.js:11` 写明"只有一个取号函数"；服务端 61 份测试文件、静态 `grep -rho '^ *test(' test/*.test.js \| wc -l` = **778**；记账读数 **769 全过**（`00-PROGRESS.md:24`） | 手册 §5 仍按**已删的** `conversation.js` 描述"现状"（§三·2） |
| **服务面**（HTTP + WS + 鉴权 + 续传 + 令牌续期） | `02-SERVER-SURFACE.md` · `08-SPEC.md` §2.1 · `25-TOKEN-RENEW.md` | `src/server.js:395-822` · `src/serve.js` · `src/auth.js` · `test/server.test.js` · `test/auth.test.js` · `test/renew.test.js` | ✅已做完 | 20 条需令牌路由 + 4 条公开路由，逐条对上 `server.js:395/398/402/408/449/511-781`；`GET /api/version` 公网读数 `{"buildId":"03227ae36a7e"}` | `/api/health` 回执与 §2.1 描述不符（§三·3） |
| **数据面多租户转发**（`TENANT_ROUTES`） | `74-TENANT-CHANNELS.md` · `37-MULTITENANT.md` · `08-SPEC.md` §2.1 注 | `src/server.js:474,822` · `test/tenant-routes.test.js` | 🚧做一半 | 名单恰 6 条：`/api/say` `/api/health` `/api/export` `/api/trash` `/api/app-ask` `/api/timeline`；#79 把漏掉的 `/api/timeline` 补上并真机复核（`00-PROGRESS.md:37`） | 不在名单的 `/api/apps` 等**由中心替租户答** = 影子世界账 **#71**（`00-PROGRESS.md:167`） |
| **跨重启记忆 / 开机对账 / 续做** | `06-RECAP.md` · `10-RECONCILE.md` | `src/recap.js` · `src/reconcile.js` · `src/resume-plan.js` · `src/resume.js` · `test/recap.test.js` · `test/reconcile.test.js` · `test/resume.test.js` | ✅已做完 | `recap.js:250 buildRecap` · `reconcile.js:266 reconcileOnBoot` · `resume-plan.js:71 planResume`；线上横幅记"重启还记得"（`AGENTS.md` §四） | 续做"全局 1 并发"未实现（§三·4） |
| **超时硬收口**（卡住的一轮怎么收场） | `07-TIMEOUT.md` · `08-SPEC.md` N19 | `src/dispatcher.js:40`（`TURN_DEADLINE_MS`） · `src/session-translate.js:188` · `test/deadline.test.js` | ✅已做完 | 线上"卡住会收场"（`AGENTS.md` §四）；判据含"升格过的轮次也要收口" | —— |
| **状态取号 / 过程四档** | `08-STATUS.md` · `26-PROCESS-LEVELS.md` | `src/turn-status.js` · `src/server.js:73-154` · `test/process-level.test.js` · `test/turn-status.test.js` | ✅已做完 | `PROCESS_LEVELS:73` `parseLevel:126` `levelAllows:154`；客户端 `stream_uri.dart:48` 把 `level` 带进连接 | —— |
| **人格层** | `09-PERSONA.md` | `hupo-persona.yml` · `src/agent-runtime.js` · `test/persona.test.js` · `scripts/check-persona.sh` | ✅已做完 | 线上"说话像它自己"（`AGENTS.md` §四）；`check-persona.sh` 验"人格真的进了模型上下文" | `check-persona.sh` 没进 `npm test`（脚本侧读数） |
| **工时账 + 能力契约** | `31-LEDGER.md` · `33-POLICY-ROLES.md` | `src/ledger.js` · `src/ledger-text.js` · `mcp-ledger-server.mjs` · `hupo-capabilities.yml` · `test/ledger*.test.js` · `test/capabilities.test.js` | ✅已做完 | `ledger.js:252 Ledger` / `ledger-text.js:60 renderLedger`；MCP 握手与含税有判据 | `docs/dev/31-LEDGER.md:155,254` 里 `check-capabilities.mjs` 的路径是错的（§三·13） |
| **预算 / 计量 / 监控分级** | `08-SPEC.md` §5 · §十·10.4/10.5 · `05-DECISIONS.md` D4.17 | 无 `budget.js` / `tracer.js`；`grep` = 0 | 📄只在文档里 | `08-SPEC.md:385,401` 自标"本轮不建"；`05-DECISIONS.md:296` 同 | 手册 §10.5 那一整组没标"未实现"（§三·5） |
| **删除 / 回收站 / 真删** | `28-DELETE.md` · `08-SPEC.md` N24 | `src/trash.js:114` · `test/trash.test.js` | ✅已做完 | 墓碑三条（`turn/deleted`/`restored`/`purged`）+ TTL；`/api/trash*` 五条路由 | —— |
| **系统通知** | `29-NOTICE.md` | `src/notice.js:174` · `test/notice.test.js` | ✅已做完 | 唯一通知出口；`notice/urgent`（盘满那条，瞬态）也在 | —— |
| **导出** | `30-EXPORT.md` | `src/export.js:186,228` · `test/export.test.js` | ✅已做完 | 量词那处说过头的话已改成"删过 N 次"（`00-PROGRESS.md:48`） | —— |
| **失败五类** | `62-FAILURE-CLASSES.md` · `05-DECISIONS.md` D10.3 | `src/oom.js` · `test/auth-failure.test.js` · `test/oom.test.js` | 🚧做一半 | 只两档有信号：上游不通、被 OOM；`62` 明说另外三档**今天没有能把它们分开的信号** | OOM 靠 cgroup `memory.events`，本机 `memory.max=max` ⇒ **在这台机器上永不响**（`00-PROGRESS.md:165`） |
| **出处（sources）** | `67-SOURCES.md` · `03-DEVELOPMENT.md` §五注 | `src/sources.js:44` · `test/sources.test.js` · `test/widget/sources_test.dart` | ✅已做完 | 只认 `web_search`/`web_fetch`，只带 `{title,url}`，前 3 + "还有 N 处" | —— |
| **朗读（TTS）** | `68-SPEAK.md` · `05-DECISIONS.md` D5.16 | `lib/services/speech*.dart` · `lib/models/speak_words.dart` · `test/unit/speak_test.dart` · `test/widget/speak_test.dart` | ✅已做完 | 零新依赖、默认关、三条边界（历史不念 / 没说完不念 / 念不了不画按钮） | **"真的有声音"这台机器验不了**（无头浏览器没有音频输出，§七） |
| **语音输入（ASR）** | `69-ASR-ROUTES.md` · `71-MIC-ASR.md` · `05-DECISIONS.md` D5.2/D5.10/D5.17 | `src/asr.js:65` · `src/asr-sign.js:43` · `lib/services/hearing*.dart` · `test/asr.test.js` · `test/unit/hearing_session_test.dart` | 🚧做一半 | 真链在（`/api/asr` 已进 nginx，`00-PROGRESS.md:324`）；SecretKey 只在服务端；`asr/partial\|final\|end` 带 `{text,index}`（`asr.js:137/221/222`） | **D5.2（用手机自带识别器）没改、云端 ASR 已被 D5.17 落地**；**D5.10 的"四类各 20 条、命中率 ≥90%"没做**；APK 是 2026-09-20 的、`aapt2` 实测**没有 RECORD_AUDIO**；`#52` 与 `#88` 在同一份热表里对撞（§三·9/10） |
| **小程序机制**（造 / 发布 / 图标 / 授权撤销 / 沙箱） | `57-MATH.md` · `58-CREATE-APP.md` · `59-USER-APPS.md` · `70-APP-ICONS.md` | `src/apps.js:169` · `src/app-icons.js:129,149` · `src/app-serve.js` · `mcp-apps-server.mjs:89` · `test/apps.test.js` · `test/app-icons.test.js` · `lib/widgets/mini_runtime_web.dart` | ✅已做完 | 图标库 54 个；`app_grant`/`app_revoke` 确实挂着（`mcp-apps-server.mjs:168,182`，`65-ALIGNMENT` 把 `59` 那句"故意没挂"改成了实话） | 租户盒子里"跑命令"这条路是断的（#70） |
| **小程序在租户盒子里的可用性** | `74-TENANT-CHANNELS.md` · `59-USER-APPS.md` §七 | `src/socket-owner.mjs:36,49,62` · `src/apps-socket.js:183-191` · `scripts/check-tenant-channels.sh` · `test/socket-owner.test.js` | 🚧做一半 | #91 已修（chown 给 agent uid、准入仍 0600）+ 真机验过；判据 9 条带负向对照 | **#70**（镜像缺 bubblewrap ⇒ 盒子里任何命令直接被拒）· **#71**（中心的影子世界）都没决（`00-PROGRESS.md:166-167`） |
| **多租户容器与隔离** | `34-CONTAINER.md`–`46-KEY-DELIVERY.md` · `08-SPEC.md` §13.1 | `scripts/build-tenant-image.sh` · `scripts/create-tenant-pool.sh` · `scripts/check-container.sh` · `src/tenants.js` | 🚧做一半 | 手册对下来是好的（`65-ALIGNMENT:136-147`）：根只读 + tmpfs、数据只在卷、独立 uid/gid + 卷 0700、cap-drop、pids-limit、memory 768m、钥匙 `EACCES` | **#65**（出网零限制）· **#66**（无每用户磁盘配额）· **#67**（闲置回收零调用者）· **#69**（无 CPU 上限，全仓 `--cpus` 0 命中） |
| **登录与账号**（手机号 + 验证码） | `37-MULTITENANT.md` · `40-LOGIN-CODE.md` · `41-SPECIAL-CODE.md` | `src/auth.js` · `src/users.js` · `test/phone-login.test.js` · `lib/screens/login_screen.dart` | 🚧做一半 | 码是掩码 + `868686` 特例；`/api/send-code` 没短信通道时 503 + 一句人话（`server.js:410`） | **`HUPO_DEV_CODE` 开着**（本机 `/proc/2011862/environ` 里确有这个变量名）⇒ 任意手机号 + 开发码就能建号占容器（账 #45，`00-PROGRESS.md:168`） |
| **桌面 + 浮窗 + 聊天重设计 + UI 整理** | `49`/`50`/`52-DESKTOP.md` · `64-CHAT-REDESIGN.md` · `72-UI-PASS.md` · `75-CHAT-ROW.md` | `lib/widgets/app_desktop.dart` · `chat_floater.dart:48,442,489` · `composer.dart` · `plan_strip.dart` · `test/widget/*` | ✅已做完 | #75/#89/#92 都记账"已部署"；公网 `index.html` sha256 前 16 位 `b7c2bbbe40149a83` 与本机**逐字节一致**，且线上入口含 `chat-handle`（#92 的抓手） | #89 同一行状态写"🚧进行中（2/4）"而后文四块全"已做完"（§三·12）；#93 自认**还欠界面专属判据与真机中途图**（`00-PROGRESS.md:22`） |
| **动效**（页面换场 / 图标⇄小程序 / 水面已删） | `53-MOTION.md` · `60-WATER-BG.md` · `73-MOTION-APP.md` | `lib/widgets/motion.dart` · `lib/models/design.dart:110,118` · `test/unit/motion_curve_test.dart` · `test/unit/motion_swap_test.dart` | ✅已做完 | 水面特效按主人要求**已删**（`grep -rln "water\|水波\|wave" lib/` = 0；`65-ALIGNMENT:102`）；全库唯一 `AnimationController` 在 `mini_app_host.dart:97` ⇒ Z5"永不结束的动画要有总开关"已无对象 | —— |
| **Web 部署 / 缓存 / 字体指纹** | `03-DEPLOY-WEB.md` · `15-CACHE.md` · `61-WEB-PERF.md` · `72-UI-PASS.md` §四·补3 | `scripts/deploy-web-v2.sh:85,95-159` · `scripts/check-web-refs.mjs` · `scripts/fingerprint-fonts.mjs` | ✅已做完 | 入口指纹 = 入口字节 sha256 前 12 位；留最近 3 份旧入口 + 点名排除当前版 + `cp -p`（白屏那次的修法）；发布前 4 处自检 | 手册 `08-SPEC.md:723-739` §8.2 讲的是**上一代**部署（§三·6）；入口改名**没有 Dart 级判据**，只有 `check-web-refs.mjs`（脚本侧读数） |
| **P1/P2 + 开机完整性** | `19-P1-P2.md` · `23-DEV-VS-DEPLOY.md` · `AGENTS.md` §八 | `src/integrity.js:33,268` · `scripts/verify-integrity.mjs` · `scripts/apply-change.sh` · `scripts/rollback.sh` | 🚧做一半 | 本机只读核对（`node scripts/verify-integrity.mjs`）：**0 处会拒绝启动、6 处只报**（正是工作树那 6 个在飞的服务端文件）；清单 `/etc/hupo/integrity.json` **123 条 / 17 strict**、`root:root 0444` | `src/**` 与 `scripts/**` 是 `report` 只报不拦（`integrity.js:71-76` 自认 P1.2 判据今天没满足）；服务与两条隧道不在 systemd（#48/#58） |
| **准入 / 容量 / 进程上限** | `20-ADMISSION.md` · `08-SPEC.md` §10.3 | `src/admission.js:27` · `src/agent-runtime.js:178` · `src/config.js:177` · `scripts/lib/tenant-capacity.sh` | 🚧做一半 | `ADMIT_RATIO = 0.75`；容量算式收成一处（`tenant-capacity.sh:32-48`） | **`agentMaxProcesses`（默认 4，横幅还印着）在生产里从没被执行**：`evictIfNeeded` 只有 `test/` 调用（`agent-runtime.js:178` 定义，`agent()` 里不调）；本机每层 `memory.max=max` ⇒ 准入判据**算不出来**（#68） |
| **可访问性** | `13-A11Y.md` · `05-DECISIONS.md` D3.5 · `08-SPEC.md` §6.5 | `test/widget/accessibility_test.dart`（39 个 `testWidgets`） · `scripts/check-client.sh:38` | ✅已做完 | 五档不溢出 + 命中区 ≥44 + 不封顶；`check-client.sh` 把它当**硬闸** | 手册 `03-DEVELOPMENT.md:440` 还说 `test/widget` 整体"只警告不阻断"（§三·14） |
| **楼层闸 / 反向漂移 / 禁用词** | `18-FLOORS.md` · `08-SPEC.md` §13.2 | `test/reverse-drift.test.js` · `test/unit/import_rules_test.dart` · `test/unit/forbidden_words_test.dart` | ✅已做完 | 反向漂移四条含"不许空跑"（扫到的文件数要够）；禁用词进 `test/unit` | —— |
| **文档闸 / L0 路由** | `docs/INDEX.md` §三 | `scripts/check-docs.mjs:30-58,226` | ✅已做完 | 链接可达 + 锚点可解析 + L0 不许有数值 + 重名标题；只对 RATCHET 名单判红 | **本文件不在 RATCHET**（进名单要改脚本，本次只读不允许） |
| **验收判据本身 V1–V13** | `08-SPEC.md` §13.1–13.3 | `scripts/check-container.sh` · `scripts/check-apk.sh` · `test/reverse-drift.test.js` · `scripts/check-web-browser.mjs` | ❌文档与代码不一致 | **V2 / V5 / V6 / V7 全文不存在**（§十三只有 V1/V1b/V3/V4 + V8–V13）；V10 拿本机 2026-09-20 的 APK 跑 `check-apk.sh` ⇒ **没有 RECORD_AUDIO**；V11 文案还写"现在必失败——没有访问序"而 `agent-runtime.js:64` 已有访问序；V12（env 白名单）`agent-runtime.js:39-41` 自认没做 | 见 §五·12 |
| **设置页与钥匙** | `46-KEY-DELIVERY.md` · `48-SETTINGS-KEY.md` · `05-DECISIONS.md` T10 | `src/put-key.mjs` · `src/key-drop.js` · `src/creds.mjs`（**未跟踪新文件**） · `lib/widgets/key_form.dart` · `lib/screens/settings_screen.dart` | 🚧做一半 | **单把钥匙那条路 2026-09-22 已上线**；「被判无效 ≠ 没填过」的 `keyBad` 已实现（`src/key-state.js:25`） | **多把钥匙是"改完没收尾"**：文件 02:38–02:45 还在改、服务 02:26 起的、公网 bundle 里**查不到**新文案；未提交、未部署、未记账、`48-SETTINGS-KEY.md` 通篇没提多把钥匙（§五·1） |

---

## 三、说假话的地方（文档说了、代码里没有）

> 判定标准沿用 `65-ALIGNMENT` §六那条纪律：**写"现状"的行，写的时候就对一次代码。**
> 下面每条都是"照它做会做错事"的那种。

1. ❌ **`08-SPEC.md` §2.4 服务端模块清单标着【有效】，却列了 4 个不存在的文件**：`conversation.js`（`:249`）· `debug-agent.js` / `personality.js`（`:253`）· `client-build.js`（`:254`）。实测 `ls v2/services/core/src/` 四个都不存在；全仓 `Conversation` 只出现在 `message-writer.js:5` 的注释里。真模块 50+ 个反而没进表。
2. ❌ **`03-DEVELOPMENT.md` §5 把已删的 `conversation.js` 当"现状"讲**：`:325,326,344-346,553` 写"取号住在 `conversation.js`，`emit:42` / `emitTransient:72` / `restore:150`"。v2 的实际是 `src/timeline.js:75,98` 的 `#nextSeq`；`conversation.js` 不存在。同一份文档 `:440-441` 还写死"`test/widget` 现 49 挂 10、`node --test` 现 72 条全过"—— 既过期又**自违它自己的"不写数值"纪律**（`:8-10`）。
3. ❌ **`08-SPEC.md` §2.1 说 `/api/health` 回"disk / store / agents / memory / upstream / cert"**（`:173`）。代码 `server.js:512-514` 只回 `{ok, timelineId, seq}`；`grep -n "upstream\|cert" server.js` = 0。
4. ❌ **`08-SPEC.md` §10.2 说续做并发"全局 1，现状每会话 2 件 ⇒ 10 会话起 20 个 agent"**（`:892`）。代码 `resume-plan.js:138-146` 每次挑 1 件、`serve.js:831` 对每个 world 各起 1 件 ⇒ 实际**每会话 1 件、跨会话没有全局闸**；"20 个"这个数在代码里没有来源。
5. ❌ **`08-SPEC.md` §10.3 写"空闲 30 min 回收"、§10.5 整组磁盘/告警阈值**（`:903-933`）。`config.js:240` 的 `agentIdleEvictMs` **消费方 0 个**（`grep -rn agentIdleEvictMs src/` 只命中它自己）；`evictIfNeeded`（`agent-runtime.js:178`）**生产 0 调用**（只有 `test/agent.test.js:273` 等三处测试调它）⇒ **`agentMaxProcesses`（`config.js:177`，默认 4，`serve.js:914` 还印在开机横幅上）从没被执行过**。§10.5 那一整组代码里 0 命中，却没标"未实现"。
6. ❌ **`08-SPEC.md` §8.2「Web 部署【有效】」整节讲的是上一代部署**：主域名 `hupo.stalkerai.cn`（`:727`）、静态根 `/var/www/hupo`（`:729`）、`scripts/deploy-web.sh`（`:735,754`）。v2 实际是 `w.stalkerai.cn`、产物 `v2/services/core/web`、`scripts/deploy-web-v2.sh`；`scripts/deploy-web.sh` 与 `:755` 的 `scripts/enable-https.sh` **都不存在**（死引用）。`AGENTS.md` §一 明确本机就是 `w.stalkerai.cn`。
7. ❌ **`08-SPEC.md:738-739` 说"部署脚本会先跑 `flutter analyze` 与 `flutter test`，这就是硬闸的执行者"**。代码 `deploy-web-v2.sh:41-51` **只跑 `flutter build web`**；真硬闸在 `scripts/check-client.sh:33-39`（要单独跑）。
8. ❌ **`AGENTS.md:340` 说开机清单是"50 个文件"**。实测 `/etc/hupo/integrity.json` = **123 条 / 17 strict**；而且 `AGENTS.md` §八 自己规定"AGENTS 里不许写数字"。
9. ❌ **`00-PROGRESS.md` 同一份热表里语音对撞**：`:27`（#88）"**语音本体：真开麦** ✅做完（已部署、已验）" vs `:157`（#52）"语音只有形状、没有真的接上"。`63-OWNER-DECISIONS.md:50` 和 `66-NEXT-STEPS.md:30` 也仍按"没做"问主人。**事实是做了**（`src/asr.js`、`/api/asr`、`71-MIC-ASR.md`），但这个冲突本身还没收口。
10. ❌ **语音路线与决策打架、决策没改**：`05-DECISIONS.md:189` D5.2 要"用手机自带的识别器"、`:456` 把"云端 ASR"明确列为否决；代码 `asr.js:45` 走 `HUPO_ASR_URL` / 腾讯云上游，`71-MIC-ASR.md` 记的就是云端。D5.17（`:203`）只重定义了形状与"音频经我们这条"，**没有改 D5.2**；账 #52 因此还开着，同时 #88 又说做完了。
11. ❌ **`04-ROADMAP.md` §九 批 5 说"砍了"**（`:193-195`，主人 09-21 原话"语音不做"），同节 `:187` 又说"v1.1 先复核再决定做不做"，而语音**已经做了**。批次表没有回填。
12. ❌ **`00-PROGRESS.md:26`（#89）状态写"🚧进行中（2/4 块已做）"**，同一格后文却写"✅ A 桌面已做完 · ✅ B 聊天浮窗已做完 · ✅ D 设置/关于已做完 · ✅ E 圆角阴影配色已做完"。四块都做完了，状态栏没改。
13. ❌ **`00-PROGRESS.md:36`（#78）写"新账 #65–#68"**，漏了同文件 `:165` 就有的 **#69**（CPU 上限）。
14. ❌ **`02-ARCHITECTURE.md` §五 标题"N12–N25"、正文说"这 14 条"**（`:265,268`），表实际写到 **N30**（`:287-291`，共 19 条）。`README.md:25`、`08-SPEC.md:19`、`CHANGELOG.md:1672` 都没同步。另：N12–N18 在服务端**无实现**（`scopeId` 只是恒为 `null` 的透传字段，`message-writer.js:42,88`；记忆写闸门没有对应工具）。
15. ❌ **`README.md` 索引过期**：`:127` 写"V1–V12"（实际到 V13，`08-SPEC.md:1278`）· `:131` 写"Z1–Z3"（实际 Z1–Z5，`08-SPEC.md:428-432`）。
16. ❌ **决策条数三处不一致**：`AGENTS.md:74`"76 条" vs `05-DECISIONS.md:3`"84 条"（实测 D 开头 81 条）。
17. ❌ **`63-OWNER-DECISIONS.md` 自相矛盾**：标题列 10 项、`:4` 写"9 条里 8 条"、`:116` 写"这五条"，且整篇漏了 **#71**、标题漏 **#69**。
18. ❌ **`docs/dev/31-LEDGER.md:155,254` 让人跑 `node scripts/check-capabilities.mjs`**。实际文件在 `v2/services/core/scripts/check-capabilities.mjs`（根目录没有）。
19. ❌ **`08-SPEC.md` §2.5 客户端模块清单里标 ✅ 的 `mini_app_container.dart`、`answer_bubble.dart` 不存在**（`:264-265`）；客户端实际是 `mini_app_host.dart`、`bubbles.dart`。
20. ❌ **`08-SPEC.md` §13.3 V11 写"现在必失败——没有访问序"**（`:1276`）。代码 `agent-runtime.js:64` 已有 `#access` 访问序，`test/agent.test.js:247` 有 LRU 淘汰判据 ⇒ 这句话过期。
21. ❌ **禁用词说了不许上屏，而它真的上了屏**：`forbidden_words.dart:25` 把 **`'服务器'`** 列为禁用词，但 `chat_controller.dart:664`（"和服务器对不上了，正在重新同步"）与 `:976`（"服务器没收下：$message"）经 `conn_state.dart:48-50 statusLine` → `chat_screen.dart:1048,1056 _StatusStrip` **画在屏幕上**；而 `forbidden_words_test.dart:38-199` 的界面文案清单**没有收这两句**（`:970` 的注释还写着"这道闸守着"——与事实相反）。按 `AGENTS.md` §六 第 4 条，这是**缺陷不是文风**。
22. ❌ **`'正在听'` 这句闸没盖到**：词表把它列为永久禁用（`forbidden_words.dart:46`，`forbidden_words_test.dart:21` 断言它必须禁），而界面在"真的在听"时就用它（`hearing_words.dart:20 hearListening` → `composer.dart:475`）；`forbidden_words_test.dart:38-199` 的界面文案清单**故意不收它**。D5.13 的立场是"只在真的在听时出现"，所以这**可能是有意豁免**；但"豁免了哪一句、凭什么"没有写进任何文档，下一个人无从判断是漏了还是故意。
23. ❌ **`08-SPEC.md:172`（与 `03-DEVELOPMENT.md` R10）说"客户端据 `/api/version` 判断要不要刷新"**。代码 `api.dart:459 version()` **在 `lib/` 与 `test/` 里 0 次调用**（`.version(` 0 命中）⇒ 这个协议面在客户端是死的。
24. ❌ **`64-CHAT-REDESIGN.md:135,157` 说"发送钮只在框里有字时出现；听筒只在语音档"并标"✅做完"**。代码 `composer.dart:266-269,418-419` 发送**常驻**（没字变灰）、`:259-262` 明写"没有语音档了"；这两条是被 `75-CHAT-ROW.md:41` 自己推翻的，但 `64` 没回填。
25. ❌ **语音形状那一批文档整段过期**：`64-CHAT-REDESIGN.md:121` 说"语音那一半仍然是假的（不开麦、明标演示）"、`71-MIC-ASR.md:16-30` 画的是"语音档一颗大按钮"、`:187,191` 说"听的时候不画发送"、`:198` 说"界面上不画话筒"、`68-SPEAK.md:27` 说开关画在语音档、`72-UI-PASS.md:17` 说"不画发送 + 大字实时文字"。代码事实是：真开麦（`hearing_web.dart:119-287`）、没有语音档、话筒照样画（`composer.dart:385-386`）、发送常驻仅禁用（`:269,430`）、字落进输入框（`:245-247,457,475`）。
26. ❌ **`73-MOTION-APP.md:76,81` 说交接带 45%→60%（`_swapFrom`/`_swapTo` + smoothstep）**。这两个符号**在代码里不存在**（`motion.dart:74` 只剩一句过时注释），实现早已改成**全程按透明度线性交叉**（`motion.dart:84,87`）；判据 `test/unit/motion_swap_test.dart:18` 写的就是"全程交叉"。⚠️ 同一份文档 `:99` 已经写了"改过、现在全程交叉" ⇒ 是**前文没回填**，不是整篇假话。
27. ❌ **`01-PROJECT.md` §八 两条判据与代码/后续决策不符**：第 11 条"收起态要**带字**的展开入口"（`:305`）已被 D3.8（`05-DECISIONS.md:151`）与 `08-SPEC.md:517` 改成"看得见即可"，代码 `chat_floater.dart:489 _FlatChevron` 无字；第 6 条"宽 >900 时限宽 **760**"（`:300`）在代码里不统一：760（`chat_screen.dart:689,725`、`export_screen.dart:111`、`trash_screen.dart:173`）vs **640**（`landing_screen.dart:64`、`settings_screen.dart:195`、`discover_screen.dart:63`、`math_quiz_screen.dart:65`）vs 420（`login_screen.dart:124`）。
28. ❌ **`71-MIC-ASR.md:131,133` 的测试条数过期**：写 `hearing_session_test.dart` 17 条（实为 18）、`hearing_test.dart` 8 条（实为 10）。另 `08-SPEC.md:481` 还写"点那条**带字的**「展开」"，与同文件 `:517`（2026-09-24 改形状）自相矛盾。

---

## 四、代码有、文档没写

> 先 `grep -rn "<符号>" docs/` 确认 0 命中才列；括号里是命中数。

1. **整块「多把钥匙」**（在飞，见 §五·1）：`src/creds.mjs` 模块本身（`docs/` 0 命中）——六字段 `CRED_FIELDS`(0) / `VOICE_FIELDS`(0) / `mergeCreds`(0) / `credValueOk`(0) / `credStatus`(0) / `parseCreds`(0) / `isCredField`(0) / `credNameOf`(0)，见 `creds.mjs:21,31,34,40,45,55,97,116,164`。它有 **5 个 src 模块 import**（`put-key.mjs:17`、`server.js:30`、`tenant-shell.mjs:20`、`tenant-channel.mjs:30`、`tenant-tunnel-agent.mjs:24`、`serve.js:39`）。
2. **`/api/model-key` 的 `field` 参数与 `/api/space` 回执里的 `creds` 状态**：`server.js:650-651`（认不出的 `field` 一律 400 / 非 model 且没 `setCred` 则 404）；客户端 `api.dart` 的 `setModelKey(..., {field})` 与 `CredsStatus`。`docs/handbook/08-SPEC.md` §2.1 两处都没写。
3. **`HUPO_KEY_FIELD` 环境变量**：`put-key.mjs:54`，`docs/` 与 `test/` 都 0 命中。
4. **`client/ping` 心跳事件**（25s）：`server.js:1386`，`docs/` 0 命中。
5. **`restart-core.sh` 的 `HUPO_SKIP_PREFLIGHT=1`**（`:100,:128`）——文档 0 处。
6. **`prune-sessions.mjs --all-groups`**（`:31,:45,:110-111`）——handbook 0 处。
7. **容量那两个口径与开关**：`lib/tenant-capacity.sh:28` 的 `HUPO_CAPACITY_RESERVE_PCT`、`:31-48` 的 `capacity_fits`/`capacity_limit`——handbook 0 处。
8. **`deploy-web-v2.sh --no-build`**（`:37,:50`）——handbook 0 处。
9. **`fingerprint-fonts.mjs`**（字体 URL 上内容哈希，修"字都在只有图标不在"）——只在 `docs/dev/15-CACHE.md` / `72-UI-PASS.md`，**handbook 0 处**。
10. **几个"判据脚本"在 handbook 里没有名字**：`scripts/check-tenant-channels.sh`、`scripts/check-tenant-limit.sh`、`scripts/check-asr-tencent.mjs`。
11. **WS 下行的 ASR 字段 `index`**：`asr.js:215-222` 明说"漏了它客户端会接出重复的话"，但 `08-SPEC.md:191` 只写 `{text}`。
12. **`tenant-reload.mjs` / `key-drop.js` 的模块名**：机制在 `45-TENANT-UPDATE.md` / `06-OPERATIONS.md:383` 有写，但文件名在 `docs/` 0 命中；`DocsSocket` 一族符号（`appsSocketPath`/`handleAppsOp`/`ledgerSocketPath`/`handleLedgerOp`）也 0 命中。
13. **客户端在跑、`08-SPEC.md` §2.1/§2.2 表里没有的三类事件**：控制帧 `client/ping`（`stream.dart:130`，服务端 `server.js:1386`）、`client/hello`（`:132`）、`client/reset`（`:142`）；过程帧 `step/start|end`、`reasoning/delta`（只在 `docs/dev/26-PROCESS-LEVELS.md:53-61`，不在手册事件表）。
14. **`hearing_web.dart` 的采集实现细节**：`dart:js_util`、`ScriptProcessorNode`、`_blockFrames=4096`、`_readyLimit/_lingerLimit` —— `grep docs/ "js_util"|"ScriptProcessorNode"` = 0。
15. **服务端几个只被自己人用的符号**：`planPayload`（`plan.js:83`）· `noticeKindOf`（`notice.js:428`）· `userIdFromPhone`（`users.js:186`）· `WORLD_SHAPE`（`worlds.js:53`）· `resolveDshBin`（`agent-runtime.js:31`，只在 `scripts/build-tenant-image.sh:299` 的注释里出现）—— 全仓（含 `scripts/`、`apps/`、`docs/`）0 引用。

---

## 五、做了一半的（明说断在哪）

1. **「多把钥匙 / 设置页四个 tab」——改完了、没收尾（in-flight）**。断点有四个，一个都不许含糊：
   - **未提交**：`creds.mjs`、`creds.test.js`、`settings_creds_test.dart` 是**未跟踪文件**，却已被 5 个已跟踪模块 import ⇒ 只提交 `git diff` 里那 6 个文件会得到一棵**引用不存在文件**的树。
   - **未部署**：文件 02:38–02:45 还在改，服务 02:26:35 起（`ps -o lstart`），公网 bundle（构建于 02:25）里 `grep "这一把先收在这儿"` 与 `"现在问不到有没有"` 都是 **0**。
   - **未记账**：`00-PROGRESS.md:253` 白纸黑字"**现在在飞的东西：没有**（2026-09-23 收尾时确认）"。
   - **未写文档**：代码 6 处注释把契约定为 `docs/dev/48-SETTINGS-KEY.md`，而那份 88 行的文档**通篇没有一个字**提六字段/多把钥匙（那里只讲单把 + `keyBad`）。
   - **还在长**：审计开始是 13 个 `M` + 3 个 `??`，审计结束时是 **15 个 `M` + 4 个 `??`**（后加的是 `model-proxy.mjs` / `model-proxy.test.js`）⇒ 这不是"停了等提交"，是**有人正在改**。
2. **语音本体**：代码在、判据在、线上能连，但**四项断着**——① `05-DECISIONS.md` D5.2（手机自带识别器）没改，云端路线没经主人拍板；② `D5.10` 的"四类各 20 条、句子级命中率 ≥90%"硬闸**没做**（只在 `69-ASR-ROUTES.md`/`55-VOICE-DEMO.md` 记着要求）；③ `D5.11`/`D5.3`（加 `RECORD_AUDIO`、"按住说话"）与实现不符：本机 APK 是 **2026-09-20** 的，`scripts/check-apk.sh` 实测**没有 `RECORD_AUDIO`**，手机壳原生录音**明说没做**；④ 账 #52 与 #88 没合上（§三·9）。
3. **小程序在租户盒子里的能力**：#91 把两条域套接字的属主修对了（真机验过），但 **#70**（盒子里缺 bubblewrap ⇒ 任何命令直接被拒，"改完自己没法验"）和 **#71**（中心还留着一份影子世界，`/api/app-ask` 的闸读的是中心那份）都没决。
4. **容器资源与隔离五条**（全部只提方案、等签字）：#65 出网零限制（全仓 `iptables`/出口白名单 0 命中）· #66 无每用户磁盘配额 · #67 闲置回收零调用者 · #69 无 CPU 上限（`grep -rn -- "--cpus" scripts/ v2/services/core/src/` = 0）· #68 监控只剩内存且本机算不出判据。
5. **登录那扇门**：`HUPO_DEV_CODE` 开着（本机服务进程 env 里确有该变量名）；短信通道没接 ⇒ #45 还开着，这是"能不能给第二个真人用"的唯一那道门。
6. **服务与两条隧道不在 systemd 下**：`pgrep -af frpc` 显示 `frpc-w.toml` 与 `frpc-apps.toml` 裸跑在 DSH 的 scope 里；`systemctl --user list-unit-files | grep frp` 只有 `frpc-dsh-u` / `frpc-finart-v` 两个单元。⇒ 机器一重启，**网站 502 / 小程序打不开**（#48/#58）。
7. **P1 的"只报不拦"**：`integrity.js:71-76` 自认 `src/**`、`scripts/**` 的 P1.2 判据今天没满足；`:113-115` 自认 `~/.dsh/storages/**` 与 `data/ledger.jsonl` **故意不在清单**（"往 KV/账本塞东西"那条路没被覆盖）。
8. **#89「整理整个 UI」的账没收**：四块都做完，状态栏仍写"2/4"（§三·12）；#93 明写"**还欠一次取证**：界面上的样子没有专属判据、也没有真机中途图"（`00-PROGRESS.md:22`）。
9. **文档侧那一大批**（§三 1–8、11、14–20）都是 strict 文件（`docs/handbook/**`、`AGENTS.md`）：改一次要主人补一条重建清单命令（`00-PROGRESS.md:329-333`）⇒ **攒着没改**。这是"知道、写着、没修"的状态，不是没发现。
10. **04-ROADMAP 批次表没回填**：批 5 说砍、语音又做了（§三·11）；批 1 的"人做=跑一次 `flutter build apk`"在当前语音/多把钥匙形态下也没重列。
11. **`serve.js:72` 显式传 `home: nodeOs.homedir()`**：当前服务以 `deploy` 起，读数一致；一旦服务身份变化，strict 的"漏条目"那半会**静默空转**而横幅照样写"对上了"（`integrity.js:188-189` 那种 `continue`）。
12. **V10/V12 没实现、V11 文案过期**：APK 里没有 `RECORD_AUDIO`（V10 要求语音上线后必须有）；env 白名单 `agent-runtime.js:39-41` 自认"先做减法、严格白名单随后"；V11 的"没有访问序"已被代码推翻（§三·20）。
13. **禁用词那道硬闸有两个洞没补**（§三·21/22）：`'服务器'` 真上屏、`'正在听'` 两闸互斥。闸本身在、判据也在，**是清单漏了屏上那两句、词表与产品口径没对齐** —— 断在"词表 / 测试清单 / 界面文案三处没有同一步更新"。
14. **写死尺寸还大量存在，而且棘轮只扫一类**：token 之外的 `EdgeInsets` 约 40 处（`landing_screen.dart:67,94,126,150,174,206,252,263,274,302,313`、`about_screen.dart:34,41,49`、`trash_screen.dart:186,207,212,222,232`、`export_screen.dart:124,146,152,159`、`login_screen.dart:121`、`chat_screen.dart:672,784,820,1055,1077`、`trash_plan_sheet.dart:35,39,44`）+ 遍布各屏的 `SizedBox(height: …)`；而 `test/unit/design_tokens_test.dart:28` 的棘轮**只扫 `BorderRadius.circular(<数字>)`**，`EdgeInsets` / `SizedBox` 无人守（`design.dart:93-95` 的 `gapS/M/L` 没被普遍使用）。按 `05-DECISIONS.md` D3"写死尺寸 = 缺陷"，这条是敞开的。
15. **客户端残骸与没有判据的本体**：`widgets/bubbles.dart:274 SystemNotice` 声明后 0 引用；`space_words.dart:324-325 voiceToMic/voiceToKeyboard` 0 引用；`composer.dart:194` 注释教恢复 `composerPaste`，而该符号已不存在；`chat_floater.dart:37,110` 注释仍写"收起态必须带字"（与 75 矛盾）。🔴 **`services/stream.dart`（WS 客户端本体：退避 / 401 / 游标）没有任何直接判据** —— 只有 `stream_uri_test` 盖地址算法。

---

## 六、五个角色给出的验收判据

> 五席按任务指定：**工程师 3 席 · 产品 2 席**。工程师三席的立场取自仓库里那场"三位工程师异步讨论"（`docs/dev/66-NEXT-STEPS.md:60-92`：安全运维 / 产品客户端 / 架构质量），产品两席取自 `01-PROJECT.md` 的用户走查与"主开发设备=平板"那条（`:51-60`、`:255-264`）。
> **每一席只列"能判"的条目**，并标：`✅` 判据在且当前成立 / `❌` 判据在但不成立 / `⛔` 判据在但本轮验不了。

### 工程师① 安全运维席（来源 `66-NEXT-STEPS.md:60-67`）

| # | 验收判据 | 判定 | 证据 |
|---|---|---|---|
| 1 | 盒内除持有者外谁都读不到凭据，且失败方式必须是 `EACCES` 不是 `ENOENT`（V4a） | ⛔ | 判据在 `08-SPEC.md:1213,1224-1226`、`check-container.sh`，但活体跑要 root/无根容器 |
| 2 | 容器出网只放通模型域名 + 请求审计 | ❌ | #65：租户单元**没有 `--network`**、全仓出口白名单 0 命中（`00-PROGRESS.md:161`） |
| 3 | 每人有磁盘配额，写满时明确拒 | ❌ | #66（`00-PROGRESS.md:162`；全仓 `xfs_quota` 0 命中） |
| 4 | 服务与隧道归 systemd 管，重启机器自己回来 | ❌ | #48/#58；实测 `frpc-w`/`frpc-apps` 无单元 |
| 5 | 口令不再以字面量进命令行/journal（增量已止、存量未清） | 🚧 | `00-PROGRESS.md:159`：死 scope 只剩 1 个、journal 81 行；真修要换口令或开白名单 |
| 6 | 改"开机自动读"的路径必须留痕、且 strict 对不上就拒绝启动 | ✅ | `integrity.js:33,268`；本机核对 0 处拒启；`AGENTS.md` §八 |

### 工程师② 架构与契约席（来源 `66-NEXT-STEPS.md:84-92`）

| # | 验收判据 | 判定 | 证据 |
|---|---|---|---|
| 1 | 落盘失败上抛，且唯一入口有人接（`store.append` + `emit`） | ✅ | `store.js` `timeline.js:98`；`test/store-append.test.js` |
| 2 | 一会话一份 `DSH_HOME`，甲看不到乙 | ✅ | N21；`agent-runtime.js:48,148`；`test/multitenant.test.js` |
| 3 | 进程上限 + 全局 LRU **在生产里真的执行** | ❌ | `evictIfNeeded`（`agent-runtime.js:178`）生产 0 调用；横幅印的 4 从没生效 |
| 4 | 协议字段只加不改；客户端自己算的地址必须闸在客户端（V13） | ✅ | `field` 是加法（老客户端忽略）；`stream_uri.dart:42-75` + `test/unit/stream_uri_test.dart`（含 https 不许降级的金丝雀） |
| 5 | 手册里"现状"断言都能指到文件:行 | ❌ | §三 那 28 条（`conversation.js` / §8.2 / §10.5 等） |
| 6 | 不变量 N12–N30 要么有实现、要么明确标"未做" | ❌ | N12–N18 无实现且表里没标状态（`02-ARCHITECTURE.md:273-279`） |

### 工程师③ 客户端与发布席（来源 `66-NEXT-STEPS.md:71-80`）

| # | 验收判据 | 判定 | 证据 |
|---|---|---|---|
| 1 | 三道闸：`flutter analyze` + `test/unit` + `accessibility_test.dart` 全绿 | ✅（判据在） | `scripts/check-client.sh:33-39`；本轮**没有重跑**（只读，见 §七） |
| 2 | 部署一定看得见：入口指纹 + 旧入口保留 + 引用图 0 个 404 | ✅ | `deploy-web-v2.sh:85,95-159`；公网与本机 index 逐字节一致（`b7c2bbbe40149a83`） |
| 3 | "页面自己建的那条 WS 通不通"要打在浏览器这一侧（V13） | ✅（判据在） | `scripts/check-web-browser.mjs:328-337,467-472,682-708`；本轮未跑（要令牌 + 会写截图） |
| 4 | 入口改名/引用改写有 Dart 级判据 | ❌ | 只有 `check-web-refs.mjs` + 脚本内自检；`web_shell_test.dart`/`cache_namespace_test.dart` 都不碰改名逻辑 |
| 5 | 发布不白屏（老访客拿旧 HTML 也能起来） | ✅ | `15-CACHE.md` + `deploy-web-v2.sh` 三条护栏；`#90` 那次打挂已修并记账 |

### 产品① 交付可信度席（主人本人 + 32 岁后端工程师，`01-PROJECT.md:51-53`）

> 这一席的原话："**我不会因为它难用、慢、界面丑而放弃。我会因为它说了做不到而放弃。**"

| # | 验收判据 | 判定 | 证据 |
|---|---|---|---|
| 1 | 界面上不出现内部词（工作区 / 口令 / 连接 / 客户端 / 云端 / 工具名 / `web_search`） | ❌ | 闸在（`test/unit/forbidden_words_test.dart` 硬闸），但 **`'服务器'` 真的上了屏**（`chat_controller.dart:664,976` → `conn_state.dart:48` → `chat_screen.dart:1048,1056`），`'正在听'` 又同时是禁用词与屏上字（§三·21/22） |
| 2 | 失败有自己的长相 + 一个重发入口 | ✅ | `notice.js:118-129` + `test/auth-failure.test.js`；`01-PROJECT.md` §八 第 2 条 |
| 3 | "关于页"按设备如实说（不会拼音的人 / 有没有话筒） | ✅ | `about_facts.dart` + `test/unit/about_facts_test.dart`；#89 把那句"我们自己没有话筒"改成按设备说 |
| 4 | 说了"钥匙用不了"就真的是用不了，且能回去换 | ✅ | `key-state.js:25`（三态）+ `48-SETTINGS-KEY.md` 判据 |
| 5 | 语音：不会拼音的人**第一天**能不能用 | ❌ | 只有网页云端路线；手机壳没做、APK 无 `RECORD_AUDIO`；`01-PROJECT.md:255-264` 明说"语音上线前，关于页必须明写用不了" |
| 6 | 200ms 内没有服务端回应 ⇒ 本地先出一句应声 | ✅ | `01-PROJECT.md` §八 第 4 条；`chat_controller` 应声 + `test/unit/say_outcome_test.dart` |

### 产品② 平板与日常使用者席（主人补的 D4：主开发设备=平板，`01-PROJECT.md:257-264`）

| # | 验收判据 | 判定 | 证据 |
|---|---|---|---|
| 1 | 五档字号 + 五档宽度不溢出、命中区 ≥44、不封顶 | ✅ | `test/widget/accessibility_test.dart`（39 个 `testWidgets`，硬闸） |
| 2 | 一展开就停在最新的话，用户上滑后不把他拽回去 | ✅ | #83（`00-PROGRESS.md:32`）+ `test/widget/scroll_follow_test.dart`（从默认收起档进） |
| 3 | 小程序打开/收回像样：有阴影、图标与内容按透明度交接、不闪到设置、半透明下不透出两个图标 | ✅ | #85/#86/#90/#93；`test/unit/mini_app_surface_test.dart`、`motion_swap_test.dart`、`test/widget/mini_app_test.dart` |
| 4 | 聊天窗口收成一行：抓手在上边框正中、话筒进框、发送常驻灰 | ✅ | #92；线上入口含 `chat-handle`（`chat_floater.dart:48,442,489`） |
| 5 | 语音按钮看得见、按下去真的能出字 | ⛔ | 代码/判据在；真开麦要主人设备（§七） |
| 6 | "打开 6 秒没第一个字就上划杀掉"（`01-PROJECT.md:54`） | ⛔ | 没有对应的时间闸判据；本机也没有主人平板可量 |

---

## 七、验不了的（如实说）

**这台机器验不了的**：

1. **容量/准入那条判据算不出来**：本机服务进程的 cgroup 是 `.../dsh-subprocess-68836-79f1e3f8933f.scope`，`memory.max` = **`max`**（`/proc/2011862/cgroup` + `/sys/fs/cgroup/.../memory.max`）⇒ `admission.js:27` 的 0.75 没有分母可算（#68）。
2. **两条硬闸本轮没重跑**（只读约束：跑 `npm test` / `flutter test` 会落盘临时文件）。表里"769 全过"（`00-PROGRESS.md:24`）与客户端 347/198（`00-PROGRESS.md:23`）是**记账读数**；本轮的静态计数是：服务端 61 份测试 / `grep -rho '^ *test(' test/*.test.js | wc -l` = 778；客户端 unit 35 份 354 条、widget 29 份 233 个 `testWidgets`。
3. **容器活体判据要 root**：`deploy` 不在 docker 组（`AGENTS.md` §1.1），`podman inspect hupo-a` 直接回 `no such object` ⇒ V1/V1b/V3/V4、`check-container.sh`、`check-tenant-channels.sh --live`、`check-tenant-data-plane.sh` 这些**本轮都没跑**。
4. **浏览器那条路没跑**：`scripts/check-web-browser.mjs` 要 `HUPO_TOKEN`（`Auth.issue()` 现发、不许写文件），且 `--shot` 会写 PNG（本次禁止）。本机 headless Chrome 在 `~/.cache/hupo-chrome`，判据是现成的。
5. **真的有没有声音（TTS）**：无头浏览器没有音频输出（`00-PROGRESS.md:34` 已如实写"耳朵听到要主人在自己设备上点一下"）。
6. **iOS**：手册 §8.1 明说"**在 Mac 上编译**"，本机没有那条链。
7. **完整性那半**：本机只读核对得到"0 处拒启 / 6 处只报 / 清单 123 条 17 strict"，但**"改一个 strict 文件 ⇒ 拒绝启动"**这条行为本身要重启服务才算数 —— 本次不许重启。

**要主人手机/真钥匙/额度开通的**：

8. **语音真开麦**（麦克风权限、按住时系统菜单、平板/手机上的实际识别质量）：要主人设备和真麦克风。
9. **腾讯云那三样凭据现在还有没有额度**：`data/asr.env` 里**确有** `TENCENT_APPID`/`TENCENT_SECRET_ID`/`TENCENT_SECRET_KEY`/`TENCENT_ASR_ENGINE` 四个变量名（只按名字核对，没有读值、没有写进本文），但"现在还能不能用、额度够不够"必须真调一次；`69-ASR-ROUTES.md` 记着"混元 `4004 资源包耗尽`、先线上用 `16k_zh`"。
10. **真实模型调用/计费**：要有额度的真钥匙（#44 那次 `401 → 200` 是主人给的）。
11. **短信通道**：没接、没凭据 ⇒ 关不掉 `HUPO_DEV_CODE`（#45）。
12. **部署期的那五条**（出网白名单 / 磁盘配额 / CPU 上限 / 闲置回收 / systemd 单元）按 P1/P2 **要主人签字**，助手只提方案（`63-OWNER-DECISIONS.md:92-116`）。
13. **VPS 上那次 nginx 改动**（`/api/asr` 的 WebSocket 升级头，2026-09-23 主人当场授权）：`00-PROGRESS.md:324` 有留痕，但**仓库里没有对应文件**，本机无法复核那台机器现在的状态。
14. **每台租户容器的真实运行状态**（属主、`bubblewrap`、`/data` 内容、影子世界）：要 root + `podman exec`；本轮只能在源码层确认修法在（`socket-owner.mjs`）。

**这一轮没查出来的**：没有。以上每一节都至少给到了一个 `文件:行`、一个测试名或一次本机读数。

---

## 八、本轮（2026-09-24）的**真实读数**（补：上面 §七 说"两道硬闸本轮没重跑"，这里补上）

| 闸 | 读数 |
|---|---|
| 服务端 `npm test` | **763 全过** |
| 客户端 `scripts/check-client.sh` | analyze 干净 · unit **352** · 可访问性硬闸 **181** · widget **199** |
| 文档闸 `scripts/check-docs.mjs` | ✅ 指针都对得上 |
| 人格闸 `scripts/check-persona.sh` | ✅ 通过 |
| 完整性 | ✅ 对上了（`/etc/hupo/integrity.json`） |
| 线上 | 入口指纹 **`03227ae36a7e`** · 真浏览器那条路 ✅ · 浏览器自检 ✅ |

⚠️ 仍然**验不了**的（与 §七 一致）：手机上真麦克风说话（要主人的手机）· 腾讯云**混元**那一档（要开通额度）· 原生 App 的录音（**明说没做**）· VPS 上 nginx 那一跳（改过、验过，但换机器要重做）。
