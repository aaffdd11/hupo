// **桌面图标 ⇒ 从桌面上删掉** 画到屏幕上之后长什么样
// （契约 `docs/dev/103-APP-DELETE.md` §一 / §四 判据 C1、C2、C6）。
//
// ⚠️ 这一份是**提示档**（`test/widget` 的通用规矩），但它是"这件事到底有没有画到
//    屏幕上"的唯一自动化证据 ⇒ 别删。
//    · 措辞那两条（C3 / C4）在 `test/unit/desktop_remove_test.dart`（硬闸）；
//    · 五档不溢出 + 命中区 ≥44（C5）在 `test/widget/accessibility_test.dart`（硬闸）。
//
// 🔴 两条手势**都要有**（C1 的反例就是"只有长按、右键没反应"）：
//    长按 = 手机 / web；右键 = 桌面端。两条走**同一个面板**。

import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/models/desktop_words.dart';
import 'package:hupo_app/screens/chat_screen.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';
import 'package:hupo_app/widgets/desktop_icon_menu.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _appId = 'dice';
const _appTitle = '掷骰子';
/// 桌上**第二格**（只在 C6·补 那一条里用得起：判据要能分清
/// "少了一个" 和 "整桌被清空"）。
const _appId2 = 'timer';
const _appTitle2 = '番茄钟';

/// 假回执。⚠️ **必须带 `charset=utf-8`**（正文里有中文）；真服务端也带。
http.Response _json(String body, [int status = 200]) => http.Response(
      body,
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

/// 一份假服务端（不开端口、不碰真网）：
///   · `/api/apps` 给**一条**"我的小程序"（`removed` 之后变成空的）；
///   · `/api/app-remove` 按 [removeStatus] 答，并**记下**请求体（判据要查那个 id）。
class _Fake {
  _Fake({
    this.removeStatus = 200,
    this.removeBody = '{"ok":true}',
    this.withSecondApp = false,
    this.appsFailFrom,
  });

  final int removeStatus;
  final String removeBody;

  /// 桌上再多一格（C6·补：要看得出"只少了一个"）。
  final bool withSecondApp;

  /// 从第几次 `/api/apps` 起**直接失败**（`null` = 一直好）。
  /// 用来钉"删成功、但重拉清单没问上"那一下。
  final int? appsFailFrom;

  /// 服务端把那一格拿走了没有（决定 `/api/apps` 之后还给不给它）。
  bool removed = false;

  /// 拉过几次清单（C6：删成功之后必须**重新拉一遍**）。
  int appsCalls = 0;
  int removeCalls = 0;
  final List<Map<String, dynamic>> removeBodies = [];

  MockClient client() => MockClient((r) async {
        if (r.url.path == '/api/apps') {
          appsCalls += 1;
          // ⚠️ **抖一下**（500）：真服务端会有这一下，客户端必须当真
          if (appsFailFrom != null && appsCalls >= appsFailFrom!) {
            return _json('{"error":"boom"}', 500);
          }
          return _json(jsonEncode({
            'apps': [
              if (!removed)
                {
                  'id': _appId,
                  'title': _appTitle,
                  'icon': 'casino',
                  'version': 1,
                  'entryUrl': 'https://apps.example/dice/index.html?sig=x',
                  'expiresAt': 0,
                },
              if (withSecondApp)
                {
                  'id': _appId2,
                  'title': _appTitle2,
                  'icon': 'timer',
                  'version': 1,
                  'entryUrl': 'https://apps.example/timer/index.html?sig=y',
                  'expiresAt': 0,
                },
            ],
          }));
        }
        if (r.url.path == '/api/app-remove') {
          removeCalls += 1;
          removeBodies.add(jsonDecode(r.body) as Map<String, dynamic>);
          if (removeStatus == 200) removed = true;
          return _json(removeBody, removeStatus);
        }
        return _json('{}');
      });
}

ChatController _controller(_Fake fake) => ChatController(
      api: Api(client: fake.client()),
      tokens: TokenStore(),
      token: 'tok',
    );

/// ⚠️ **不传 `initialTier`（默认收起）= 真实路径**：桌面图标露着，长按 / 右键
///    才落得到它上面（传 `full` 的话浮窗把桌面盖住了）。
Future<void> _pump(WidgetTester tester, ChatController c) async {
  await tester.pumpWidget(
    MaterialApp(home: ChatScreen(controller: c, onLoggedOut: () {})),
  );
  await tester.pumpAndSettle(); // 等 `/api/apps` 回来，桌面才长出那一格
  // 负向对照：**那一格真的画出来了**才算数（没画出来的话这几条扫的是别的屏）
  expect(find.text(_appTitle), findsOneWidget, reason: '★ 桌上那一格没长出来 ⇒ 判据扫错了屏');
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  // ── C1：两条手势都要有 ──────────────────────────────────────

  testWidgets('C1：**长按**桌面图标 ⇒ 出那个面板（从桌面上删掉 / 取消）', (tester) async {
    final fake = _Fake();
    await _pump(tester, _controller(fake));

    await tester.longPress(find.text(_appTitle));
    await tester.pumpAndSettle();

    expect(find.byType(DesktopIconMenu), findsOneWidget, reason: '★ 长按没出面板');
    expect(find.text(desktopRemoveAction), findsOneWidget);
    expect(find.text(desktopRemoveCancel), findsOneWidget);
    expect(fake.removeCalls, 0, reason: '只是打开面板 ⇒ 一个请求都不许发');
  });

  testWidgets('C1：**右键**（onSecondaryTap）桌面图标 ⇒ 出**同一个**面板', (tester) async {
    final fake = _Fake();
    await _pump(tester, _controller(fake));

    // ⚠️ 这才是真的右键：**次键**按下抬起（不是"又一个长按"）
    await tester.tap(find.text(_appTitle), buttons: kSecondaryButton);
    await tester.pumpAndSettle();

    expect(find.byType(DesktopIconMenu), findsOneWidget, reason: '★ 右键没反应（C1 的反例）');
    expect(find.text(desktopRemoveAction), findsOneWidget);
    expect(find.text(desktopRemoveCancel), findsOneWidget);
    expect(fake.removeCalls, 0, reason: '只是打开面板 ⇒ 一个请求都不许发');
  });

  // ── C2：那个动作 / 取消 ─────────────────────────────────────

  testWidgets('C2 + C6：点【从桌面上删掉】⇒ 带**那个 id** 发请求；成了之后重拉清单、那一格没了',
      (tester) async {
    final fake = _Fake();
    await _pump(tester, _controller(fake));

    await tester.longPress(find.text(_appTitle));
    await tester.pumpAndSettle();
    await tester.tap(find.text(desktopRemoveAction));
    await tester.pumpAndSettle();

    expect(fake.removeCalls, 1, reason: '选了"从桌面上删掉"就必须发那一条请求');
    expect(
      fake.removeBodies.single['id'],
      _appId,
      reason: '★ 必须带**服务端那一份的 id**（不是界面上带前缀那串、也不是空）',
    );
    expect(
      fake.appsCalls,
      greaterThanOrEqualTo(2),
      reason: '★ 删成功之后必须**重新拉一遍** `/api/apps`（不是只把本地那一项抹掉）',
    );
    expect(find.text(_appTitle), findsNothing, reason: '清单真的少了一个 ⇒ 屏幕上那一格没了');
    expect(find.text(desktopRemoveDone), findsOneWidget, reason: '成了也要如实说一句');
  });

  testWidgets('C2：点【取消】⇒ 什么都不发，面板关掉，那一格还在', (tester) async {
    final fake = _Fake();
    await _pump(tester, _controller(fake));

    await tester.longPress(find.text(_appTitle));
    await tester.pumpAndSettle();
    await tester.tap(find.text(desktopRemoveCancel));
    await tester.pumpAndSettle();

    expect(fake.removeCalls, 0, reason: '★ 取消就什么都不发');
    expect(fake.appsCalls, 1, reason: '取消不许顺手重拉清单（什么都没发生）');
    expect(find.byType(DesktopIconMenu), findsNothing, reason: '面板要关掉');
    expect(find.text(_appTitle), findsOneWidget, reason: '取消 ⇒ 那一格还在');
  });

  // ── C6：失败必须**如实说**，而且不许动那一格 ─────────────────

  testWidgets('C6：服务端没成（500）⇒ 如实说一句，图标**留在原地**', (tester) async {
    final fake = _Fake(removeStatus: 500, removeBody: '{"error":"boom","text":"没成"}');
    await _pump(tester, _controller(fake));

    await tester.longPress(find.text(_appTitle));
    await tester.pumpAndSettle();
    await tester.tap(find.text(desktopRemoveAction));
    await tester.pumpAndSettle();

    expect(fake.removeCalls, 1);
    expect(find.text(desktopRemoveFailed), findsOneWidget, reason: '★ 没成必须如实说一句人话');
    expect(
      find.text(_appTitle),
      findsOneWidget,
      reason: '★ 服务端没删掉 ⇒ 界面上那一格一个像素都不许动（"先删了再说"就是假话）',
    );
    expect(fake.appsCalls, 1, reason: '失败了什么都没发生 ⇒ 不许重拉清单');
  });

  testWidgets('C6：回执是 200 但**没明说 ok** ⇒ 也算没成（不许自己当成功）', (tester) async {
    // ⚠️ 这一条钉的是"客户端不许自己假装成功"：200 + `{}` 不是"删掉了"。
    final fake = _Fake(removeBody: '{}');
    await _pump(tester, _controller(fake));

    await tester.longPress(find.text(_appTitle));
    await tester.pumpAndSettle();
    await tester.tap(find.text(desktopRemoveAction));
    await tester.pumpAndSettle();

    expect(find.text(desktopRemoveFailed), findsOneWidget);
    expect(find.text(_appTitle), findsOneWidget, reason: '没明说成了 ⇒ 那一格不许消失');
  });

  // ── C6·补：删成功、**重拉清单却失败** ⇒ 只少那一个，不许整桌清空 ─────────

  testWidgets('C6·补：删成功但**重拉清单没问上** ⇒ 桌上只少那一个，别的一个都不许跟着消失',
      (tester) async {
    // ⚠️ 这一条钉的是客户端自己那段收尾：`/api/apps` 没答上来时，那个
    //    「没问上」**不许**被当成「空清单」覆盖上去 —— 服务端抖一下，用户的整桌
    //    图标全没了，而他什么也没做（主人报的那类"东西自己不见了"）。
    final fake = _Fake(withSecondApp: true, appsFailFrom: 2);
    await _pump(tester, _controller(fake));
    expect(find.text(_appTitle2), findsOneWidget, reason: '★ 夹具没摆好：第二格要在桌上');

    await tester.longPress(find.text(_appTitle));
    await tester.pumpAndSettle();
    await tester.tap(find.text(desktopRemoveAction));
    await tester.pumpAndSettle();

    expect(fake.removeCalls, 1);
    expect(fake.appsCalls, greaterThanOrEqualTo(2), reason: '重拉过（只是这一次没答上来）');
    expect(find.text(_appTitle), findsNothing, reason: '服务端**确认**过删了 ⇒ 那一格才走');
    expect(find.text(desktopRemoveDone), findsOneWidget, reason: '删那一步是真成了 ⇒ 照样如实说');
    expect(
      find.text(_appTitle2),
      findsOneWidget,
      reason: '★ 反例就是"重拉失败 ⇒ 整桌被清空"：**别的小程序一个都不许跟着消失**',
    );
  });
}
