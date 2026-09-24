// **从一段话里认出图片地址**（P1-27 后半）。
//
// 守的几条：
//   ① 认得出才画（后缀 / `format=` / `data:image`）——认不出**一个字都不动**
//   ② 🔴 **危险形状绝不认**（`javascript:` 那类）
//   ③ 中文句子里粘着的标点要去掉
//   ④ 整行都是地址的那种行**不重复显示**（图就在下面）；句子里的地址**留着**

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/image_links.dart';

void main() {
  test('① 三种认得出：后缀 / `format=` / `data:image`', () {
    expect(imageUrlsIn('画好了 https://x.example/a.png'), ['https://x.example/a.png']);
    expect(imageUrlsIn('https://x.example/b.JPEG'), ['https://x.example/b.JPEG']);
    expect(imageUrlsIn('https://x.example/c?format=png&x=1'), ['https://x.example/c?format=png&x=1']);
    expect(imageUrlsIn('data:image/png;base64,AAAA'), ['data:image/png;base64,AAAA']);
  });

  test('① 负向对照：**不是图片的地址一个都不认**（不许猜着画）', () {
    expect(imageUrlsIn('看这个 https://x.example/page'), isEmpty);
    expect(imageUrlsIn('看这个 https://w.stalkerai.cn/api/space'), isEmpty);
    expect(imageUrlsIn('没有地址'), isEmpty);
    expect(imageUrlsIn(''), isEmpty);
    // 🔴 危险形状：绝不认（也不许进 `Image.network`）
    expect(imageUrlsIn('javascript:alert(1).png'), isEmpty);
    expect(imageUrlsIn('data:text/html;base64,AAAA'), isEmpty);
  });

  test('③ 中文句子粘着的标点要去掉；同一个地址只留一次', () {
    expect(imageUrlsIn('画好了：https://x.example/a.png。'), ['https://x.example/a.png']);
    expect(imageUrlsIn('https://x.example/a.png（这个是临时的）'), ['https://x.example/a.png']);
    expect(imageUrlsIn('https://x.example/a.png https://x.example/a.png'), ['https://x.example/a.png']);
  });

  test('④ 整行就是地址 ⇒ 不重复显示；句子里的地址 ⇒ 留着', () {
    // 整行：去掉（图就在下面）
    expect(textWithoutImageLines('画好了：\n- https://x.example/a.png\n想要就存下来。'), '画好了：\n想要就存下来。');
    // 句子里：留着（那是他话的一部分，抹掉就改了他说的话）
    final kept = textWithoutImageLines('给你这张 https://x.example/a.png 好看吗');
    expect(kept.contains('好看吗'), true);
    expect(kept.contains('https://x.example/a.png'), true);
    // 全是地址（没有别的话）⇒ **不许变成空**（宁可留着）
    expect(textWithoutImageLines('https://x.example/a.png').isNotEmpty, true);
  });
}
