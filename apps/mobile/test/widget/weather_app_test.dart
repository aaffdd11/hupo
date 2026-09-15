// 「天气」应用的界面测试：默认给嵊州、能加城市、能去掉、拿不到数据时显示重试。

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hupo_app/apps/weather_app.dart';
import 'package:hupo_app/services/weather.dart';

const _shengzhou = City(
  name: '嵊州',
  admin: '浙江·绍兴',
  latitude: 29.5886,
  longitude: 120.8281,
);

class _FakeStore extends WeatherStore {
  _FakeStore(this.initial);

  final List<City> initial;
  List<City>? saved;

  @override
  Future<List<City>> load() async => initial;

  @override
  Future<void> save(List<City> cities) async => saved = cities;
}

class _FakeApi extends WeatherApi {
  _FakeApi({this.failing = false});

  final bool failing;
  int calls = 0;

  @override
  Future<WeatherBundle> forecast(City city) async {
    calls++;
    if (failing) throw WeatherException('天气服务回了 500');
    final now = DateTime(2026, 9, 15, 15, 30);
    return WeatherBundle(
      city: city,
      fetchedAt: now,
      temperature: 30,
      weatherCode: 0,
      humidity: 28,
      windSpeed: 14.6,
      days: List.generate(
        7,
        (i) => DailyForecast(
          date: DateTime(2026, 9, 15 + i),
          weatherCode: i.isEven ? 0 : 61,
          max: 30 + i * 0.1,
          min: 20 + i * 0.1,
          precipitationProbability: i.isEven ? 0 : 60,
        ),
      ),
    );
  }

  @override
  Future<List<City>> search(String query) async => const [
        City(name: '新昌', admin: '浙江·绍兴', latitude: 29.4996, longitude: 120.9039),
      ];
}

Widget _wrap(Widget child) => MaterialApp(
      home: Scaffold(body: child),
    );

/// 等异步取数落地（不能用 pumpAndSettle：转圈是无限动画）。
///
/// 帧数给够还有第二个原因：加城市是 push 一个新页面再 pop 回来，
/// 页面切换动画要 300ms —— 没走完时旧页面的列表项还挂在树上，
/// 同一个名字会被数出两个（踩过）。
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 14; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

void main() {
  testWidgets('第一次打开默认给嵊州，显示当前天气和 7 天', (tester) async {
    await tester.pumpWidget(_wrap(WeatherAppPage(
      api: _FakeApi(),
      store: _FakeStore(const [_shengzhou]),
    )));
    await _settle(tester);

    expect(tester.takeException(), isNull);
    expect(find.text('嵊州'), findsOneWidget);
    expect(find.text('浙江·绍兴'), findsOneWidget);
    expect(find.text('30°'), findsWidgets);
    expect(find.text('今天'), findsOneWidget);
    expect(find.text('晴'), findsOneWidget);
    expect(find.text('1 个城市 · 未来 7 天'), findsOneWidget);
  });

  testWidgets('加一个城市：搜出来点一下，卡片出现并写进本地', (tester) async {
    final store = _FakeStore(const [_shengzhou]);
    await tester.pumpWidget(_wrap(WeatherAppPage(api: _FakeApi(), store: store)));
    await _settle(tester);

    await tester.tap(find.byKey(const Key('weather-add-city')));
    await _settle(tester);

    await tester.enterText(find.byKey(const Key('weather-city-query')), 'xinchang');
    await tester.testTextInput.receiveAction(TextInputAction.search);
    await _settle(tester);

    await tester.tap(find.byKey(const Key('weather-result-29.500,120.904')));
    await _settle(tester);

    expect(find.byKey(const Key('weather-card-29.500,120.904')), findsOneWidget);
    expect(find.text('2 个城市 · 未来 7 天'), findsOneWidget);
    expect(store.saved?.map((c) => c.name), containsAll(['嵊州', '新昌']));
  });

  testWidgets('去掉一个城市：确认后卡片消失', (tester) async {
    final store = _FakeStore(const [_shengzhou]);
    await tester.pumpWidget(_wrap(WeatherAppPage(api: _FakeApi(), store: store)));
    await _settle(tester);

    await tester.tap(find.byKey(const Key('weather-remove-29.589,120.828')));
    await _settle(tester);
    expect(find.text('不跟踪 嵊州 了？'), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, '去掉'));
    await _settle(tester);

    expect(find.text('嵊州'), findsNothing);
    expect(find.text('0 个城市 · 未来 7 天'), findsOneWidget);
  });

  testWidgets('拿不到数据时给出提示和重试，不崩', (tester) async {
    final api = _FakeApi(failing: true);
    await tester.pumpWidget(_wrap(WeatherAppPage(
      api: api,
      store: _FakeStore(const [_shengzhou]),
    )));
    await _settle(tester);

    expect(find.text('天气服务回了 500'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);

    await tester.tap(find.text('重试'));
    await _settle(tester);
    expect(api.calls, greaterThan(1));
  });

  testWidgets('搜索页空空时给常看的建议，不调网络也能选', (tester) async {
    await tester.pumpWidget(_wrap(WeatherAppPage(
      api: _FakeApi(),
      store: _FakeStore(const [_shengzhou]),
    )));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('weather-add-city')));
    await _settle(tester);

    expect(find.text('常看的'), findsOneWidget);
    expect(find.text('杭州'), findsOneWidget);
  });
}
