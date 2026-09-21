// **钥匙那条路上的两个结果**（纯逻辑 —— 协议词汇，没有 I/O、没有 UI）。
//
// ⚠️ 为什么它们在 `models/` 而不是 `services/api.dart`：
//    填钥匙那一块表单（`widgets/key_form.dart`）要用它们，而**楼层闸**写着
//    "`widgets` 只许看 `models`"。它们是**纯枚举**（一份协议词汇表），
//    放这儿既守住了楼层，也让 `test/unit` 能直接钉它们。
//    `services/api.dart` 照旧 re-export（老的 import 一行都不用改）。

/// 送钥匙的结果。**四种失败分开**（混成一句用户会一直重试）。
enum KeySend { ok, blank, badChars, tooLong, failed }

/// 取消注册的结果。
///
/// ⚠️ 分这么细是因为**每一种该说的话不一样**：`noHelper` 是"我们这边还没接上"、
///    `protectedOne` 是"你这一台得找人来收"、`failed` 是"没送上去"。
///    混成一句"失败"他会一直重试（这个项目里已经栽过好几次）。
enum CancelOutcome { ok, noHelper, protectedOne, local, noTenant, failed }
