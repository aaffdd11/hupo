// **"这个小程序有新版了"那一帧**（契约 `docs/dev/111-APP-LIVE-UPDATE.md`）。
//
// 服务端那半边的形状住 `v2/services/core/src/app-events.js`（**同一份读法**：
// `appUpdateOf()` 与这里的 `AppUpdate.of()` 认的是同一组字段 —— 两边各写一遍
// 就会漂，所以两处都只有几行、而且判据逐条钉着）。
//
// 🔴 **帧里没有签名 URL**（那是短时效的，落盘就是假话）⇒ 客户端拿 `id`
//    **自己去 `/api/apps` 现取**新那一版的 `entryUrl`（既有那条路）。
//
// ⚠️ **纯逻辑，不许 import flutter/material**（楼层闸）。

/// 一帧"有新版了"。
class AppUpdate {
  const AppUpdate({required this.id, required this.version});

  /// 哪一个（制品库里那个 id，也就是那一间的名字）。
  final String id;

  /// 新那一版的版本号。
  final int version;

  /// 认一帧是不是它；认不出 ⇒ `null`（**安静忽略**：协议只加不改）。
  static AppUpdate? of(Map<String, dynamic> event) {
    if (event['type'] != 'app/update-available') return null;
    final id = event['id'];
    if (id is! String || id.isEmpty) return null;
    final raw = event['version'];
    if (raw is! int) return null;
    if (raw < 1) return null;
    return AppUpdate(id: id, version: raw);
  }

  @override
  bool operator ==(Object other) =>
      other is AppUpdate && other.id == id && other.version == version;

  @override
  int get hashCode => Object.hash(id, version);

  @override
  String toString() => 'AppUpdate($id, v$version)';
}

/// ★ **"那一间的内容变了"**（契约 `docs/dev/112-OWN-APP-IS-LIVE.md`）。
///
/// 与 [AppUpdate] **刻意是两个类**（别合并成一个）：
///   · [AppUpdate] = "**这个 app 有某一版新的**"（**持久**、带版本号、走制品那一侧）；
///   · 这一个   = "**他正在改的那一份刚被写过**"（**瞬态**、**没有版本号** ——
///     用户端没有"版本"这回事：他自己那一份就是源代码部署）。
///
/// 🔴 **帧里只有 `id`**：没有签名 URL（短时效）、没有内容、没有版本号 ——
///    它只是"**你现在开着的那一页该重取一次**"这个信号。
/// ⚠️ **纯逻辑，不许 import flutter/material**（楼层闸）。
class AppWorkspaceChange {
  const AppWorkspaceChange({required this.id});

  /// 哪一间（那个 app 的 id，也就是那一间工作区的名字）。
  final String id;

  /// 认一帧是不是它；认不出 ⇒ `null`（**安静忽略**：协议只加不改）。
  static AppWorkspaceChange? of(Map<String, dynamic> event) {
    if (event['type'] != 'app/workspace-changed') return null;
    final id = event['id'];
    if (id is! String || id.isEmpty) return null;
    return AppWorkspaceChange(id: id);
  }

  @override
  bool operator ==(Object other) => other is AppWorkspaceChange && other.id == id;

  @override
  int get hashCode => id.hashCode;

  @override
  String toString() => 'AppWorkspaceChange($id)';
}
