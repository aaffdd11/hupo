// **「连上之前先把音频攒着」那一格**（契约 `docs/dev/199-ASR-HEAD.md`）。
//
// 🔴 主人 2026-10-06 报的：*"我说话以后，没有直接显示语音转换文字，响应很慢，
//   然后真正出现的时候，前面的几个字可能会不见。"*
// 根子之一：客户端**先等那条连接握上手，再开麦** —— 而"握上手"冷启那一下
// 真量到 **4.4 秒**（热 10~25ms）⇒ 那几秒里他说的字**采都没采**。
// ⇒ 现在按下去就开麦，音频先在**本机**攒着，握上手按顺序补发。
//
// 这一份钉四件（每件都带反例）：
//   ① 还没连上 ⇒ **一包都不丢**（攒着，不是扔掉、也不是先撞 send）；
//   ② 握上手 ⇒ 按**原来的顺序**一次交出来（音频是连着说的话，颠一包就是颠一句）；
//   ③ 握上手之后 ⇒ 来一包交一包（不再攒）；
//   ④ 收干净 ⇒ 报得出"这一次没送出去多少字节"（丢了多少必须能说出来）。

import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/asr_outbox.dart';

Uint8List _pcm(int n, int seed) =>
    Uint8List.fromList(List<int>.generate(n, (i) => (i + seed) % 251));

void main() {
  test('① 🔴 还没连上 ⇒ 攒着（一包都不丢，也一包都不发）', () {
    final box = AsrOutbox();
    expect(box.isOpen, isFalse);
    final a = _pcm(3200, 0);
    final b = _pcm(3200, 7);
    expect(box.add(a), isEmpty, reason: '★ 还没握上手就交出去了 —— 那几包会撞在 send 上');
    expect(box.add(b), isEmpty);
    expect(box.pendingChunks, 2, reason: '★ 攒着的包数不对（丢包就是丢他开头说的话）');
    expect(box.pendingBytes, 6400);
  });

  test('② 🔴 握上手 ⇒ 按**原来的顺序**一次交出来', () {
    final box = AsrOutbox();
    final a = _pcm(3200, 1);
    final b = _pcm(1600, 2);
    final c = _pcm(640, 3);
    box.add(a);
    box.add(b);
    box.add(c);
    final out = box.open();
    expect(out.length, 3);
    expect(out[0], same(a), reason: '★ 顺序变了 —— 音频颠一包就是颠一句');
    expect(out[1], same(b));
    expect(out[2], same(c));
    expect(box.isOpen, isTrue);
    expect(box.pendingBytes, 0, reason: '★ 交出去之后不该还记着');
    expect(box.open(), isEmpty, reason: '★ 第二次 open 不许把同一批再发一遍（那就重复了）');
  });

  test('③ 握上手之后 ⇒ 来一包交一包（不再攒）', () {
    final box = AsrOutbox();
    box.open();
    final a = _pcm(3200, 4);
    expect(box.add(a).single, same(a));
    expect(box.pendingChunks, 0);
    expect(box.pendingBytes, 0);
  });

  test('④ 收干净 ⇒ 报得出没送出去的字节数', () {
    final box = AsrOutbox();
    box.add(_pcm(3200, 5));
    box.add(_pcm(3200, 6));
    expect(box.clear(), 6400, reason: '★ "丢了多少"必须说出来（不许悄悄咽掉）');
    expect(box.pendingBytes, 0);
    expect(box.pendingChunks, 0);
    expect(box.add(_pcm(10, 7)), isEmpty, reason: '★ 清过之后还当没连上（那份连接已经不要了）');
  });

  test('★ 负向对照：空包不算数据（不然"攒了多少"会被空包撑大）', () {
    final box = AsrOutbox();
    expect(box.add(Uint8List(0)), isEmpty);
    expect(box.pendingBytes, 0);
    expect(box.pendingChunks, 0);
    expect(box.open(), isEmpty);
  });

  test('★ 负向对照：把"攒着"改成"扔掉" ⇒ 读数就是 0（上面那条判据抓的正是这个数）', () {
    final chunk = _pcm(3200, 8);
    final good = AsrOutbox()..add(chunk);
    final bad = _DroppingOutbox()..add(chunk);
    expect(good.pendingBytes, 3200, reason: '真实现的读数');
    expect(bad.pendingBytes, 0,
        reason: '★ 一个"来了就扔"的实现读出来是 0 —— 判据量的就是这个数，所以它抓得住');
  });
}

/// 故意写坏的对照实现（**只在判据里**）：来了就扔，不攒。
class _DroppingOutbox extends AsrOutbox {
  @override
  List<Uint8List> add(Uint8List chunk) => const <Uint8List>[];
}
