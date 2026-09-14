// iOS / Android：没有页面可刷。
//
// 对应动作由上层做：重连 WebSocket、重新拉一次版本。
// 护栏在原生端没有意义（不会自己刷自己），所以直接返回 null。

void reloadClient({String? buildId}) {}

String? reloadGuardRead() => null;
