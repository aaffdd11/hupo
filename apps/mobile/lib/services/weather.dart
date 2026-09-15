// 天气：城市、预报模型，以及从 Open-Meteo 取数。
//
// 为什么用 Open-Meteo：免密钥、支持跨域（网页端直接调得到）、有 7 天预报，
// 不用在客户端里塞任何凭证。客户端是哑终端，这里只做"取数 + 解析"。
//
// 解析单独拎成纯函数（parseForecast），不碰网络，这样单测能直接喂 JSON。

import 'dart:convert';

import 'package:http/http.dart' as http;

/// 一个城市。
class City {
  const City({
    required this.name,
    required this.latitude,
    required this.longitude,
    this.admin = '',
    this.pinyin = '',
  });

  final String name;

  /// 归属地，例如「浙江·绍兴」。
  final String admin;

  final double latitude;
  final double longitude;

  /// 拼音/英文，方便用英文键盘搜（内置城市表里带）。
  final String pinyin;

  /// 同一地点只留一个：坐标取三位小数足够区分城市。
  String get id => '${latitude.toStringAsFixed(3)},${longitude.toStringAsFixed(3)}';

  /// 卡片副标题。
  String get subtitle => admin.isEmpty ? name : admin;

  Map<String, dynamic> toJson() => {
        'name': name,
        'admin': admin,
        'pinyin': pinyin,
        'lat': latitude,
        'lon': longitude,
      };

  static City? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final name = raw['name'];
    final lat = raw['lat'];
    final lon = raw['lon'];
    if (name is! String || name.isEmpty || lat is! num || lon is! num) return null;
    return City(
      name: name,
      admin: raw['admin'] is String ? raw['admin'] as String : '',
      pinyin: raw['pinyin'] is String ? raw['pinyin'] as String : '',
      latitude: lat.toDouble(),
      longitude: lon.toDouble(),
    );
  }
}

/// 未来某一天。
class DailyForecast {
  const DailyForecast({
    required this.date,
    required this.weatherCode,
    required this.max,
    required this.min,
    this.precipitationProbability,
  });

  final DateTime date;
  final int weatherCode;
  final double max;
  final double min;

  /// 最大降水概率（百分比），服务端没给就是 null。
  final int? precipitationProbability;
}

/// 一个城市的当前天气 + 未来 7 天。
class WeatherBundle {
  WeatherBundle({
    required this.city,
    required this.days,
    required this.fetchedAt,
    this.temperature,
    this.weatherCode,
    this.humidity,
    this.windSpeed,
  });

  final City city;
  final List<DailyForecast> days;
  final DateTime fetchedAt;

  final double? temperature;
  final int? weatherCode;
  final int? humidity;
  final double? windSpeed;

  /// 今天（预报的第一天）。
  DailyForecast? get today => days.isEmpty ? null : days.first;
}

/// 把 Open-Meteo 的 forecast 响应解析成模型。缺字段就退化成 null / 空，不抛。
WeatherBundle parseForecast(City city, Map<String, dynamic> json, DateTime now) {
  final current = json['current'];
  final daily = json['daily'];

  final days = <DailyForecast>[];
  if (daily is Map) {
    final times = daily['time'];
    final codes = daily['weather_code'];
    final maxes = daily['temperature_2m_max'];
    final mins = daily['temperature_2m_min'];
    final pops = daily['precipitation_probability_max'];
    if (times is List) {
      for (var i = 0; i < times.length; i++) {
        final date = _parseDate(times[i]);
        final max = _at(maxes, i);
        final min = _at(mins, i);
        if (date == null || max == null || min == null) continue;
        final code = _at(codes, i);
        final pop = _at(pops, i);
        days.add(DailyForecast(
          date: date,
          weatherCode: code?.round() ?? 0,
          max: max,
          min: min,
          precipitationProbability: pop?.round(),
        ));
      }
    }
  }

  double? number(Object? v) => v is num ? v.toDouble() : null;

  return WeatherBundle(
    city: city,
    days: days,
    fetchedAt: now,
    temperature: current is Map ? number(current['temperature_2m']) : null,
    weatherCode: current is Map && current['weather_code'] is num
        ? (current['weather_code'] as num).round()
        : null,
    humidity: current is Map && current['relative_humidity_2m'] is num
        ? (current['relative_humidity_2m'] as num).round()
        : null,
    windSpeed: current is Map ? number(current['wind_speed_10m']) : null,
  );
}

double? _at(Object? list, int i) {
  if (list is! List || i >= list.length) return null;
  final v = list[i];
  return v is num ? v.toDouble() : null;
}

DateTime? _parseDate(Object? raw) {
  if (raw is! String) return null;
  return DateTime.tryParse(raw);
}

/// 网络取数。可以在测试里注入假的 http.Client。
class WeatherApi {
  WeatherApi({http.Client? client, this.timeout = const Duration(seconds: 12)})
      : _client = client ?? http.Client();

  static const String forecastEndpoint = 'https://api.open-meteo.com/v1/forecast';
  static const String geocodeEndpoint = 'https://geocoding-api.open-meteo.com/v1/search';

  final http.Client _client;
  final Duration timeout;

  /// 取一个城市的当前天气 + 未来 7 天。
  Future<WeatherBundle> forecast(City city) async {
    final uri = Uri.parse(forecastEndpoint).replace(queryParameters: {
      'latitude': city.latitude.toString(),
      'longitude': city.longitude.toString(),
      'current': 'temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m',
      'daily': 'weather_code,temperature_2m_max,temperature_2m_min,'
          'precipitation_probability_max',
      'timezone': 'auto',
      'forecast_days': '7',
    });
    final res = await _client.get(uri).timeout(timeout);
    if (res.statusCode != 200) {
      throw WeatherException('天气服务回了 ${res.statusCode}');
    }
    final body = jsonDecode(utf8.decode(res.bodyBytes));
    if (body is! Map<String, dynamic>) {
      throw WeatherException('天气服务回的数据看不懂');
    }
    final bundle = parseForecast(city, body, DateTime.now());
    if (bundle.days.isEmpty) {
      throw WeatherException('这个地点没拿到预报');
    }
    return bundle;
  }

  /// 按名字找城市。中文也行（大城市的官方中文名有）。
  Future<List<City>> search(String query) async {
    final q = query.trim();
    if (q.isEmpty) return const [];
    final uri = Uri.parse(geocodeEndpoint).replace(queryParameters: {
      'name': q,
      'count': '8',
      'language': 'zh',
      'format': 'json',
    });
    final http.Response res;
    try {
      res = await _client.get(uri).timeout(timeout);
    } catch (_) {
      return const []; // 查不到就当没结果，别把界面的搜索框炸掉
    }
    if (res.statusCode != 200) return const [];
    final dynamic body;
    try {
      body = jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      return const [];
    }
    if (body is! Map || body['results'] is! List) return const [];
    final out = <City>[];
    for (final raw in body['results'] as List) {
      if (raw is! Map) continue;
      final name = raw['name'];
      final lat = raw['latitude'];
      final lon = raw['longitude'];
      if (name is! String || lat is! num || lon is! num) continue;
      final parts = <String>[
        if (raw['country_code'] == 'CN' && raw['admin1'] is String) raw['admin1'] as String,
        if (raw['admin2'] is String && raw['admin2'] != name) raw['admin2'] as String,
      ];
      out.add(City(
        name: name,
        admin: parts.join('·'),
        latitude: lat.toDouble(),
        longitude: lon.toDouble(),
      ));
    }
    return out;
  }
}

class WeatherException implements Exception {
  WeatherException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// WMO 天气代码 → 中文短句（Open-Meteo 用的就是这套码）。
String weatherText(int code) {
  switch (code) {
    case 0:
      return '晴';
    case 1:
      return '晴间多云';
    case 2:
      return '多云';
    case 3:
      return '阴';
    case 45:
    case 48:
      return '雾';
    case 51:
    case 53:
    case 55:
      return '毛毛雨';
    case 56:
    case 57:
      return '冻毛毛雨';
    case 61:
      return '小雨';
    case 63:
      return '中雨';
    case 65:
      return '大雨';
    case 66:
    case 67:
      return '冻雨';
    case 71:
      return '小雪';
    case 73:
      return '中雪';
    case 75:
      return '大雪';
    case 77:
      return '米雪';
    case 80:
      return '阵雨';
    case 81:
      return '强阵雨';
    case 82:
      return '暴雨';
    case 85:
    case 86:
      return '阵雪';
    case 95:
      return '雷阵雨';
    case 96:
    case 99:
      return '雷暴夹冰雹';
    default:
      return '—';
  }
}
