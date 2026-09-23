// **网页**：用浏览器自带的朗读（`window.speechSynthesis`）。
//
// ⚠️ 这一份只在 `flutter build web` 的产物里生效。
//    与 `links_web.dart` / `mini_runtime_web.dart` 同一条路（`dart:html`，零新依赖）；
//    真要换 `package:web`，**几个文件一起换**。
//
// 🔴 **它一个字节都不往外发**：`speak()` 是把文字交给**浏览器/系统**的合成器。
//    （有些平台上那个合成器自己会用云端音色 —— 那是系统读任何文字都一样的性质，
//      不是我们在传；界面上那句"读出来"说的就是这个能力，不承诺"纯本地"。）

// ignore: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;

/// 网页上**能不能念**：光有 `speechSynthesis` 不够，还得**真有音色**。
///
/// ★ P1-2（2026-09-24）：原来是写死的 `true` ⇒ 哪怕浏览器**一个音色都没有**
///   （实测：无头 Chrome 里 `getVoices().length == 0`，一按就回 `err:not-allowed`），
///   那个「读出来」开关照样画出来 —— 按下去什么都不会发生（"按不动的东西"）。
///   ⇒ 改成**真的问浏览器**。
///
/// ⚠️ 已知的取舍：音色是**异步**加载的，某些平台第一次读会拿到空表。
///   那种情况下这个开关会**暂时不画**（按 D5.16"念不了就不画"那条走）；
///   页面每次重建都会重读一次，音色到位后它自己会出现。
bool get canSpeak {
  final synth = html.window.speechSynthesis;
  if (synth == null) return false;
  try {
    return synth.getVoices().isNotEmpty;
  } catch (_) {
    return false; // 问不出来 ⇒ 当作念不了（不画比画一个假的强）
  }
}

/// 正在念的那一段（用来在"新的开念"和"停"的时候认得出它）。
html.SpeechSynthesisUtterance? _current;

/// **念一段**。
///
/// @returns 真的交出去了才 `true`（空文本 / 没有合成器 ⇒ `false`）
bool speakAloud(String text, {void Function()? onEnd}) {
  final t = text.trim();
  if (t.isEmpty) return false;
  final synth = html.window.speechSynthesis;
  if (synth == null) return false;

  // ① **先停掉上一段**（一次只念一段；不 cancel 的话两段会排队叠着念）
  synth.cancel();

  final u = html.SpeechSynthesisUtterance(t)
    // 助手说的是中文；指一下语言，系统才挑得对音色（挑不到也会用它默认的）
    ..lang = 'zh-CN';
  // ⚠️ **只有"还是它"的时候才回调**：用户可能中途点了别的一段
  void done(_) {
    if (!identical(_current, u)) return;
    _current = null;
    onEnd?.call();
  }

  u.onEnd.listen(done);
  // 出错（没装音色、被系统拒）也要**把手放开**，否则界面上会一直显示"正在念"
  u.onError.listen(done);
  _current = u;
  synth.speak(u);
  return true;
}

/// **停**。停不掉也不抛（合成器没有的时候它本来就没在念）。
void stopSpeaking() {
  _current = null;
  try {
    html.window.speechSynthesis?.cancel();
  } catch (_) {
    // 浏览器不给停（少见）：界面上的状态由调用方那一层复位
  }
}
