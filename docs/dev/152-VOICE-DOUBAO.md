# 152 · **语音识别换成豆包**（主人 2026-10-01 定）

> **主人原话**：*「帮我把语音，图像，视频，全部用豆包大模型来配置。也就是语音识别，用豆包，
> 图片生成用seedrean，视频用seedance。」*
> 我摆开两条路让他挑，他选了 **甲：完全换成豆包**（腾讯那三样撤掉、不留兜底）。

---

## 一、换的是什么（不是"接一个开关"）

| | 换之前（腾讯） | 换之后（豆包） |
|---|---|---|
| 上游 | `wss://asr.cloud.tencent.com/asr/v2/<appid>` | `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel` |
| 鉴权 | **签名 URL**（HMAC-SHA1，`SecretId`/`SecretKey`，每次连接现签） | **建连头**：`X-Api-App-Key`(App ID) · `X-Api-Access-Key`(Access Token) · `X-Api-Resource-Id`(资源) · `X-Api-Connect-Id`(UUID) |
| 协议 | JSON 文本帧（`code` 握手、`result.slice_type`、`final:1`） | **二进制帧**：4 字节 header ＋ [sequence] ＋ 4 字节长度（大端） ＋ payload；请求参数走 **gzip 的 JSON**；错误帧两种形状 |
| 音频 | 16k 单声道 PCM | 一样（`pcm_s16le` / 16k / 单声道；一包 100–200ms，我们按 200ms 发） |
| 凭据几样 | **三样**（AppID / SecretId / SecretKey） | ★ **两样**（App ID / Access Token；资源 id 可选，默认 `volc.bigasr.sauc.duration`） |

🔴 **面向浏览器那一套一个字都没改**：`/api/asr` 的 WS 协议、`asr/ready`·`partial`·`final`·`end`·
`capped`·`error`·`unavailable` 那些语义、二进制音频进 / JSON 事件出 —— **客户端不用动协议**，
只改了配置页语音那一屏（三样 → 两样）。

---

## 二、落在哪几个文件

| 文件 | 做什么 |
|---|---|
| `src/asr-doubao.js`（新） | 那两样东西都在这里：**帧的编解码**（`encodeFullClientRequest` / `encodeAudioFrame` / `decodeServerFrame`）＋ **上游那一跳**（`createDoubaoUpstream`：建连头、排队、把回帧翻成 ready/partial/final/end/error） |
| `src/asr.js`（改） | 中继那一层**只换了上游**：`onReady` ⇒ `asr/ready`；`onPartial` ⇒ 半句；`onFinal`（`definite`）⇒ 定稿 ＋ 段号；`onEnd` ⇒ `asr/end`；错误按 `engine`/`upstream` 分开报。**配额/账本/上限/收尾原因一个字没动** |
| `src/asr-creds.js`（改） | 环境变量与存档字段都换成豆包那两样（`DOUBAO_ASR_APPID` / `DOUBAO_ASR_TOKEN`）；"他自己那份优先"那条缝照旧 |
| `src/creds.mjs`（改） | `VOICE_FIELDS` = `['voiceAppId','voiceAccessToken']`（**两样齐了才算有**） |
| 客户端 | 配置页语音那一屏：**两样**（`App ID` / `Access Token`）＋ 那四句边界话改成"这两样" |
| ~~`src/asr-sign.js`~~ · ~~`scripts/check-asr-tencent.mjs`~~ | **删掉**（甲：腾讯那套不留） |

🔴 **两条纪律照旧**：**钥匙只在服务端**（`data/asr.env` 与 `data/creds/<他>.yaml`，0600）·
**没配就如实说"没配"**（`asr/unavailable`），**绝不装开麦**。⚠️ **声音仍然会出境**（现在出境到豆包）。

---

## 三、判据（真链路上的）

| 在哪 | 钉什么 |
|---|---|
| `test/asr-doubao.test.js`（新 · 7 条纯函数） | **D1** 凭据：名字是豆包那两样、两样齐了才算配、**老 `TENCENT_*` 不再读**、`HUPO_ASR_URL` 那个换上游的口照旧 · **D2** 建连头四样都在 ＋ 每次一个新 UUID · **D3** 请求参数帧 header 那几格（version/header size/消息类型/flags/JSON/gzip）＋ 长度字段 ＋ gzip 正文 · **D4** 音频帧：**PCM 一个字节都不动**、"最后一包"是 flags `0b0010` · **D5** 回帧：半句 / 定稿 / gzip 与不压缩 / 段号 · **D6** 🔴 **错误帧两种形状都认** · **D7** 认不出的回帧如实说认不出（不抛） |
| `test/asr.test.js`（15 条 · **假豆包**那个桩说的就是真协议） | 音频一个字节不改地过去 · 半句/定稿/收尾映射对 · `asr/ready` 要等上游**真的回了第一帧** · 握不上手 ⇒ 如实 `asr/error`（**不许说 ready**）· 连上之前推的音频不丢 · `index` 真的传下去 · 鉴权不过 ⇒ 原话转达且**回话里没有钥匙** · 连不上 ⇒ `reason=upstream` · 到点收手 ⇒ `asr/capped` ＋ 对上游说"最后一包" · 收尾那条带"为什么收的尾" |
| `test/asr-creds.test.js` / `test/creds.test.js` / `test/creds-box.test.js` | 两样的口径（缺一 ⇒ 不算"他填了"）· 盒子里那份单文件读得到 · 推给盒子的顺序（模型那把仍要最前） |
| 客户端 `test/unit/space_test.dart` · `test/widget/settings_test.dart` | 语音那一屏**两样** · 一次提交写整屏（不许分两次）· 四句边界话（改成"这两样"） |

**读数**：服务端 `npm test` **1401 过 / 0 挂**（本片 **+7**）· 客户端见 §五。

---

## 四、⏸ **这一片还没部署**（如实说）

**线上那一版仍然是腾讯**（能正常用）。换过去要**主人那把豆包钥匙**：

1. 火山引擎控制台 → 语音技术 → 应用管理 → 拿到 **App ID** 与 **Access Token**；
   若开通的是"大模型流式语音识别"，顺带记下 **Resource ID**（1.0 小时版 `volc.bigasr.sauc.duration`，
   2.0 是 `volc.seedasr.sauc.duration`）。
2. 我把它写进 `data/asr.env`（0600、不进仓库、不进日志）与/或你那一份按人存档，
   然后 **重建开机清单 ＋ 重启**（`hupo-persona.yml`/手册/能力层是 `strict`，改动要走那一步）。
3. 真跑一次：拿真麦克风说一句 ⇒ 看 `/api/asr` 回的字与日志里那行
   `asr：会话开始 · 资源 … · 凭据来源 his-own` ⇒ 把上游原话/读数记回这一节。

⚠️ **为什么不在拿到钥匙前就部署**：一部署，线上语音就会从"能用"变成"没配" ——
   那是**他没用要求的回退**。⇒ 代码 ＋ 判据已经就位，钥匙一到就切。

🔴 **但"没部署"只在这条进程活着的时候成立**（`00-PROGRESS.md` §九·补50）：新代码**已经在盘上**，
   线上现在跑的是 2026-09-30 17:39 起的那条**老进程**（内存里还是腾讯那一版）。
   ⇒ **它一旦因任何原因重启**（他重启服务 / 崩溃 / 机器重启）⇒ 起来的就是**豆包那一版**，
   而 `data/asr.env` 里那三行 `TENCENT_*` **不再被读** ⇒ 语音当场变成 `asr/unavailable`（"还没配好"），
   **聊天不受影响**。⇒ 两件事别弄混：**这不是部署**（客户端那一半我也**故意没部署**，
   不然配置页会摆着"两样"而线上服务端要的是三样，那才是页面在说假话）；
   而是"钥匙没到之前，别让它自己先翻过去"。

---

## 五、如实说（没做的 / 边界）

* 🔴 **真跑一次还没有**（缺钥匙）—— 到这一步为止是"**代码 ＋ 判据**"，
  **没有**一条"真麦克风 ⇒ 豆包给字"的读数。⚠️ 不许说成"验过了"。
* **上限仍是 55 秒**（老那套是腾讯内测版 1 分钟才定的）——豆包没有这条硬限，
  "一次说多久"是**产品决定**，没动。
* **不支持中途换语言/热词**（`corpus`/`boosting_table` 那些字段没接）——要用再说。
* **租户那一侧**走的是同一条实现（盒子里跑同一个 `serve.js`），但**没在真盒子里验过**（同上面那条钥匙）。
* **老 `data/asr.env` 里那三行 `TENCENT_*` 现在是死名字**（不再读）——
  部署那一天我会顺手把它换成豆包那两行（或在文件顶上写清"这几行没用了"）。
