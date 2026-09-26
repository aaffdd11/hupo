// **右栏那几句字**（`lib/models/file_panel_words.dart` · 契约 `docs/dev/120-FILE-PANEL.md`）。
//
// 同 `tool_row_words_test.dart` 的规矩：文案**逐字钉住**，而且**不编数** ——
// 没有钱、没有百分比、没有"改了多少行"（我们根本没有那个数）。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/file_panel_words.dart';

void main() {
  group('filePanelCountLine', () {
    test('★ 逐字：轮数 · 处数', () {
      expect(filePanelCountLine(3, 5), '3 轮 · 5 处');
      expect(filePanelCountLine(0, 0), '0 轮 · 0 处');
      expect(filePanelCountLine(12, 34), '12 轮 · 34 处');
    });

    test('★ 负例：不出现钱 / 百分比 / 行数那类口径', () {
      final s = filePanelCountLine(3, 5);
      expect(s.contains('%'), isFalse);
      expect(s.contains('¥'), isFalse);
      expect(s.contains(r'$'), isFalse);
      expect(s.contains('行'), isFalse, reason: '我们数不出"改了多少行" —— 那句话不许出现');
      expect(s.contains('字节'), isFalse, reason: '字节只在**真截断**那句里说');
    });
  });

  group('filePanelTurnHead', () {
    test('★ 逐字：第 N 轮', () {
      expect(filePanelTurnHead(1), '第 1 轮');
      expect(filePanelTurnHead(12), '第 12 轮');
    });

    test('★ 分组头右边那一格：只数这一轮几个文件', () {
      expect(filePanelTurnFiles(1), '1 个文件');
      expect(filePanelTurnFiles(3), '3 个文件');
    });
  });

  group('filePanelToolLine', () {
    test('★ 逐字：多个名字用 ` · ` 连（顺序就是传进来的顺序）', () {
      expect(filePanelToolLine(['write']), '被这些工具碰过：write');
      expect(filePanelToolLine(['write', 'edit']), '被这些工具碰过：write · edit');
    });

    test('★ 负例：不排字母、不去重（那是数据那一层的规矩，这里只拼字）', () {
      expect(filePanelToolLine(['edit', 'write']), '被这些工具碰过：edit · write');
    });
  });

  group('截断那句实话', () {
    test('★ 用词与 `toolTruncatedLine` 同一套（同一件事同一句话）', () {
      expect(filePanelArgsTruncatedLine(2000), '… 已截断，共 2000 字节');
    });

    test('★ 它只说服务端给的那个数（不四舍五入、不换算）', () {
      expect(filePanelArgsTruncatedLine(1234567), '… 已截断，共 1234567 字节');
      expect(filePanelArgsTruncatedLine(0), '… 已截断，共 0 字节');
    });
  });

  group('其余那几句（逐字）', () {
    test('★ 抬头 / 按钮 / 口径 / 空态 / 展开', () {
      expect(filePanelTitle, '这一窗动过哪些文件');
      expect(filePanelOpenLabel, '打开右侧边栏');
      expect(filePanelCloseLabel, '收起这一栏');
      expect(filePanelOrderLine, '最近改的在上，只算这一窗已经摊开的这些轮');
      expect(filePanelEmptyLine, '这一窗里还没有改过文件。');
      expect(filePanelArgsHead, '那一次的入参原文');
      expect(filePanelRowExpandLabel, '看那次调用的入参');
      expect(filePanelRowCollapseLabel, '收起这一段');
    });

    test('★ 负例：这几句一个禁用词都不许有（`工具` 那句**故意不在此列**）', () {
      // ⚠️ `filePanelToolLine` 里那个「工具」**就是** `forbidden_words.dart` 表里的词
      //    —— 主人 2026-09-26 已在聊天窗口内放开（`D1.1·补`），而词表这一批不许改
      //    （同 `toolStatusWord` / `trajectoryKindWord` 的处境，见文件头那段）。
      //    ⇒ 这里只扫**其余**那几句。
      for (final s in [
        filePanelTitle,
        filePanelOpenLabel,
        filePanelCloseLabel,
        filePanelOrderLine,
        filePanelEmptyLine,
        filePanelArgsHead,
        filePanelRowExpandLabel,
        filePanelRowCollapseLabel,
        filePanelCountLine(3, 5),
        filePanelTurnHead(3),
        filePanelTurnFiles(2),
        filePanelArgsTruncatedLine(2000),
      ]) {
        for (final bad in ['工作区', '会话', '客户端', '云端', '口令', '时间线']) {
          expect(s.contains(bad), isFalse, reason: '「$s」里不该有「$bad」');
        }
      }
    });
  });
}
