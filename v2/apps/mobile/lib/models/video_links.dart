// **从一段话里认出"视频地址"**（视频那一样 · 主人 2026-10-01：*"视频用seedance"*）。
//
// 为什么要有它：生成好的视频是**以地址的形式**回到回话里的（壳那一侧的巡场
// 把"视频做好了：<地址>"说进那一间），而回话在屏幕上是一段文字。
// 要让视频**能看 / 能点**，就得先把地址认出来。
//
// ⚠️ **纯函数**（`test/unit` 里钉）：认得出才画那个框，认不出就一个字都不动。
// ⚠️ **只认 http(s)**（`javascript:` / `data:` / `file:` 一律不当成视频地址）。
// ⚠️ 与图片那一份**分开**（各认各的）：视频的后缀是 `mp4/mov/webm/m4v`，
//    而"看见一个 .mp4 就当图片去画"是两件不同的事（画不出来，还白占一块地方）。

/// 一份文案里**所有**看起来是视频的地址（按出现顺序，去重）。
List<String> videoUrlsIn(String text) {
  if (text.isEmpty) return const [];
  final out = <String>[];
  final re = RegExp(r'https?://[A-Za-z0-9\-._~:/?#@!$&*+,;=%\[\]]+');
  for (final m in re.allMatches(text)) {
    final raw = m.group(0)!;
    // 尾巴上粘着的标点（中文句子常见）要去掉
    final url = raw.replaceAll(RegExp(r'[，。；：、！？,.;:!?]+$'), '');
    if (!looksLikeVideo(url)) continue;
    if (!out.contains(url)) out.add(url);
  }
  return out;
}

/// 这个地址看着像视频吗（后缀 / 明说是视频的查询串）。
bool looksLikeVideo(String url) {
  final lower = url.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
  final noQuery = lower.split('?').first.split('#').first;
  if (RegExp(r'\.(mp4|mov|webm|m4v|mkv)$').hasMatch(noQuery)) return true;
  final query = lower.contains('?') ? lower.split('?').last : '';
  return RegExp(r'(format|type)=(mp4|video/[-a-z0-9]+)').hasMatch(query);
}

/// 从一段话里**去掉**那些视频地址（用来显示"人话那部分"）。
///
/// ⚠️ 只去掉**认得出的视频地址那一行**（整行基本就是它的时候）；句子中间的留着。
/// 🔴 **全是地址 ⇒ 正文是空的**（同 `image_links.dart` 那条纪律 B37：
///    别把那个长地址当正文画在播放框上方）。
String textWithoutVideoLines(String text) {
  if (text.isEmpty) return text;
  final keep = <String>[];
  for (final line in text.split('\n')) {
    final t = line.trim();
    if (t.isNotEmpty &&
        videoUrlsIn(t).isNotEmpty &&
        videoUrlsIn(t).first.length >= t.replaceAll(RegExp(r'^[-•*\s]+'), '').length - 1) {
      continue;
    }
    keep.add(line);
  }
  return keep.join('\n').trim();
}
