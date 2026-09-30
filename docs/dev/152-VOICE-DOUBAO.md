# 152 · **语音识别换成豆包**（主人 2026-10-01 定）

> **主人原话**：*「帮我把语音，图像，视频，全部用豆包大模型来配置。也就是语音识别，用豆包，
> 图片生成用seedrean，视频用seedance。」*
> 我摆开两条路让他挑，他选了 **甲：完全换成豆包**（腾讯那三样撤掉、不留兜底）。

---

## 一、换的是什么（不是"接一个开关"）

| | 换之前（腾讯） | 换之后（豆包） |
|---|---|---|
| 上游 | `wss://asr.cloud.tencent.com/asr/v2/<appid>` | `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel` |
| 鉴权 | **签名 URL**（HMAC-SHA1，`SecretId`/`SecretKey`，每次连接现签） | ★ **两套都支持**：**新版**（一把 API Key）`X-Api-Key` ＋ `X-Api-Resource-Id` ＋ `X-Api-Request-Id`（★ 2026-10-01 晚补的，主人贴的官方文档就是这么写的）；**旧版** `X-Api-App-Key`(App ID) · `X-Api-Access-Key`(Access Token) · `X-Api-Resource-Id` · `X-Api-Connect-Id`(UUID) |
| 协议 | JSON 文本帧（`code` 握手、`result.slice_type`、`final:1`） | **二进制帧**：4 字节 header ＋ [sequence] ＋ 4 字节长度（大端） ＋ payload；请求参数走 **gzip 的 JSON**；错误帧两种形状 |
| 音频 | 16k 单声道 PCM | 一样（`pcm_s16le` / 16k / 单声道；一包 100–200ms，我们按 200ms 发） |
| 凭据几样 | **三样**（AppID / SecretId / SecretKey） | ★ **一把 API Key**（新版控制台；旧版那两样照旧认）。资源 id 可选，默认 `volc.bigasr.sauc.duration` |

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
| `test/asr-probe.test.js`（6 条 · 探针自己的判据） | `--selftest` 8 条全过 · 🔴 **输出里一个字符的钥匙都没有** · 干跑**绝不建连** · 没钥匙还想真连 ⇒ 当场退 3 · 端点可覆盖（不许写死）· 探针读的是**产品那一份实现**（同一段 PCM 两边的帧逐字节一样） |

**读数**：服务端 `npm test` **1401 过 / 0 挂**（本片 **+7**）· 客户端见 §五 ·
探针 `--selftest` **8/8** ＋ `--handshake` 的真上游读数见 **§四·补**。

---

## 四、✅ **已经完全切过去并上线**（2026-10-01 晚 · 主人：*「完全切成豆包哦」*）

**线上现在是豆包那一版**（腾讯那半条腿**下线**了）。这一趟做了什么、读数是什么：

| 做了什么 | 命令 / 现场 | 读数 |
|---|---|---|
| 切之前先把行里的老东西**挪干净** | 主人那份 `data/creds/owner.yaml` 里原来只有腾讯那三样（`HUPO_VOICE_APPID` / `SECRET_ID` / `SECRET_KEY`）⇒ 三样**整体备份**成 `data/creds/owner.yaml.tencent-bak`（0600），活的那份只留**豆包那两样**（留空，等他填） | 备份在，活字段两样都空 ⇒ `creds.voice = false`（**不是**"假装配好了"） |
| `data/asr.env`（部署默认那份）里那四行 `TENCENT_*` **删掉** | 顶上写明现在认哪三个名字（`DOUBAO_ASR_APPID` / `DOUBAO_ASR_TOKEN` / `DOUBAO_ASR_RESOURCE`）；旧值**不再留第二份**（备份文件里那份就是旧值） | 解析出来**零个**名字 ⇒ 兜底那份 = 没配（如实） |
| **重启**（真正切过去） | `scripts/restart-core.sh` | 开机横幅「完整性 对上了」· 本机 **200** · `active` |
| 🔴 **线上那条 `/api/asr` 的真读数**（新代码下） | 现发令牌 ⇒ WS 连 `/api/asr`（令牌走**子协议** `['bearer', <token>]`）⇒ 发 `{"type":"asr/start"}` | ① 不带令牌 ⇒ **HTTP 401**（握手阶段就拒）；② 带令牌 ⇒ `{"type":"asr/unavailable","reason":"not-configured"}` ⇒ **不装开麦、如实说没配** |
| **客户端也部署了**（两半同一次上） | `scripts/deploy-web-v2.sh` ＋ `scripts/publish-apk.sh` | 入口指纹 **`13e72d6a5739`** · 源码指纹 **`01bf3efc9052`** · 公网 **200** · 部署自检「页面开得开、那条流通着」· APK **523**（55,406,454 字节 · sha256 `c97252213b59…` · 公网逐字节一样）· **产物里核过那一屏**：`main.13e72d6a5739.dart.js` 里就是 `voiceAppId:"App ID"` ＋ `voiceAccessToken:"Access Token"` 两样（没有 `SecretId`/`SecretKey`/`腾讯` 任何一个字） |
| 两闸 | 部署脚本替跑 | 服务端 **1417 过 / 0 挂** · 客户端硬闸全过（unit **849** · a11y **399** · 其余 **427**） |
| 🔴 **填写那条路也真读了一次**（线上 `POST /api/creds`） | 现发令牌（主人身份）发三种**只读性质**的请求 | ① **老的腾讯字段名**（`voiceSecretId`/`voiceSecretKey`）⇒ **`400 bad-field`**「有一项我不认识，先别存。」⇒ **线上服务端已经不认老名字**（切干净了）· ② 豆包那两样但**空值** ⇒ **`400 blank-key`**（空不算填）· ③ ⚠️ 只给 `voiceAppId` 一样 ⇒ **`200`**（**服务端允许半截写**）但 `creds.voice` **如实 `false`**（判"有没有"的是 `credStatus`：两样齐了才算有）|

⚠️ **如实说一件我自己碰过的现场**：上表第 ③ 条**真的写进去了一个探针值**（`voiceAppId: probe-only-appid`）——
   我当场把主人那份**还原成"两样都空"**，并用真读者核过（`readUserCreds(owner).values = {}` · 线上 `/api/space`
   `creds.voice=false` · 文件里 `grep probe` = 0）。⇒ 教训：**"只读性质"要先看清楚哪一条会写**；
   以后这类检查一律先备份再发、或者直接用一个假身份（⚠️ 假身份走不通：`/api/creds` 对没有租户的人回 `503 space-not-ready`）。

### 四·甲、**还差最后一步：那两样得填进去**（主人自己的事，一分钟）

语音现在**只在配置页「语音」那一屏填了那两样之后**才出声。两条路都行：

1. **你自己填**（推荐）：打开 <https://w.stalkerai.cn> → 配置页 → 「语音」→ 填
   **App ID** 与 **Access Token**（火山引擎控制台 → 语音技术 → 应用管理）→ 保存。
   保存后**不用重启**（那份凭据每次现读）。
2. **你把那两串贴给我**：我替你写进 `data/creds/owner.yaml`（0600、不进日志、不进仓库），
   然后跑真麦克风那一趟并把上游原话记回 §五。

⚠️ **注意**：那两样**不是**原来腾讯那三样 —— 老的 `App ID`（十位数字那个）已经挪进备份文件，
现在的 `App ID` 要的是**豆包语音**控制台里那个（Access Token 也是它旁边那一串）。

⚠️ **为什么现在就敢切**（而不是等钥匙）：主人明说*「完全切成豆包哦」* ⇒ 不留"腾讯那半条腿还活着"
那种半成品状态；而**配置页本来就是填钥匙的地方**（不是开发动作）。代价只有一个、而且如实说：
**在你填那两样之前，按语音会说"还没配好"**（聊天一个字都不受影响）。

---

## 四·补、**钥匙到之前就拿到了的那两条真读数**（2026-10-01）

新探针：`scripts/check-asr-doubao.mjs`（与 `check-ark-image.mjs` / `check-ark-video.mjs` 同一个形状：
**默认干跑不花钱**，要真发得显式点头；**一个字符的钥匙都不打印**）。它有四档：

| 命令 | 干什么 | 花不花钱 |
|---|---|---|
| `--selftest` | 不联网：帧形状 8 条（header 那几格 · 长度大端 · gzip 的 JSON · 音频原样 · 最后一包 · 两种错误帧 · 认不出 · 抹钥匙） | 不 |
| `--handshake` | 🔴 **只探"哪几个建连头是必须的"**（**假值**） | 不 |
| （不带参数） | 干跑：只说"会发什么" | 不 |
| `--spend` | 真连真发（`--pcm` 可喂真人音频；`--fake` ＝ 假凭据连真上游） | **按秒算钱**（`--fake` 那次不花） |

### 读数一：建连头这一关（`--handshake` · 假值 · 缺钥匙也能跑）

```
一个头都不带                             HTTP 400
只有 App Key                             HTTP 400
App Key ＋ Access Key                    HTTP 400
App Key ＋ Access Key ＋ Connect-Id      HTTP 400
App Key ＋ Access Key ＋ Resource-Id     HTTP 401
四样都在                                  HTTP 401
```

**这两句话是真的**（都是真上游回的）：
1. **端点与头名它认**：少了必须的那几样 ⇒ `400`；头齐了才轮到"你这个钥匙行不行" ⇒ `401`。
   不认头名的话，两种情形都会是 400 ⇒ **400/401 这条分界就是证据**（"不许猜接口"那一课）。
2. 🔴 **`X-Api-Resource-Id` 是必须的**（带上它才 400→401）；`X-Api-Connect-Id` **不是**（有没有都一样）。
   ⇒ 我们默认那个资源 id 是"要填对的东西"，不是可选装饰。

⚠️ **它不证明钥匙对不对**（假钥匙本来就该 401），也**不证明上游收我们的帧**（鉴权在握手那一关就拦住了，
根本走不到帧）—— **那一条还欠真钥匙那一次**。

### 读数二：`--spend --fake`（假凭据连真上游）

```
· error:upstream：Unexpected server response: 401
· error:closed-before-ready：还没握上手就断了
```

⇒ **真实形状**：豆包的鉴权**发生在 WS 握手**（HTTP 401），不是"先连上再发错误帧"。
⇒ 顺带修掉探针自己的一处措辞：**"没连上"与"上游拒了"必须分开说**（混成一句会让人拿着好钥匙去查错地方）。

---

## 五、如实说（没做的 / 边界）

* 🔴 **真麦克风那一趟还没有**（那两样还没填）—— 到这一步为止是"**代码 ＋ 判据 ＋ 已部署 ＋
  `/api/asr` 的真读数（`asr/unavailable{not-configured}`）**"，
  **没有**一条"真麦克风 ⇒ 豆包给字"的读数。⚠️ 不许说成"验过了"。
  ⇒ 补上它只有两步：配置页填那两样（§四·甲）⇒ 说一句，把上游原话记回这里。
  想先绕开客户端直连验一次：`DOUBAO_ASR_APPID=… DOUBAO_ASR_TOKEN=… node scripts/check-asr-doubao.mjs --spend`
  （用的是**产品那一份帧实现**；`--pcm` 可以喂真人音频）。
* ⚠️ **老的腾讯凭据还在盘上**（`data/creds/owner.yaml.tencent-bak`，0600）——
  按"完全切成豆包"它们**已经没有任何代码会读**；留着只是**备份**（要不要删由主人说）。
* **上限仍是 55 秒**（老那套是腾讯内测版 1 分钟才定的）——豆包没有这条硬限，
  "一次说多久"是**产品决定**，没动。
* **不支持中途换语言/热词**（`corpus`/`boosting_table` 那些字段没接）——要用再说。
* ★ **2026-10-01 晚：租户那一侧也真跑过了**（主人报"填好了没效果"时查出来的）——
  🔴 **"有自己一台"的账号，`/api/asr` 是被代理进他自己的盒子的**（租户在 `wantAsr` 之前就
  `proxyUpgrade` 进去）⇒ 语音跑的是**盒子里那份产品层**。当时 `current` 还是换豆包之前的
  `b5190029d6d2` ⇒ 盒子只认老的腾讯三样，**宿主再新也没用**（他的音频不经过宿主）。
  ⇒ 已把产品层翻到 **`eafa39b06241`**（两次：`302db208740d` → `eafa39b06241`，`--verify` 都真跑过），
  ### 五·甲、他手上那两串到底卡在哪（2026-10-01 真连接诊断，**不打印任何字符**）
  * **形状**：App ID 那一格 **47 位、ASCII、非纯数字**（里面最长的数字段只有 1 位）⇒ **不是控制台上那个数字 App ID**；
    Access Token 60 位、同是非纯数字。
  * **资源 id 不是原因**：`volc.bigasr.sauc.duration` ⇒ **401**、`volc.bigasr.sauc.concurrent` ⇒ **401**
    （网关**认**这两个 id ⇒ 走到验钥匙那一关）；`volc.seedasr.sauc.duration` 等四个 ⇒ **400**（网关不认那些 id）。
  * **贴反了也不是**：两格对调 / 只取数字段 / 两格都取数字段 —— 四种组合**全 401**。
  ⇒ 结论：**那两串不是这套服务要的那一对**（最可能把 App Key 或别处的串粘进了 App ID）。
  **三台容器都自己重开并报上新版**。真读数：他那个号 ⇒ `asr/error（bad-key）code=401`，
  上游原话「上游拒绝了这次连接（HTTP 401）」⇒ **他填的那两样豆包不认**（不是盒子的问题了）。
* ✅ **`data/asr.env` 里那四行 `TENCENT_*` 已经删掉**（2026-10-01 部署时顺手做的，见 §四）——
  顶上写明现在认哪三个名字；**旧值不在那儿留第二份**。
