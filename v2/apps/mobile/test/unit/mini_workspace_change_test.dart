// **"那一间的内容变了"那一帧** 的纯逻辑（契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）。
//
// ── 这一份钉什么 ──────────────────────────────────────────
//   ① 🔴 `AppWorkspaceChange.of`：认得出 ⇒ 给出 id；认不出 ⇒ `null`（**安静忽略**）；
//   ② 🔴 它**不带版本号**（与 `AppUpdate` 是两个类，别合并）—— 用户端没有"版本"这回事；
//   ③ 🔴 **瞬态**：收到它 ⇒ **不许喂给时间线**（喂了会留下一条谁也看不见的东西，
//      重连重放时还会再换一次帧）—— 判据读**游标**（`timeline.lastSeq` 一个数都不动）；
//   ④ 🔴 **与 `app/update-available` 各走各的**：两条互不冒充。
//
// ⚠️ 硬闸在 `scripts/check-client.sh`；界面那一半在
//    `test/widget/mini_workspace_live_test.dart`。

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:hupo_app/models/mini_update.dart';
import 'package:hupo_app/services/api.dart';
import 'package:hupo_app/services/chat_controller.dart';
import 'package:hupo_app/services/token_store.dart';

ChatController _controller() => ChatController(
      api: Api(
        base: '',
        // **不碰真网**：这一条一个请求都不该发（只喂帧）
        client: MockClient((_) async => http.Response('', 404)),
      ),
      tokens: TokenStore(),
      token: '测试令牌',
    );

void main() {
  test('`AppWorkspaceChange.of`：认得出就给出 id，认不出**安静忽略**', () {
    expect(AppWorkspaceChange.of({'type': 'app/workspace-changed', 'id': 'dice'}),
        const AppWorkspaceChange(id: 'dice'));
    for (final bad in <Map<String, dynamic>>[
      {},
      {'type': 'app/installed', 'appId': 'dice'},
      {'type': 'app/update-available', 'id': 'dice', 'version': 2},
      {'type': 'app/workspace-changed'},
      {'type': 'app/workspace-changed', 'id': ''},
      {'type': 'app/workspace-changed', 'id': 7},
    ]) {
      expect(AppWorkspaceChange.of(bad), null, reason: '认不出的该安静忽略：$bad');
    }
  });

  test('两条路**互不冒充**：`AppUpdate.of` 不认那一间变了，反过来也一样', () {
    expect(AppUpdate.of({'type': 'app/workspace-changed', 'id': 'dice'}), null);
    expect(
      AppWorkspaceChange.of({'type': 'app/update-available', 'id': 'dice', 'version': 2}),
      null,
      reason: '★ "有新版"（持久、带版本号）与"内容变了"（瞬态、不带）是两件事',
    );
  });

  test('🔴 收到那一帧 ⇒ 举手一次，而且**一个号都不占**（瞬态，不进时间线）', () {
    final c = _controller();
    final seqBefore = c.timeline.lastSeq;
    final revBefore = c.appWorkspaceRevision;

    c.ingest({'type': 'app/workspace-changed', 'id': 'dice', 'at': 1});

    expect(c.appWorkspaceRevision, revBefore + 1, reason: '★ 界面靠它认"是不是新的一条"');
    expect(c.lastAppWorkspaceChange, const AppWorkspaceChange(id: 'dice'));
    expect(c.timeline.lastSeq, seqBefore, reason: '★ 瞬态事件**不许**喂给时间线（不占号）');

    // 认不出的那一帧 ⇒ 连举手都不举（安静忽略）
    c.ingest({'type': 'app/workspace-changed'});
    expect(c.appWorkspaceRevision, revBefore + 1);
  });

  test('🔴 与 `app/update-available` 各记各的账（两条 revision 不许并成一个）', () {
    final c = _controller();
    c.ingest({'type': 'app/workspace-changed', 'id': 'dice', 'at': 1});
    expect(c.appWorkspaceRevision, 1);
    expect(c.appUpdateRevision, 0, reason: '★ 那一间变了**不是**"有新版"');

    c.ingest({'type': 'app/update-available', 'id': 'dice', 'version': 2, 'at': 2, 'seq': 5});
    expect(c.appUpdateRevision, 1);
    expect(c.appWorkspaceRevision, 1, reason: '★ 反过来也不许串');
  });
}
