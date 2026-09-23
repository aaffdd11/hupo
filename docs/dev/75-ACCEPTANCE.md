# 75 · 验收文档（五席三轮合并定稿）

> 汇总执笔（2026-09-24）。材料＝三轮 5 席（第一轮取证 → 第二轮挑错 → 第三轮定稿）＋ `74-ACCEPTANCE.md`（参考）＋ `proposals/2026-09-24-子agent越界产物/`（只读）。本文件是本次任务唯一写入的文件；其余只读复核，`git status --porcelain` 空、HEAD=`7beec16`；未跑任何落盘闸。**裁决顺序：手册 → 代码 → 其他；冲突先按代码定事实。**

---

## 一、怎么读这一份（含：这一份与 74 的关系）

- **74 是参考、不是底稿**：74 自己声明"没拿到三轮材料"（`74-ACCEPTANCE.md:16`），成稿后又被 `865debf`/`7beec16` 推翻了一部分（`docs/dev/76-CREDS-TABS.md` §八）。本份以三轮材料 + 本机复核为准。
- **74 里已过期的读数（本机实测）**：`:249` 写线上 `03227ae36a7e` → 实测 `/api/version`=`751baacff098`，保留入口只有 `751baacff098`/`a4ca0ef17c2d`/`eb451b34af3a`；`:245` 写 unit 352/widget 199/硬闸 181 → 实测 unit **350**/widget **224**/可访问性 **39**。
- **状态只用五档**：✅已做完 · 🚧做一半 · 📄只在文档里 · 🧩代码有但文档没写 · ❌文档与代码不一致。
- 74 与本文件都**不在** `scripts/check-docs.mjs` 的 RATCHET 名单；本机跑 `node scripts/check-docs.mjs` 退出 0。
- 撞号如实记：本文件是任务指定名（与 `74-TENANT-CHANNELS.md`、`75-CHAT-ROW.md` 分别撞 74/75）；`76-CREDS-TABS.md` 是配置页那一篇。

## 二、逐块验收表

| 块 | 文档在哪 | 代码与判据在哪 | 状态 | 证据 | 缺口 |
|---|---|---|---|---|---|
| 文档与代码一致性 | `08-SPEC.md` §2.4/§2.5/§8.2 · `03-DEVELOPMENT.md` · `AGENTS.md` | 代码事实 | ❌ | §三 20 条 | 手册/strict 要主人补重建命令 |
| 地基·时间线内核 | `01-FOUNDATION.md` · N22 | `timeline.js:75,98` · `test/store-append.test.js` | ✅ | 唯一取号函数；服务端 61 份测试/777 条 `test(` | — |
| 服务面 HTTP+WS+鉴权 | `02-SERVER-SURFACE.md` · §2.1 | `server.js:395-822` · `auth.js:35,470` | ✅ | 公开 4 条 + 需令牌 20 条；无令牌 401（`server.test.js:145`） | `/api/health` 形状与 §2.1 不符 |
| 公开面常量 | `08-SPEC.md:172-173` | `server.js:395/398/402/408` · `auth.js:35` | ❌ | 真实公开 4 条（含 `/api/send-code`）；`PUBLIC_ROUTES` 只 3 条、`server.js:20` 导入后 0 使用；`auth.test.js:23` 只钉常量 | 无"真实公开面"判据 |
| 会话与流·续传 | `16-STREAM.md` · §2.1/2.2 | `server.js:1327-1396` · `worlds.js:188` | ✅ | `sinceSeq` 补发、游标超前 `client/reset`、心跳 25s | — |
| 数据面租户转发 | `74-TENANT-CHANNELS.md` · §2.1 注 | `server.js:474-505,822` · `tenant-routes.test.js` | 🚧 | 名单恰 6 条 | #71 影子世界 |
| 跨重启记忆/对账/续做 | `06-RECAP.md`/`10-RECONCILE.md` | `recap.js`/`reconcile.js`/`resume.js` | ✅ | 线上"重启还记得" | 续做无全局并发闸 |
| 超时收口 | `07-TIMEOUT.md` · N19 | `dispatcher.js:40` · `deadline.test.js` | ✅ | 升格轮也收口 | — |
| 出处/计划 | `67-SOURCES.md` · §2.2 | `sources.js:28,69` · `plan.js:29` | ✅ | 只认两工具、上限 8；计划封顶 20 | `plan.js:83 planPayload` 全仓 0 调用 |
| 回收站 | `28-DELETE.md` · §2.1 | `trash.js:15` · `server.js:756-784,888-895` | ✅ | plan 只读无门槛、remove/purge 要 `confirm` | — |
| 模型钥匙（服务端四把） | `46`/`48`/`76-CREDS-TABS.md` | `creds.mjs:21,164` · `server.js:634-652` · `model-proxy.mjs:97` | 🚧 | 合并写 + 指名取 + 状态如实 | `/api/model-key` 路由级 test = 0 |
| 配置页四个 tab（客户端） | `76-CREDS-TABS.md` | 仓库**无**；只在 `proposals/.../客户端改动.patch`（7 文件） | ❌ | `grep TabBar lib test`=0；`api.dart:360` 无 `field`；`lib/ creds`=0 | 线上有、仓库无（§五·1） |
| 语音输入 ASR（真链） | `69-ASR-ROUTES.md` · `71-MIC-ASR.md` · D5.17 | `hearing_web.dart:43,146-224,241-303` · `asr.js:137,215-222` | 🚧 | 先 `asr/ready` 再要麦、16k 单声道、按段号 `index`、收尾留 8s | D5.2/D5.10/D5.11 未落地；原生 `hearing_stub.dart:11` 恒 false |
| 读出来 TTS | `68-SPEAK.md` · D5.16 | `composer.dart:375,407` · `speak_test.dart` | ✅ | 念不了不画、历史不念、没说完不念 | `68:27` "画在语音档"过期 |
| 桌面/浮窗/输入条/设置/关于 | `52`/`64`/`72`/`75-CHAT-ROW.md` | `app_desktop.dart:70,74` · `chat_floater.dart:48,442,489` · `composer.dart:261,269,369-404` · `settings_screen.dart:92,101,152` | ✅ | 发送常驻灰、话筒进框、无语音档、设置两分区无 tab | `64:135` 过期；`chat_floater.dart:37,110` 注释过期 |
| 动效（图标⇄页面） | `53`/`73-MOTION-APP.md` | `motion.dart:84,87` · `motion_curve_test.dart`/`motion_swap_test.dart:18` | ✅ | 全程透明度交叉；`ddcb8ed` 图标开合隐藏层修复已入库 | `73:76` 的 `_swapFrom/_swapTo` 不存在 |
| 客户端状态机 | `25-TOKEN-RENEW.md` | `message_state.dart:33` · `conn_state.dart:48` · `stream_uri.dart:57` | 🚧 | 消息四态、连接话术、算地址各有判据 | `stream.dart`（退避/401/游标）无直接判据 |
| 小程序壳 + 沙箱 | `08-SPEC.md` §十四 · `57`-`70` | `mini_runtime_web.dart:40-43,63-68` · `app-serve.js:44-51,216` | ✅ | `sandbox="allow-scripts"`、CSP `default-src 'none'`/`connect-src 'none'`、不发 `X-Frame-Options` | 沙箱三属性无自动判据；Z2 无判据；#70/#71 |
| 图标库 | `70-APP-ICONS.md` | `app-icons.js:25,149` · `mini_app_icons.dart` · `app_spec_test.dart:58` | ✅ | `ICONS` 一处出处 54 个 + 防漂判据 | — |
| 可访问性 | `13-A11Y.md` · D3.5 | `accessibility_test.dart`（39） · `check-client.sh:38` | ✅ | 五档不溢出 + 命中区 ≥44 + 不封顶 | 本轮未跑（只读） |
| 禁用词 | `13-A11Y.md` · §13.2 | `forbidden_words.dart:25,46` · `forbidden_words_test.dart` | ❌ | `'服务器'` 真上屏；`'正在听'` 两闸互斥 | 词表/清单/界面三处不同步 |
| 容器隔离/资源 | `34`-`46` · §13.1 | `create-tenant-pool.sh:92-109` · `admission.js:13-19` | 🚧 | 只读根 + tmpfs + cap-drop + `--memory=768m` + pids 512 | #65/#66/#67/#69；无 `--cpus`；准入算不出 |
| 完整性 P1 | `19-P1-P2.md` · `AGENTS.md` §八 | `integrity.js:33,71,272` · `verify-integrity.mjs` | ❌ | 123 条/17 strict/`root:root 0444`；**漏 1 条 `src/creds.mjs`**、7 处只报 | `AGENTS.md:340` 写"50 个文件" |
| Web 部署/缓存/字体 | `03-DEPLOY-WEB.md`/`15-CACHE.md`/`61` | `deploy-web-v2.sh` · `check-web-refs.mjs` | ❌ | 入口指纹 + 留 3 份；§8.2 讲的是上一代 | 部署脚本不跑 analyze/test；字体指纹无 Dart 判据 |
| 登录/账号 | `37`/`40`/`41` | `auth.js` · `server.js:408-410` | 🚧 | 没短信通道 503 + 人话 | `HUPO_DEV_CODE` 开着（#45） |
| 验收判据 V1–V13 | `08-SPEC.md` §13 | `check-*.sh` | ❌ | V10 要 `RECORD_AUDIO` 实测无；V11 文案过期；V12 未做 | 见 §三·19/20 |

## 三、说假话的地方（文档说了、代码里没有）

1. `08-SPEC.md:249-254` §2.4 列 **4 个不存在的文件**：`conversation.js`、`debug-agent.js`、`personality.js`、`client-build.js`。
2. `03-DEVELOPMENT.md:178,184-185,276,325-326,345,358,553` 把**已删的 `conversation.js`** 当"现状"；真取号是 `timeline.js:75,98`。
3. `08-SPEC.md:173` 说 `/api/health` 回 6 字段；代码 `server.js:512-514` 只回 `{ok,timelineId,seq}`。
4. `08-SPEC.md:723-739` §8.2【有效】整节是上一代：主域名 `hupo.stalkerai.cn`、静态根 `/var/www/hupo`、`scripts/deploy-web.sh`、`scripts/enable-https.sh` 都不成立；真脚本 `deploy-web-v2.sh` 只 `flutter build web`（`:46`），0 处 `analyze/test`。
5. `AGENTS.md:340` 写开机清单"50 个文件"；实测 123 条/17 strict（同一文件自己规定"AGENTS 里不许写数字"）。
6. `00-PROGRESS.md:29`（#88）"语音本体真开麦 ✅做完" vs `63-OWNER-DECISIONS.md:50` 仍按"没做"问主人；同一份热表对撞。
7. `05-DECISIONS.md:189` D5.2"用手机自带的识别器"、`:456` 否决"云端 ASR" vs 代码 `asr.js:40-48`（`HUPO_ASR_URL`/腾讯云）；**没有决策记录这次改道**（D5.17 `:203` 只改形状）。
8. `05-DECISIONS.md:197` D5.10（四类各 20 条、命中率 <90% 不上线）**代码零实现**（`src/`、`test/` 里 `命中率|语料` 0 命中；文档多处只是抄要求）。
9. `05-DECISIONS.md:198` D5.11 加 `RECORD_AUDIO` 没做：`AndroidManifest.xml:16` 只有 `INTERNET`；`check-apk.sh:70-74` 只警告、不置 `bad`。
10. `71-MIC-ASR.md:198`"手机壳里界面上不画话筒" vs `composer.dart:385-404` 一律画、`canHear=false` 点它说 `hearCantHere`。
11. `71-MIC-ASR.md:16-30,187,191` 的"语音档"形状已不存在：`composer.dart:135-137,261` 明写"没有语音档了"。
12. `68-SPEAK.md:27` 说 TTS 开关画在"语音档那一格"；代码 `composer.dart:375` 画在输入框里。
13. `forbidden_words.dart:25` 禁 `'服务器'`，而 `chat_controller.dart:664,976` → `conn_state.dart:48 statusLine` → `chat_screen.dart:680,1044` 真上屏；界面文案清单没收这两句。
14. `forbidden_words.dart:46` 把 `'正在听'` 列为永久禁用，而 `hearing_words.dart:20 hearListening` 真在用（D5.13 `:200` 是"只在真听时"）；豁免没写进任何文档。
15. `64-CHAT-REDESIGN.md:135,157`"发送只在有字时出现 / 听筒只在语音档" vs `composer.dart:266-269,418-430` 发送常驻、无语音档。
16. `73-MOTION-APP.md:76,81` 的 `_swapFrom/_swapTo` 45%→60% 不存在（`motion.dart:74` 只剩注释；实现 `motion.dart:84,87`）。
17. `01-PROJECT.md:300`"宽 >900 限宽 760"不统一：代码是 760/640/**520**/420 四档（`bubbles.dart:49`=520）。
18. `01-PROJECT.md:305`"收起态要有带字的展开入口" vs `chat_floater.dart:489 _FlatChevron` 无字（D3.8 已改成"看得见即可"）。
19. `08-SPEC.md:1276` V11"现在必失败——没有访问序" vs `agent-runtime.js:64` 已有 `#access` LRU。
20. `android_manifest_test.dart:53` 测试名"语音只做'按住说'" vs 代码/`hearing_words.dart:12`"按一下"；`71-MIC-ASR.md:131,133` 条数过期（`hearing_session_test` 写 17 实 **18**、`hearing_test` 写 8 实 **10**）。
21. `48-SETTINGS-KEY.md:83`"配置里暂时只有钥匙 + 关于" vs 代码两分区；`76-CREDS-TABS.md:7` 把 `48` 当契约，**两边都过期**。
22. 四处文案"三个公开路由"（`server.js:5` · `auth.js:3` · `serve.js:940` · `auth-cli.mjs:78`）vs 真实 4 条（`server.js:408`）。

## 四、代码有、文档没写

1. 整块 **`creds.mjs`**（`CRED_FIELDS` `:21` / `VOICE_FIELDS` `:31` / `mergeCreds` `:116` / `parseCreds` `:164` / `isCredField`）：`docs/` 0 命中，却被 5 个 src 模块 import。
2. **`/api/model-key` 的 `field`**（`server.js:634-652`；认不出 `400 bad-field`、非 model 无 `setCred` ⇒ 404）与 **`/api/space` 的 `creds`**（`serve.js:744-755`，只在容器自报过时才发）：§2.1 表里空（契约只在 `CHANGELOG.md` v1.69）。
3. **公开第 4 条 `/api/send-code`**（`server.js:408`）与 `PUBLIC_ROUTES` 漂移；`PUBLIC_ROUTES` 是死导入。
4. 客户端控制帧 **`client/ping`/`client/hello`/`client/reset`**（`server.js:1371,1386` · `stream.dart:130-142`）不在 §2.1/§2.2 事件表。
5. **ASR 下行 `index`**（`asr.js:215-222`，漏了会接出重复的话）——`08-SPEC.md:191` 只写 `{text}`。
6. `HUPO_KEY_FIELD`（`put-key.mjs:54`）· `deploy-web-v2.sh --no-build` · `fingerprint-fonts.mjs`：handbook 0 处。
7. 缺钥匙也照样挂路、回 `asr/unavailable{reason:'not-configured'}`（`serve.js:676-679` · `asr.js:82-88`）；语音三样 `VOICE_FIELDS` 除 `creds.mjs` 无消费方（**送得到容器、接不到识别路**）。
8. 回收站"只读无门槛 / 破坏性要 `confirm`"的分界（`server.js:759-767,888-895`）——文档只写"五条路由"。
9. `hearing_web.dart` 采集细节：`dart:js_util`、`ScriptProcessorNode`、`_blockFrames=4096`、`_readyLimit=5s`、`_lingerLimit=8s`。
10. 租户单元内存 768m / pids 512（`create-tenant-pool.sh:109`）——文档只说"容量算不出"。
11. 死代码/孤儿名：`plan.js:83 planPayload`（0 调用）· `tenant-reload.mjs`/`key-drop.js`（docs 0 命中）。

## 五、做了一半的（明说断在哪；含"越界产物"那一笔）

1. **越界产物（本轮最重的一笔）**：`proposals/2026-09-24-子agent越界产物/` 里 `creds.mjs` 与 `src/creds.mjs` **逐字节相同**（`diff -q` 同）；`服务端改动.patch` 的 7 文件**已全部应用**（`git apply --check` 失败＝已在树里）；`客户端改动.patch` 是 **7 个文件**（含 2 份测试），`git apply --check` **通过＝未入树**；`settings_creds_test.dart` `git log --all` = **0**。线上 `main.751baacff098.dart.js` 含补丁签名（`图片`=2/`视频`=2/`语言`=1/`语音`=5/边界句=2/`服务器`=2），仓库客户端 0 个 `TabBar`，`web/` 被 `.gitignore:30` 忽略 ⇒ **线上跑的是越界产物、不可由仓库重建**。**要砍就明说**：客户端那半要么重做、要么明确丢弃 —— 今天的状态是"线上有、仓库没有"，下次谁部署客户端，四个 tab 会无声消失。
2. **四把钥匙客户端半丢失**（`00-PROGRESS.md:22`），服务端半从产品层 `9f651cd8406f` 捞回（`76` §八）。
3. **语音本体**：真链在，断在决策侧 —— D5.2/D5.10/D5.11 未落地；原生录音 `hearing_stub.dart:11-13` 恒 `unsupported`。
4. **公开面常量漂移无判据**：`PUBLIC_ROUTES` 3 条 + 死导入，闸只钉常量。
5. **`/api/model-key` 路由无 test**：`grep -rln "model-key" test/` 空，只有 `creds.test.js:90` 单元覆盖。
6. **`stream.dart` 本体无判据**：`grep -rl 'stream.dart|StreamClient' test/` 只命中 `import_rules_test`（import 规则）；地址算法有 `stream_uri_test`（15 条）。
7. **禁用词三处不同步**（词表 / `forbidden_words_test.dart` 清单 / 界面实际用词）。
8. **写死尺寸棘轮只扫 `BorderRadius.circular(<数字>)`**（`design_tokens_test.dart:26-33`），`EdgeInsets`/`SizedBox` 无人守。
9. **小程序**：#70（盒子缺 `bubblewrap`）· #71（中心影子世界）没决；**Z2"回到可见不许重建"没判据**（`08-SPEC.md:553` 自认；`mini_app_test.dart:347` 只验"没被销毁"）。
10. **容器资源五条只提方案**（#65/#66/#67/#69 + #68）；P1 `src/**`/`scripts/**` 是 `report` 只报不拦（`integrity.js:71-76`）；完整性清单**漏 `src/creds.mjs`**。
11. **文档侧那一批 strict**（`docs/handbook/**`、`AGENTS.md`）"知道、写着、没修" —— 改要主人补重建命令。

## 六、五席验收判据（工程师 3 · 产品 2，逐席列）

**工程师① 客户端与发布席**

| 判据 | 判定 | 证据 |
|---|---|---|
| 桌面/浮窗/输入条形状（图标 ≥64、点标签也开、发送常驻、话筒进框） | ✅ | `desktop_test.dart:45,62,67` · `composer_actions_test.dart:45,60` · `composer.dart:369-404` |
| 开不了麦也画话筒 + 一句白话（不装开麦、不出假字） | ✅ | `hearing_test.dart:102,113` · `composer.dart:385-404` |
| 设置两分区、无 tab | ✅ | `settings_test.dart:42,48`（5 条） · `grep TabBar lib test`=0 |
| 动效全程交叉 + 图标开合隐藏层 | ✅ | `motion_swap_test.dart:18` · `desktop_test.dart:100` · `ddcb8ed` |
| 可访问性硬闸（五档不溢出/≥44/不封顶） | ⛔判据在 | `accessibility_test.dart` 39 条 · `check-client.sh:38`；本轮未跑 |

**工程师② 服务端与契约席**

| 判据 | 判定 | 证据 |
|---|---|---|
| 公开面 4 条 + fail-closed（未设口令 503） | ❌常量漂 | `server.js:395-445` · `auth.js:35` · `auth.test.js:23` |
| 令牌只走头/子协议；无令牌 401 | ✅ | `test/server.test.js:145,158` · `server.js:1217-1227` |
| 租户转发恰 6 条 | ✅ | `server.js:822` · `tenant-routes.test.js` |
| `/api/health` 形状 | ❌ | 代码 `server.js:512-514` 三字段 vs 文档六字段；无形状闸 |
| 回收站只读无门槛/破坏性 `confirm` | ✅ | `server.js:759,895` · `trash.test.js` 26 |
| `/api/model-key` 的 `field`（400/404） | ⛔无路由级闸 | `server.js:647-651`；`test/` 里 model-key 0 命中 |

**工程师③ 安全运维席**

| 判据 | 判定 | 证据 |
|---|---|---|
| 线上 = 仓库源码可重建 | ❌ | `web/` 忽略（`.gitignore:30`）；线上 `751baacff098` 含补丁签名 |
| 沙箱三条不放松 | ✅ | `mini_runtime_web.dart:40` · `app-serve.js:48` · `app-serve.js:216` |
| 凭据只在服务端、权限 0600、不进产物 | ✅ | `asr.js:40-48` · `data/asr.env` 0600 · `/proc/<pid>/environ` 只核键名 |
| 容器隔离（只读根/tmpfs/cap-drop/768m/512） | ✅ | `create-tenant-pool.sh:92-109`；**无 `--cpus`** |
| 开机完整性不漏、不虚报 | ❌ | `verify-integrity.mjs` 漏 `src/creds.mjs`（63 里 1 个）+ 7 处只报；`AGENTS.md:340` 数字过期 |
| 部署前必须过硬闸 | ❌ | `deploy-web-v2.sh` 0 处 analyze/test；真硬闸在 `check-client.sh:33-38` |

**产品① 交付可信度席**（主人本人 + 32 岁后端工程师，`01-PROJECT.md:51-53`）

| 判据 | 判定 | 证据 |
|---|---|---|
| 界面上不出现内部词 | ❌ | `'服务器'` 上屏（§三·13） |
| 关于页按设备如实说 | ✅ | `about_facts.dart:54-55` · `about_facts_test.dart:32,57` |
| 说了"钥匙用不了"就真的是用不了 | ✅ | `key-state.js:25` · `48-SETTINGS-KEY.md` |
| 语音：不会拼音的人第一天能不能用 | ❌ | 只网页云端；手机壳没做；APK 无 `RECORD_AUDIO` |

**产品② 平板与日常使用者席**（主开发设备＝平板，`01-PROJECT.md:257-264`）

| 判据 | 判定 | 证据 |
|---|---|---|
| 五档字号/宽度不溢出、命中区 ≥44、不封顶 | ✅ | `accessibility_test.dart`（39，硬闸） |
| 小程序开合像样（阴影/交接/不闪/不透出两个图标） | ✅ | `mini_app_surface_test.dart:15,23` · `motion_swap_test.dart` · `ddcb8ed` |
| 聊天收成一行（抓手居中/homeicon/话筒进框/发送常驻灰） | ✅ | `chat_floater.dart:48,442,489` · `composer.dart:261,269` |
| 语音按钮看得见、按下去真出字 | ⛔ | 代码/判据在；真开麦要主人设备 |
| "打开 6 秒没第一个字就上划杀掉" | ⛔ | 无对应时间闸判据（`01-PROJECT.md:54`） |

## 七、验不了的（如实说：要手机/要钥匙/要额度/要 root）

- **要手机**：真开麦（权限框、长按系统菜单、实际识别质量）；TTS"真的有声音"（无头浏览器无音频）；iOS 那条链（手册要 Mac）；"6 秒"要主人平板。
- **要真钥匙/额度**：腾讯云三样现在还能不能用、额度够不够（`/proc` 只核到键名，没读值；`69-ASR-ROUTES.md` 记着混元 `4004 资源包耗尽`）；四把钥匙"填了能不能干活"（patch 自己写"先收在这儿"）；真实模型调用/计费。
- **要 root**：容器活体（`deploy` 不在 docker 组）；准入/容量（每层 `memory.max=max`，`admission.js:13-19` 自认算不出）；完整性"改 strict ⇒ 拒启"要重启服务才算数；租户盒子里 `/data`、`bubblewrap`、影子世界。
- **只读轮不跑**：`npm test`（61 份/777）· `check-client.sh`（会落盘）· `check-web-browser.mjs`（要现发 `HUPO_TOKEN`，`--shot` 会写 PNG）。
- **仓库外/不可复现**：VPS 上那次 `/api/asr` nginx 升级头（仓库无对应文件）；"线上=仓库某版"（`web/` 被忽略）。
- **本机复核推翻的一条**：安全运维席 A4"字体指纹 404、白屏级"**复现不了** —— `web/assets/fonts/MaterialIcons-Regular.082c3415.otf` 本机与公网都 200，文件在（mtime 09-24 02:50）。

## 八、本轮读数与裁决顺序

**本机只读读数**（不是"全过"）：服务端测试 61 份 / `^test(` **777**；客户端 unit 34 份 /**350** · widget 29 份 /**224** · `accessibility_test.dart` **39**；完整性 **123 条 / 17 strict** / `root:root 0444` / `builtAt` 09-24 02:56 / **7 处只报** / 漏 `src/creds.mjs`；线上 `/api/version`=`751baacff098`；`main.751…` 串计数见 §五·1，另两份 `图片/视频/语言/边界句`=0、`语音`=4 和 3、`服务器`=2；`node scripts/check-docs.mjs` ✅ 退出 0；越界 patch 的 `git apply --check` 结果见 §五·1。

**裁决顺序**（同源后订 > 旧条；代码 > 过期文档）：

1. **D5.17（`05-DECISIONS.md:203`，主人 09-23 后订）> D5.2（`:189`）与否决表（`:456`）**：以代码（云端中继）为准；D5.2 欠回填，不是代码错。
2. **`'正在听'` 以 D5.13（`:200`"只在真听时"）为准**；`forbidden_words.dart:46` 那条是过宽写法。
3. **线上 vs 仓库**：以"线上是越界产物"为准，**不许**把线上当仓库现状。
4. **设置页**：以代码为准（两分区、无 tab）；`48`/`76` 两边都过期。
5. **限宽**：以代码为准（760/640/520/420 四档），`01-PROJECT.md:300` 一档写法过期。
6. **手册与代码冲突**（`/api/health`、公开路由、§8.2、§2.4、V11）一律先按代码；手册/strict 要主人补重建命令。
