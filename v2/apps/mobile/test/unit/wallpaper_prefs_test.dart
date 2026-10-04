// **壁纸"跟着账号走"那一条纯逻辑**（主人 2026-10-04 定 · 契约 `docs/dev/183`）。
//
// 这一份只量 `models/wallpaper.dart` 里那两个纯函数：
//   · `WallpaperRemote` —— 服务端那一份回答（`null` = **账号里没记录**，与 `''` 是两件事）；
//   · `resolveWallpaper` —— 账号那一份 ＋ 本机这一份 ⇒ 该铺哪一张、要不要往上顶。
//
// 🔴 这里钉的是**三条规矩**（多一条都不许加）：
//     ① 没问上 ⇒ 本机照旧（**什么都不写**）；
//     ② 账号里没记录 ⇒ 本机有就往上顶（老用户升级上来的第一下）；
//     ③ 账号里有记录（含 `''` = 明确不设）⇒ 听账号的。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/wallpaper.dart';

void main() {
  test('① 没问上（网络不通）⇒ 本机这一份照旧，而且**不往上顶**', () {
    final a = resolveWallpaper(remote: null, local: 'wp-03');
    expect(a.value, 'wp-03');
    expect(a.pushUp, isFalse, reason: '★ 网不通 ≠ 他改了：不许拿本机那份去盖账号');

    final b = resolveWallpaper(remote: null, local: '');
    expect(b.value, wallpaperNone);
    expect(b.pushUp, isFalse);
  });

  test('② 账号里**没记录** ⇒ 本机有就往上顶；本机也没有 ⇒ 不设、不写', () {
    final a = resolveWallpaper(remote: const WallpaperRemote(null), local: 'wp-07');
    expect(a.value, 'wp-07', reason: '★ 他在这台设备上挑过的那张不许被"没记录"抹成默认');
    expect(a.pushUp, isTrue, reason: '★ 要写进账号（别的设备才跟得上）');

    final b = resolveWallpaper(remote: const WallpaperRemote(null), local: '');
    expect(b.value, wallpaperNone);
    expect(b.pushUp, isFalse, reason: '★ 本机也是空的 ⇒ 没什么可顶，别白写一次');
  });

  test('③ 账号里有记录 ⇒ **听账号的**（`\'\'` = 他明确不设，也照听）', () {
    final a = resolveWallpaper(remote: const WallpaperRemote('wp-01'), local: 'wp-03');
    expect(a.value, 'wp-01', reason: '★ 这就是"跟着账号走"：跟本机不一样时以账号为准');
    expect(a.pushUp, isFalse);

    final b = resolveWallpaper(remote: const WallpaperRemote('wp-01'), local: '');
    expect(b.value, 'wp-01', reason: '★ 这台新设备没挑过 ⇒ 也要铺账号那一张');

    final c = resolveWallpaper(remote: const WallpaperRemote(''), local: 'wp-03');
    expect(c.value, wallpaperNone, reason: '★ 他明确选了"不设" ⇒ 压过本机那张');
    expect(c.pushUp, isFalse, reason: '★ 不许拿本机那张去顶他那句"不设"');
  });

  test('两边都可能存着**认不出来的值** ⇒ 一律回不设（偏好读坏了不许让桌面打不开）', () {
    expect(resolveWallpaper(remote: const WallpaperRemote('wp-99'), local: 'wp-03').value, wallpaperNone,
        reason: '★ 账号里那个 id 认不出来 ⇒ 回默认，而且**不许**退回本机那张（那会让两台设备不一样）');
    expect(resolveWallpaper(remote: null, local: '不是壁纸').value, wallpaperNone);
    expect(resolveWallpaper(remote: const WallpaperRemote(null), local: 'wp-99').pushUp, isFalse,
        reason: '★ 本机这份认不出来 ⇒ 没什么可顶的');
  });
}
