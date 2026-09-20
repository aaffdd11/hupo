// 四态转移 —— 手册 `08-SPEC.md` §4.1、`05-DECISIONS.md` §3.1。
//
// 这一条的由来：旧实现只有一个 `pending` bool，于是
// **失败与成功长得一模一样**。09 的原话：
// "界面把'发不出去'显示成'发出去了'" —— 那是 8/10 放弃点里最狠的一条。
//
// 纯逻辑，不需要 pump ⇒ 进硬闸（手册 §6.2：界面一重构，纯函数不受影响）。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/message_state.dart';

void main() {
  test('正常路径：queued → sent → confirmed', () {
    var s = MessageState.queued;
    s = nextState(s, MessageState.sent);
    expect(s, MessageState.sent);
    s = nextState(s, MessageState.confirmed);
    expect(s, MessageState.confirmed);
  });

  test('任何一步都可能直接失败', () {
    expect(nextState(MessageState.queued, MessageState.failed), MessageState.failed);
    expect(nextState(MessageState.sent, MessageState.failed), MessageState.failed);
  });

  test('★ confirmed 是终态：回执到了就不许再改回失败', () {
    // 改了会怎样：用户看到"没发出去"→ 重发 → 而服务端**已经收过了**
    expect(nextState(MessageState.confirmed, MessageState.failed), MessageState.confirmed);
    expect(nextState(MessageState.confirmed, MessageState.queued), MessageState.confirmed);
  });

  test('failed 只能被"重发"推回 queued', () {
    expect(nextState(MessageState.failed, MessageState.queued), MessageState.queued);
    expect(nextState(MessageState.failed, MessageState.confirmed), MessageState.failed);
  });

  test('★ 乱序到达不许把状态弄乱（不允许的转移一律原样返回，不抛）', () {
    // 补发段/迟到响应可能把旧状态晚一步送回来
    expect(nextState(MessageState.confirmed, MessageState.sent), MessageState.confirmed);
    expect(nextState(MessageState.confirmed, MessageState.queued), MessageState.confirmed);
    expect(nextState(MessageState.failed, MessageState.sent), MessageState.failed);
  });

  test('★ 回执可能比 HTTP 响应先到 ⇒ queued 要能直接到 confirmed', () {
    // （这条本来是被禁掉的，测试抓出来了：禁掉之后回执先到时状态会卡在 queued，
    //   而 reset() 又会把这条**已经确认过**的话当成"本地未确认"留着。）
    expect(nextState(MessageState.queued, MessageState.confirmed), MessageState.confirmed);
  });

  test('四态都有各自的人话，且互不相同（不能两种状态一个词）', () {
    final labels = MessageState.values.map(stateLabel).toSet();
    expect(labels.length, 4, reason: '两种状态共用一个词 = 用户分不出来');
    expect(labels.every((l) => l.isNotEmpty), true);
  });

  test('pending / settled 的判断对得上', () {
    expect(isPending(MessageState.queued), true);
    expect(isPending(MessageState.sent), true);
    expect(isPending(MessageState.confirmed), false);
    expect(isSettled(MessageState.confirmed), true);
    expect(isSettled(MessageState.failed), true);
  });
}
