// **原生录音那一份**（契约 `docs/dev/129-NATIVE-ANDROID-BUILD.md` §十二）。
//
// 主人 2026-09-28：*「你帮我测试录音能力。」* —— 而当时包里编进去的是**桩**
// （`libapp.so` 里读得到 `package:hupo_app/services/recorder_stub.dart`），
// 所以先把原生那份做出来，再谈"测"。
//
// ── 这一份怎么测（VM 上没有真麦克风，也没有 Android 那台机器）──────
//   把它那一侧的东西**假掉**：`hupo/recorder` 这条 MethodChannel 换成假的，
//   然后量两件事：
//     ① **话是怎么说的**：`start` 回 `null/denied/unsupported/failed`，
//        界面拿到的"这台录不了"必须是**同一批原因**（与网页那份共用词表）；
//     ② **钩子装没装**：没装 ⇒ 恒假（VM/iOS 那一档）；装了 ⇒ 全转给原生那一份。
//
// 🔴 **真麦克风那一下只有装到手机上才算数** —— 这一份量的是"线接对了没有"。

import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/services/recorder.dart';
import 'package:hupo_app/services/recorder_native.dart';

const _ch = MethodChannel('hupo/recorder');

/// 假的那一头：记下都收到过什么，并按脚本回话。
class _Fake {
  final List<String> calls = <String>[];
  final List<Object?> args = <Object?>[];
  String? startWhy; // null = 开起来了
  Map<String, Object?> stopReply = {'ok': false};
  bool playOk = true;

  Future<Object?> call(MethodCall c) async {
    calls.add(c.method);
    args.add(c.arguments);
    switch (c.method) {
      case 'start':
        return startWhy;
      case 'stop':
        return stopReply;
      case 'play':
        return playOk;
      default:
        return null;
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Fake fake;

  setUp(() {
    fake = _Fake();
    clearNativeRecorder();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_ch, fake.call);
  });

  tearDown(() {
    clearNativeRecorder();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_ch, null);
  });

  /// 模拟 Kotlin 那一侧主动叫回来（放完了）。
  Future<void> firePlayEnded() async {
    await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.handlePlatformMessage(
      'hupo/recorder',
      const StandardMethodCodec().encodeMethodCall(const MethodCall('onPlayEnded')),
      (_) {},
    );
  }

  group('没装钩子（VM / iOS / 桌面那一档）', () {
    test('🔴 恒假 ＋ 每一句都说实话（不许静默、不许假装能录）', () async {
      expect(canRecord, false, reason: '★ 没装原生钩子就是"这里录不了"');
      expect(await recordStart(), 'unsupported', reason: '★ 要回一句机器原因，界面才翻得出人话');
      expect(await recordStop(), isNull);
      var ended = 0;
      play('whatever.m4a', () => ended += 1);
      expect(ended, 1, reason: '★ 放不了也要"收场"（按钮别停在别放了上）');
      stopPlay();
      releaseAll();
      expect(fake.calls, isEmpty, reason: '★ 没装钩子时**一次都不该**去碰那条 channel');
    });
  });

  group('装上钩子（安卓那一档）', () {
    test('★ 装了 ⇒ 能录，而且开始/收手/放音都转到那条 channel 上', () async {
      installNativeRecorder();
      expect(canRecord, true);
      fake.startWhy = null;
      expect(await recordStart(), isNull, reason: 'null = 真开起来了');
      expect(fake.calls, contains('start'));
    });

    test('🔴 开不起来 ⇒ **机器原因原样带回来**（没权限 / 这台没有麦 / 别的错）', () async {
      installNativeRecorder();
      for (final why in ['denied', 'unsupported', 'failed']) {
        fake.startWhy = why;
        expect(await recordStart(), why, reason: '★ 一个原因一句话：$why 不许被吞掉');
      }
    });

    test('★ 收手：那一份带回来了 ⇒ 一条本机地址 ＋ 毫秒数；空的那一段 ⇒ null', () async {
      installNativeRecorder();
      fake.stopReply = {'ok': true, 'path': '/data/cache/hupo-rec-1.m4a', 'ms': 3400, 'bytes': 51200};
      final clip = await recordStop();
      expect(clip, isNotNull);
      expect(clip!.url, '/data/cache/hupo-rec-1.m4a');
      expect(clip.ms, 3400);
      expect(clip.ok, true);
      // 空的那一段（`ok:false`）⇒ null（界面据此说"这一段里什么都没有"）
      fake.stopReply = {'ok': false};
      expect(await recordStop(), isNull);
      // 坏回执也不许抛（宁可当"没录到"）
      fake.stopReply = {'ok': true, 'path': '', 'ms': 0};
      expect(await recordStop(), isNull);
    });

    test('🔴 放音：放完了那一下要**收得到**（按钮回到"听一遍"）', () async {
      installNativeRecorder();
      var ended = 0;
      play('/data/cache/x.m4a', () => ended += 1);
      await Future<void>.delayed(Duration.zero); // 让 play 那条 invoke 跑完
      expect(fake.calls, contains('play'));
      expect(fake.args.last, {'path': '/data/cache/x.m4a'});
      expect(ended, 0, reason: '起点：还在放');
      await firePlayEnded();
      expect(ended, 1, reason: '★ Kotlin 那边放完了 ⇒ 我们这一侧要收得到');
    });

    test('🔴 放不起来 ⇒ **当场收场**（不许停在"别放了"上）', () async {
      installNativeRecorder();
      fake.playOk = false;
      var ended = 0;
      play('/data/cache/x.m4a', () => ended += 1);
      await Future<void>.delayed(Duration.zero);
      expect(ended, 1, reason: '★ 这条正是 2026-09-27 在网页上栽过的那个形状');
    });

    test('★ 别放了 / 走开：都打到 channel 上（把麦关掉、把声音停掉）', () async {
      installNativeRecorder();
      stopPlay();
      releaseAll();
      expect(fake.calls, containsAll(<String>['stopPlay', 'releaseAll']));
    });
  });

  group('装钩子的那一行只在 Android 上（源码级）', () {
    test('🔴 装钩子那一行在 `main.dart`、而且只在 Android', () {
      // ⚠️ **位置是判据的一部分**（2026-09-28 被楼层闸抓过一次）：`widgets/` 不许指向 `services/`
      //    ⇒ 录音那一句只能住在 `main.dart`（`main` 那一层谁都能指）。
      final main = File('lib/main.dart').readAsStringSync();
      expect(main.contains('installNativeRecorder()'), isTrue,
          reason: '★ 装了才有原生录音 —— 少了这一句，安卓上就还是"这里录不了"');
      expect(main.contains('defaultTargetPlatform == TargetPlatform.android'), isTrue,
          reason: '★ 装之前必须有那道平台判断（iOS / 桌面那一档不装）');
      final io = File('lib/widgets/mini_native_boot_io.dart').readAsStringSync();
      expect(io.contains('installNativeRecorder'), isFalse,
          reason: '★ 别把它塞回 widgets 层（那会违楼层闸：widgets 不许指 services）');
      final stub = File('lib/widgets/mini_native_boot_stub.dart').readAsStringSync();
      expect(stub.contains('recorder'), isFalse,
          reason: '★ Web 那一份是空操作：不许把这条 channel 带到网页那条编译链里');
      // 负向对照：那条 channel 的名字两边必须**逐字一致**
      final kt = File('android/app/src/main/kotlin/chat/hupo/hupo_app/MainActivity.kt').readAsStringSync();
      expect(kt.contains('"hupo/recorder"'), isTrue);
      expect(File('lib/services/recorder_native.dart').readAsStringSync().contains("'hupo/recorder'"), isTrue);
    });
  });
}
