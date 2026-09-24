// **从一段话里认出"图片地址"**（P1-27 后半 · 主人 2026-09-24："图片需要打通"）。
//
// 为什么要有它：画好的图是**以地址的形式**回到回话里的（上游给的就是地址），
// 而回话在屏幕上是一段文字。要让**图真的看得见**，就得先把地址认出来。
//
// ⚠️ **纯函数**（`test/unit` 里钉）：认得出才画，认不出就一个字都不动
//    —— 不许"猜着画"（把一段普通网址当图片去取 = 屏幕上多一块空白）。
//
// 认得出的三种：
//   ① 以图片后缀结尾（`.png` / `.jpg` / `.jpeg` / `.webp` / `.gif` / `.bmp`）；
//   ② 带 `format=`/`type=` 那种**明说是图片**的查询串；
//   ③ `data:image/...` 那种内嵌的。

/// 一份文案里**所有**看起来是图片的地址（按出现顺序，去重）。
List<String> imageUrlsIn(String text) {
  if (text.isEmpty) return const [];
  final out = <String>[];
  // ⚠️ 只扫 http(s) 与 data:image —— 别的（`javascript:` 那类）**绝不**拿去显示
  // ⚠️ **只收"URL 里会出现的字符"**（第一版写宽了：`（这个是临时的）` 那种全角括号
  //    会被吃进地址里 ⇒ 后缀判断失败 ⇒ 图认不出来。判据当场抓住。）
  final re = RegExp(r'(https?://[A-Za-z0-9\-._~:/?#@!$&*+,;=%\[\]]+|data:image/[A-Za-z0-9\-._~:/?#@!$&*+,;=%\[\]]+)');
  for (final m in re.allMatches(text)) {
    final raw = m.group(0)!;
    // 尾巴上粘着的标点（中文句子常见）要去掉
    final url = raw.replaceAll(RegExp(r'[，。；：、！？,.;:!?]+$'), '');
    if (!_looksLikeImage(url)) continue;
    if (!out.contains(url)) out.add(url);
  }
  return out;
}

bool _looksLikeImage(String url) {
  if (url.startsWith('data:image/')) return true;
  final lower = url.toLowerCase();
  final noQuery = lower.split('?').first.split('#').first;
  if (RegExp(r'\.(png|jpe?g|webp|gif|bmp)$').hasMatch(noQuery)) return true;
  // ?format=png / ?type=image/jpeg 这种也认（上游不一定给后缀）
  final query = lower.contains('?') ? lower.split('?').last : '';
  return RegExp(r'(format|type)=(png|jpe?g|webp|gif|image/[-a-z]+)').hasMatch(query);
}

/// 从一段话里**去掉**那些图片地址（用来显示"人话那部分"）。
///
/// ⚠️ 只去掉**认得出的图片地址那一行**（整行都是它的时候）；句子中间的地址**留着** ——
///    因为那多半是他话里的一部分，抹掉就改了他说的话。
String textWithoutImageLines(String text) {
  if (text.isEmpty) return text;
  final keep = <String>[];
  for (final line in text.split('\n')) {
    final t = line.trim();
    if (t.isNotEmpty && imageUrlsIn(t).isNotEmpty && imageUrlsIn(t).first.length >= t.replaceAll(RegExp(r'^[-•*\s]+'), '').length - 1) {
      continue; // 这一行基本就是那个地址 ⇒ 不显示（图就在下面）
    }
    keep.add(line);
  }
  final out = keep.join('\n').trim();
  return out.isEmpty ? text : out;
}
