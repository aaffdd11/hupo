// 天气数据层的测试：解析真实响应形状、城市搜索、本地城市表。

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hupo_app/services/city_catalog.dart';
import 'package:hupo_app/services/weather.dart';

const _sample = '''
{
  "latitude": 29.56063,
  "longitude": 120.83333,
  "timezone": "Asia/Shanghai",
  "current": {
    "time": "2026-09-15T15:00",
    "temperature_2m": 30.0,
    "weather_code": 3,
    "relative_humidity_2m": 28,
    "wind_speed_10m": 14.6
  },
  "daily": {
    "time": ["2026-09-15","2026-09-16","2026-09-17"],
    "weather_code": [51, 3, 0],
    "temperature_2m_max": [30.5, 31.1, 32.0],
    "temperature_2m_min": [22.1, 23.0, 23.4],
    "precipitation_probability_max": [55, 10, 0]
  }
}
''';

const _city = City(
  name: '嵊州',
  admin: '浙江·绍兴',
  latitude: 29.5886,
  longitude: 120.8281,
);

void main() {
  group('解析预报', () {
    test('字段正常时全部读出来', () {
      final b = parseForecast(_city, jsonDecode(_sample) as Map<String, dynamic>, DateTime(2026, 9, 15, 15, 30));

      expect(b.days, hasLength(3));
      expect(b.temperature, 30.0);
      expect(b.weatherCode, 3);
      expect(b.humidity, 28);
      expect(b.windSpeed, 14.6);
      expect(b.today!.max, 30.5);
      expect(b.today!.min, 22.1);
      expect(b.days[0].precipitationProbability, 55);
    });

    test('缺字段不抛，退化成空', () {
      final b = parseForecast(_city, const {}, DateTime(2026, 9, 15));
      expect(b.days, isEmpty);
      expect(b.temperature, isNull);
      expect(b.today, isNull);
    });

    test('数组长度不齐时跳过坏行，不越界', () {
      final json = {
        'daily': {
          'time': ['2026-09-15', '2026-09-16'],
          'temperature_2m_max': [30.0],
          'temperature_2m_min': [20.0],
        },
      };
      final b = parseForecast(_city, json, DateTime(2026, 9, 15));
      expect(b.days, hasLength(1));
      expect(b.days.first.max, 30.0);
    });
  });

  group('取数', () {
    test('请求里带上了 7 天和时区，返回解析成模型', () async {
      late Uri seen;
      final api = WeatherApi(
        client: MockClient((req) async {
          seen = req.url;
          return http.Response(_sample, 200,
              headers: {'content-type': 'application/json; charset=utf-8'});
        }),
      );

      final b = await api.forecast(_city);
      expect(seen.host, 'api.open-meteo.com');
      expect(seen.queryParameters['forecast_days'], '7');
      expect(seen.queryParameters['timezone'], 'auto');
      expect(seen.queryParameters['latitude'], '29.5886');
      expect(b.days, hasLength(3));
      expect(b.city.name, '嵊州');
    });

    test('服务端出错时抛 WeatherException（界面据此显示重试）', () async {
      final api = WeatherApi(client: MockClient((_) async => http.Response('nope', 500)));
      expect(api.forecast(_city), throwsA(isA<WeatherException>()));
    });

    test('返回里没有预报也算失败', () async {
      final api = WeatherApi(
          client: MockClient((_) async => http.Response('{"current":{}}', 200)));
      expect(api.forecast(_city), throwsA(isA<WeatherException>()));
    });

    test('搜索城市：连不上时不抛，返回空', () async {
      final api = WeatherApi(client: MockClient((_) async => throw Exception('断网')));
      expect(await api.search('杭州'), isEmpty);
      final soft = WeatherApi(client: MockClient((_) async => http.Response('boom', 503)));
      expect(await soft.search('杭州'), isEmpty);
    });

    test('搜索城市：解析结果并拼出归属地', () async {
      final api = WeatherApi(
        client: MockClient((_) async => http.Response(
              jsonEncode({
                'results': [
                  {
                    'name': '杭州',
                    'latitude': 30.29,
                    'longitude': 120.16,
                    'country_code': 'CN',
                    'admin1': '浙江',
                    'admin2': '杭州市',
                  }
                ]
              }),
              200,
              headers: {'content-type': 'application/json; charset=utf-8'},
            )),
      );
      final cities = await api.search('hangzhou');
      expect(cities, hasLength(1));
      expect(cities.first.name, '杭州');
      expect(cities.first.subtitle, '浙江·杭州市');
    });
  });

  group('本地城市表', () {
    test('嵊州在表里，中文和拼音都搜得到', () {
      expect(searchCatalog('嵊州').first.name, '嵊州');
      expect(searchCatalog('shengzhou').first.name, '嵊州');
      expect(searchCatalog('嵊州').first.latitude, closeTo(29.59, 0.05));
    });

    test('按归属地能找到绍兴那几个', () {
      final names = searchCatalog('绍兴').map((c) => c.name).toSet();
      expect(names, containsAll(['嵊州', '新昌', '诸暨']));
    });

    test('空搜索返回空', () => expect(searchCatalog('   '), isEmpty));
  });

  group('展示文本', () {
    test('天气代码有中文', () {
      expect(weatherText(0), '晴');
      expect(weatherText(3), '阴');
      expect(weatherText(95), '雷阵雨');
      expect(weatherText(1234), '—');
    });

    test('城市能存能读', () {
      final back = City.fromJson(_city.toJson());
      expect(back!.name, '嵊州');
      expect(back.id, _city.id);
      expect(City.fromJson({'name': '缺坐标'}), isNull);
      expect(City.fromJson('不是对象'), isNull);
    });
  });
}
