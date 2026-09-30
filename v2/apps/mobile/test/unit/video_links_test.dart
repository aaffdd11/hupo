// **从回话里认出"视频地址"**（2026-10-01 · 视频那一样）。
//
// 钉四件：
//   ① 🔴 **只认 http(s)**（`javascript:` / `data:` / `file:` 一律不当成视频地址）；
//   ② 后缀与查询串两档都认；**图片那一套后缀不许混进来**（.png 不是视频）；
//   ③ 尾巴上的中文标点要去掉（不然地址会带一个"。"⇒ 点开是坏的）；
//   ④ 🔴 **整行就是地址 ⇒ 正文是空的**（别把长地址当正文画在播放框上面）。

import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/models/video_links.dart';

void main() {
  test('认得出常见的视频地址（后缀 / 查询串两档）', () {
    expect(videoUrlsIn('视频做好了：https://ark.example/a/v.mp4'), ['https://ark.example/a/v.mp4']);
    expect(videoUrlsIn('https://x/y.webm?x=1'), ['https://x/y.webm?x=1']);
    expect(videoUrlsIn('https://x/y?format=mp4'), ['https://x/y?format=mp4']);
    expect(videoUrlsIn('https://x/y?type=video/mp4'), ['https://x/y?type=video/mp4']);
    // 去重
    expect(videoUrlsIn('https://a/b.mp4 和 https://a/b.mp4'), ['https://a/b.mp4']);
  });

  test('🔴 不该认的一个都不认（图片、别的协议、普通网址）', () {
    expect(videoUrlsIn('https://x/y.png'), isEmpty, reason: '★ 图片那一套后缀不算视频');
    expect(videoUrlsIn('javascript:alert(1)'), isEmpty);
    expect(videoUrlsIn('data:video/mp4;base64,AAAA'), isEmpty);
    expect(videoUrlsIn('file:///etc/passwd'), isEmpty);
    expect(videoUrlsIn('https://x/y'), isEmpty, reason: '认不出后缀就不画框（不许猜）');
    expect(videoUrlsIn(''), isEmpty);
  });

  test('尾巴上的中文标点要去掉', () {
    expect(videoUrlsIn('看这个 https://x/y.mp4。'), ['https://x/y.mp4']);
    expect(videoUrlsIn('（https://x/y.mp4）'), ['https://x/y.mp4']);
  });

  test('🔴 整行就是地址 ⇒ 正文是空的；句子里的地址留着', () {
    expect(textWithoutVideoLines('视频做好了：\nhttps://x/y.mp4'), '视频做好了：');
    expect(textWithoutVideoLines('https://x/y.mp4'), '');
    expect(textWithoutVideoLines('我给你看 https://x/y.mp4 这一段'), '我给你看 https://x/y.mp4 这一段',
        reason: '句子里的地址是他话的一部分，抹掉就改了他说的话');
  });
}
