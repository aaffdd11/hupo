# Hupo 客户端（Flutter · iOS / Android / Web）

> **用户不是跟某个 agent 聊天，而是跟「对话调度器」聊天。**
> 所以这不是"你一句我一句"的问答，界面渲染的是**一条时间线**，不做任何配对。
>
> **产品行为只有三件事**（用户能感知的全部）：
> 1. **给一句反馈** —— 能现在答就现在答
> 2. **说我拿去做了** —— 要很久的事（十几秒到更久）变成**独立任务**，不再占用当前对话
> 3. **我回来说结果** —— 做完了主动回来报，必要时**打断当前话题**（"对了，我打断一下，前面那件事做完了"）
>
> 快慢、超时、思考深度、降级 —— **全是内部细节，用户一个都不需要知道**。
> 界面上**没有**"简单/复杂/深度"这类分类。
>
> 所有 agent 逻辑在云端（见 `services/core/`），客户端刻意保持"笨"。

## 快速开始

```bash
export PATH="$HOME/sdk/flutter/bin:$PATH"

cd apps/mobile
# 开发期要复现边界情况（很快/很慢/失败/不出声/主动/要很久）时：
#   flutter run --dart-define=HUpo_DEMO=true
# 生产构建**不带**这个开关，界面上不会出现任何内部档位。
flutter pub get
flutter run -d chrome      # 浏览器里看（最快）
flutter run                # 真机/模拟器
flutter test               # 单元测试（14 个）
```

部署 Web 到 `hupo.stalkerai.cn`：

```bash
scripts/deploy-web.sh      # 分析 → 测试 → 构建 → 部署到 /var/www/hupo
```

## 这个客户端必须做对的事

这些不是"体验优化"，是评审结论里的**不变量**，都有测试守着：

| 不变量 | 为什么 | 守它的地方 |
|---|---|---|
| **不做配对（R1）** | 调度器可主动开口、一次回应几条、只记不答、结论晚到 —— 任何"用户[i]↔回答[i]"假设都会错位 | 单一 `timeline` + `test/unit/timeline_test.dart` |
| **任务可见（R6）** | 有事情在做时必须让用户知道"还没回来"，但**不显示进度百分比**（伪精确） | `activeTasks` + 输入框上方的提示条 |
| **一条消息 = 一个气泡（R2）** | 快答与深答是同一消息的两个块，用户应感觉是一次说完 | `DispatcherMessage.displayText` + `AnswerBubble` |
| **状态不是消息（R3）** | 状态混进正文会进历史、被当成"说过的话" | `StreamStatus` 与文本是两个类型；被动聆听走独立区域 |
| **中止不擦除（R4）** | 已显示的字撤不回来；擦除会闪、会丢信息 | `abort()` 只标记结束并追加说明 |
| **失败必须有合法收尾** | "快答已发出、深答失败"是**最危险的失败态** | `MessageEndReason.failed` + 兜底文案 |
| **`seq` 去重与续传（R5）** | 断线重连必然产生重复事件 | `seqInBlock` 单调性 + `ChatController.lastSeq` |
| **连续发言顺序不乱** | 用户连说两句，早说的必须排在前面 | 排序键 `(seq, tie)` |
| **输入框永不锁死** | 用户必须能随时插话 | `_Composer` 在调度器说话时仍可输入 |

## 架构

```
lib/
├── models/
│   ├── stream_event.dart     协议：调度器下行事件（唯一来源是 packages/protocol/PROTOCOL.md）
│   └── timeline.dart         时间线：用户发言与调度器消息都是独立条目，**不配对**
├── services/
│   ├── transport.dart        传输契约
│   ├── mock_transport.dart   本地回放四种时间线（无服务端也能验证观感）
│   ├── websocket_transport.dart  真实传输：WS 下行 + HTTP 上行 + 断线续传
│   └── chat_controller.dart  状态机：把事件流折叠成界面消息
├── screens/chat_screen.dart  对话页（按时间线渲染，不做配对）
├── widgets/answer_bubble.dart  一条回答的气泡（无缝衔接在客户端的落点）
└── main.dart                 入口 + 开发期场景切换器
```

## 开发期场景切换器

`main.dart` 底部有四个场景按钮，用来对照四条真实时间线：

| 场景 | 时间线 | 验证什么 |
|---|---|---|
| **简单问题** | 处理层 ~0.9s 就绪 | 快答刚说完，深答紧接着接上（两块应**无缝**） |
| **复杂问题** | 处理层 6.5–7.9s | 空窗期由状态提示承担在场感，**不产出废话** |
| **深答失败** | 深答超时/失败 | 必须有**合法收尾**，不能留白（评审结论 Q1） |
| **被动聆听** | 不出声 | 只有状态提示，不产生消息 |
| **主动开口** | 用户没说话 | **调度器自己发来一条**（如异步任务完成）—— v0 模型无处安放的情形 |
| **要很久** | 十几秒以上 | **变成独立任务**：说"我拿去做了" → 界面显示处理中 → 做完**打断回来**报结果 |

## 与服务端对接

协议定义在 `packages/protocol/PROTOCOL.md`（**改协议先改那份**）。
切换到真实服务端：把 `main.dart` 里的 `MockTransport` 换成

```dart
WebSocketTransport(baseUrl: 'https://api.hupo.stalkerai.cn', token: /* 设备令牌 */)
```

⚠ 令牌必须放平台安全存储（iOS Keychain / Android Keystore），**不进日志、不进构建产物**。

## 已核实的工具链

- Flutter 3.35.1 stable / Dart 3.9.0（装在 `~/sdk/flutter`）
- `flutter analyze` 零问题，`flutter test` **35/35 通过**（单元 + 渲染）
- Web 构建产物约 30MB，部署在 `/var/www/hupo`，nginx 配置 `/etc/nginx/conf.d/hupo-chat.conf`

## 已知边界（当前阶段）

- 只有对话页是完整的；会话列表与设置页尚未开工
- H5 交付容器（T3/T4）未接入 —— 协议里已预留入口
- 交付形态四档（T1–T4）的判定在服务端，客户端只负责渲染
