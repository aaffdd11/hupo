// **录一段**：别的平台那一份（**如实说录不了**）。
//
// ⚠️ 与 `hearing_stub.dart` / `speech_stub.dart` / `links_stub.dart` 同一条路：
//    非网页平台**不装**（原生录音那一件在 `76-PLAN.md` 的 P1-23，明说没做）。
//    ⇒ 这一份的 `canRecord` **恒假**，而界面**照画那颗按钮**、点下去说一句白话
//      （藏起来等于让他自己猜 —— 同话筒那条，主人 2026-09-23 当场问过）。

import '../models/voice_record.dart';

/// 这里录不了（恒假）。**不是"暂时"**：这一份就是那个事实。
bool get canRecord => false;

Future<String?> recordStart() async => 'unsupported';

Future<RecordedClip?> recordStop() async => null;

void play(String url, void Function() onEnded) => onEnded();

void stopPlay() {}

void releaseAll() {}
