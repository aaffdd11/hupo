// **「录一段」（录音 ＋ 回放）那几行字与那几档状态**（纯逻辑）·
// 契约 `docs/dev/128-VOICE-RECORD-AND-PLAY.md`。
//
// 🔴 为什么这些要单测：它们是**屏幕上说的那些话**（按钮上写什么、失败说哪一句、
//    "这段是空的"什么时候说）—— 说错一句就是"页面在说假话"，而那正是这个项目最恨的形状。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/hearing_words.dart';
import 'package:hupo_app/models/voice_record.dart';

void main() {
  test('★ 那颗大按钮：只有"正在录"时是停下，其余时候都是"开始录"', () {
    expect(voiceRecButton(RecPhase.idle), voiceRecStart);
    expect(voiceRecButton(RecPhase.ready), voiceRecStart, reason: '手里有一段也照旧能再录一段');
    expect(voiceRecButton(RecPhase.playing), voiceRecStart, reason: '放着的时候按它就是"停掉放音再录"');
    expect(voiceRecButton(RecPhase.recording), voiceRecStop);
  });

  test('★ 回放那颗：手里没东西 ⇒ **不画**（`null`）；有 ⇒ 听一遍 / 别放了', () {
    expect(voiceRecPlayButton(RecPhase.idle, hasClip: false), isNull);
    expect(voiceRecPlayButton(RecPhase.ready, hasClip: false), isNull);
    expect(voiceRecPlayButton(RecPhase.ready, hasClip: true), voiceRecPlay);
    expect(voiceRecPlayButton(RecPhase.playing, hasClip: true), voiceRecPlayStop);
    expect(voiceRecPlayButton(RecPhase.playing, hasClip: false), isNull, reason: '没东西可放就别摆按钮');
  });

  test('🔴 那一句实话：录不了说"这里录不了"；正在录/正在放时什么都不说', () {
    expect(
      voiceRecNotice(phase: RecPhase.idle, why: '', canRecord: false),
      hearCantHere,
      reason: '★ 与话筒**同一句**（同一个原因不许有两种说法）',
    );
    // 正在录 / 正在放 ⇒ 屏幕上已经有那件事了，别再叠一句话
    expect(voiceRecNotice(phase: RecPhase.recording, why: 'x', canRecord: true), '');
    expect(voiceRecNotice(phase: RecPhase.playing, why: 'x', canRecord: true), '');
    // 其余时候把上一次的原因照原样说出来（空 = 没什么要说的）
    expect(voiceRecNotice(phase: RecPhase.idle, why: voiceRecEmpty, canRecord: true), voiceRecEmpty);
    expect(voiceRecNotice(phase: RecPhase.ready, why: '', canRecord: true), '');
  });

  test('★ 时长那句：只有手里真有东西、而且没在录的时候才说', () {
    expect(voiceRecLengthLine(RecPhase.ready, null), '');
    expect(voiceRecLengthLine(RecPhase.ready, const RecordedClip(url: '', ms: 0)), '',
        reason: '空的那一段不算录到了');
    expect(voiceRecLengthLine(RecPhase.ready, const RecordedClip(url: 'blob:x', ms: 4200)),
        voiceRecLength(4200));
    expect(voiceRecLengthLine(RecPhase.idle, const RecordedClip(url: 'blob:x', ms: 4200)),
        voiceRecLength(4200), reason: '停下之后（idle/ready）都该看得见它多长');
    expect(voiceRecLengthLine(RecPhase.recording, const RecordedClip(url: 'blob:x', ms: 4200)), '',
        reason: '★ 正在录的时候别把上一次那段的时长摆在那儿（那是另一个东西）');
    // 那句人话本身
    expect(voiceRecLength(4200), contains('4.2'), reason: '毫秒 → 一位小数');
    expect(voiceRecLength(0), contains('0.0'));
  });

  test('★ `RecordedClip.ok`：地址与长度都真才算"录到了"', () {
    expect(const RecordedClip(url: 'blob:x', ms: 1200).ok, isTrue);
    expect(const RecordedClip(url: 'blob:x', ms: 0).ok, isFalse);
    expect(const RecordedClip(url: '', ms: 1200).ok, isFalse);
    expect(const RecordedClip(url: '', ms: -1).ok, isFalse);
  });

  test('★ 这一块的几句话：都非空、而且彼此不同（同一件事不许两种说法）', () {
    final all = <String>[
      voiceRecTitle,
      voiceRecHint,
      voiceRecStart,
      voiceRecStop,
      voiceRecPlay,
      voiceRecPlayStop,
      voiceRecEmpty,
    ];
    for (final line in all) {
      expect(line.trim().isEmpty, isFalse, reason: '不许有空话');
    }
    expect(all.toSet().length, all.length, reason: '★ 七句话两两不同');
    // 那句怎么用**必须**说清"只在你这台设备上"（那是这一块与「试一下」的分界）
    expect(voiceRecHint.contains('不发给任何人'), isTrue);
  });
}
