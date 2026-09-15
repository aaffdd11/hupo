// 「天气」这个应用。
//
// 一个订阅式的城市清单：加城市 → 每个城市一张卡，卡片上是当前天气 +
// 未来 7 天。加城市走内置城市表，表里没有再去网上查。
//
// 数据来源是 Open-Meteo（免密钥），所以客户端自己就能取数，不用绕服务端。
// 数据落地在本地存储，下次打开先用旧的顶上，再刷新。

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../services/city_catalog.dart';
import '../services/weather.dart';

const String _storeKey = 'hupo_weather_cities_v1';

/// 第一次打开时默认给的城市。
const City _defaultCity = City(
  name: '嵊州',
  admin: '浙江·绍兴',
  pinyin: 'shengzhou',
  latitude: 29.5886,
  longitude: 120.8281,
);

/// 城市清单的本地存储。
class WeatherStore {
  const WeatherStore();

  Future<List<City>> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      final raw = p.getString(_storeKey);
      if (raw == null || raw.isEmpty) return [_defaultCity];
      final decoded = jsonDecode(raw);
      if (decoded is! List) return [_defaultCity];
      final cities = decoded.map(City.fromJson).whereType<City>().toList();
      return cities.isEmpty ? [_defaultCity] : cities;
    } catch (_) {
      return [_defaultCity];
    }
  }

  Future<void> save(List<City> cities) async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_storeKey, jsonEncode(cities.map((c) => c.toJson()).toList()));
    } catch (_) {
      /* 存不上不影响这次用 */
    }
  }
}

class WeatherAppPage extends StatefulWidget {
  const WeatherAppPage({super.key, this.api, this.store = const WeatherStore()});

  /// 测试时注入假的网络层。
  final WeatherApi? api;
  final WeatherStore store;

  @override
  State<WeatherAppPage> createState() => _WeatherAppPageState();
}

class _WeatherAppPageState extends State<WeatherAppPage> {
  late final WeatherApi _api = widget.api ?? WeatherApi();

  final List<City> _cities = [];
  final Map<String, WeatherBundle> _bundles = {};
  final Map<String, String> _errors = {};
  final Set<String> _loading = {};

  bool _booting = true;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    final saved = await widget.store.load();
    if (!mounted) return;
    setState(() {
      _cities
        ..clear()
        ..addAll(saved);
      _booting = false;
    });
    await _refreshAll();
  }

  Future<void> _refreshAll() async {
    await Future.wait(_cities.map(_refreshCity));
  }

  Future<void> _refreshCity(City city) async {
    setState(() {
      _loading.add(city.id);
      _errors.remove(city.id);
    });
    try {
      final bundle = await _api.forecast(city);
      if (!mounted) return;
      setState(() {
        _bundles[city.id] = bundle;
        _loading.remove(city.id);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading.remove(city.id);
        _errors[city.id] = e is WeatherException ? e.message : '没取到数据';
      });
    }
  }

  Future<void> _persist() => widget.store.save(List<City>.unmodifiable(_cities));

  Future<void> _addCity() async {
    final picked = await Navigator.of(context).push<City>(
      MaterialPageRoute(builder: (_) => AddCityPage(api: _api)),
    );
    if (picked == null || !mounted) return;
    if (_cities.any((c) => c.id == picked.id)) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${picked.name} 已经在列表里了')),
      );
      return;
    }
    setState(() => _cities.add(picked));
    await _persist();
    await _refreshCity(picked);
  }

  Future<void> _removeCity(City city) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('不跟踪 ${city.name} 了？'),
        content: const Text('只会从这个列表里去掉，不影响别的。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('去掉'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() {
      _cities.removeWhere((c) => c.id == city.id);
      _bundles.remove(city.id);
      _errors.remove(city.id);
    });
    await _persist();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    if (_booting) {
      return const Center(child: CircularProgressIndicator());
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  '${_cities.length} 个城市 · 未来 7 天',
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                ),
              ),
              IconButton(
                key: const Key('weather-refresh'),
                tooltip: '刷新',
                onPressed: _loading.isEmpty ? _refreshAll : null,
                icon: const Icon(Icons.refresh),
              ),
              TextButton.icon(
                key: const Key('weather-add-city'),
                onPressed: _addCity,
                icon: const Icon(Icons.add, size: 18),
                label: const Text('加城市'),
              ),
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _refreshAll,
            child: ListView.builder(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
              itemCount: _cities.length,
              itemBuilder: (context, i) {
                final city = _cities[i];
                return _CityCard(
                  key: Key('weather-card-${city.id}'),
                  city: city,
                  bundle: _bundles[city.id],
                  error: _errors[city.id],
                  loading: _loading.contains(city.id),
                  onRefresh: () => _refreshCity(city),
                  onRemove: () => _removeCity(city),
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}

/// 一个城市一张卡。
class _CityCard extends StatelessWidget {
  const _CityCard({
    super.key,
    required this.city,
    required this.bundle,
    required this.error,
    required this.loading,
    required this.onRefresh,
    required this.onRemove,
  });

  final City city;
  final WeatherBundle? bundle;
  final String? error;
  final bool loading;
  final VoidCallback onRefresh;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final b = bundle;
    final now = b?.temperature;

    return Card(
      elevation: 0,
      color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.35),
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(city.name,
                          style: theme.textTheme.titleMedium
                              ?.copyWith(fontWeight: FontWeight.w600)),
                      if (city.subtitle.isNotEmpty)
                        Text(city.subtitle,
                            style: theme.textTheme.bodySmall
                                ?.copyWith(color: theme.hintColor)),
                    ],
                  ),
                ),
                if (now != null)
                  Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: Text('${now.round()}°',
                        style: theme.textTheme.headlineMedium
                            ?.copyWith(fontWeight: FontWeight.w300)),
                  ),
                IconButton(
                  key: Key('weather-remove-${city.id}'),
                  tooltip: '不再跟踪',
                  onPressed: onRemove,
                  icon: Icon(Icons.close, size: 18, color: theme.hintColor),
                ),
              ],
            ),
            const SizedBox(height: 2),
            if (error != null)
              Row(
                children: [
                  Expanded(
                    child: Text(error!,
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: theme.colorScheme.error)),
                  ),
                  TextButton(onPressed: onRefresh, child: const Text('重试')),
                ],
              )
            else if (b == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 18),
                child: Center(
                  child: SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              )
            else ...[
              Row(
                children: [
                  Icon(weatherIcon(b.weatherCode ?? b.today?.weatherCode ?? 0),
                      size: 18, color: theme.colorScheme.primary),
                  const SizedBox(width: 6),
                  Text(weatherText(b.weatherCode ?? b.today?.weatherCode ?? 0),
                      style: theme.textTheme.bodyMedium),
                  if (b.today != null) ...[
                    const SizedBox(width: 10),
                    Text('${b.today!.min.round()}° / ${b.today!.max.round()}°',
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: theme.hintColor)),
                  ],
                  if (loading) ...[
                    const SizedBox(width: 10),
                    const SizedBox(
                      width: 12,
                      height: 12,
                      child: CircularProgressIndicator(strokeWidth: 1.6),
                    ),
                  ],
                ],
              ),
              if (b.humidity != null || b.windSpeed != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    [
                      if (b.humidity != null) '湿度 ${b.humidity}%',
                      if (b.windSpeed != null) '风 ${b.windSpeed!.round()} km/h',
                      '更新 ${_hhmm(b.fetchedAt)}',
                    ].join(' · '),
                    style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
                  ),
                ),
              const SizedBox(height: 10),
              _DailyStrip(days: b.days),
            ],
          ],
        ),
      ),
    );
  }
}

/// 未来 7 天，横着排。
class _DailyStrip extends StatelessWidget {
  const _DailyStrip({required this.days});

  final List<DailyForecast> days;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (days.isEmpty) {
      return Text('没有未来的预报',
          style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor));
    }
    return SizedBox(
      height: 124,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: days.length,
        separatorBuilder: (_, __) => const SizedBox(width: 4),
        itemBuilder: (context, i) {
          final d = days[i];
          return Container(
            width: 62,
            padding: const EdgeInsets.symmetric(vertical: 8),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              color: i == 0
                  ? theme.colorScheme.primary.withValues(alpha: 0.10)
                  : Colors.transparent,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(i == 0 ? '今天' : weekdayLabel(d.date),
                    style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
                const SizedBox(height: 6),
                Icon(weatherIcon(d.weatherCode), size: 20, color: theme.colorScheme.primary),
                const SizedBox(height: 6),
                Text('${d.max.round()}°',
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(fontWeight: FontWeight.w600)),
                Text('${d.min.round()}°',
                    style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
                SizedBox(
                  height: 16,
                  child: d.precipitationProbability != null &&
                          d.precipitationProbability! > 0
                      ? Text('${d.precipitationProbability}%',
                          style: theme.textTheme.labelSmall
                              ?.copyWith(color: theme.colorScheme.primary))
                      : null,
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// 加城市：先搜本地表，本地没有再去网上找。
class AddCityPage extends StatefulWidget {
  const AddCityPage({super.key, required this.api});

  final WeatherApi api;

  @override
  State<AddCityPage> createState() => _AddCityPageState();
}

class _AddCityPageState extends State<AddCityPage> {
  final _controller = TextEditingController();
  List<City> _results = const [];
  bool _searching = false;
  bool _searched = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _search(String query) async {
    final local = searchCatalog(query);
    setState(() {
      _results = local;
      _searched = query.trim().isNotEmpty;
      _error = null;
    });
    if (query.trim().isEmpty) return;

    setState(() => _searching = true);
    List<City> remote = const [];
    try {
      remote = await widget.api.search(query);
    } catch (_) {
      remote = const [];
    }
    if (!mounted) return;
    final seen = local.map((c) => c.id).toSet();
    setState(() {
      _searching = false;
      _results = [...local, ...remote.where((c) => !seen.contains(c.id))];
      if (_results.isEmpty) _error = '没找到这个地方，换个写法试试（中文名或拼音）';
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: TextField(
              key: const Key('weather-city-query'),
              controller: _controller,
              autofocus: true,
              textInputAction: TextInputAction.search,
              onSubmitted: _search,
              decoration: InputDecoration(
                hintText: '城市名或拼音，例如 嵊州 / shengzhou',
                prefixIcon: const Icon(Icons.search),
                border: const OutlineInputBorder(),
                isDense: true,
                suffixIcon: IconButton(
                  tooltip: '搜索',
                  onPressed: () => _search(_controller.text),
                  icon: const Icon(Icons.arrow_forward),
                ),
              ),
            ),
          ),
          if (_searching) const LinearProgressIndicator(minHeight: 2),
          Expanded(
            child: !_searched
                ? _HintList(onPick: (c) => Navigator.of(context).pop(c))
                : _results.isEmpty && !_searching
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(_error ?? '没找到',
                              textAlign: TextAlign.center,
                              style: theme.textTheme.bodyMedium
                                  ?.copyWith(color: theme.hintColor)),
                        ),
                      )
                    : ListView.builder(
                        itemCount: _results.length,
                        itemBuilder: (context, i) {
                          final c = _results[i];
                          return ListTile(
                            key: Key('weather-result-${c.id}'),
                            title: Text(c.name),
                            subtitle: c.subtitle.isEmpty ? null : Text(c.subtitle),
                            trailing: const Icon(Icons.add),
                            onTap: () => Navigator.of(context).pop(c),
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}

class _HintList extends StatelessWidget {
  const _HintList({required this.onPick});

  final ValueChanged<City> onPick;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Text('常看的',
              style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor)),
        ),
        ...[
          _defaultCity,
          ...kCityCatalog.where((c) =>
              const {'杭州', '绍兴', '宁波', '上海', '北京'}.contains(c.name)),
        ].map((c) => ListTile(
              title: Text(c.name),
              subtitle: c.subtitle.isEmpty ? null : Text(c.subtitle),
              trailing: const Icon(Icons.add),
              onTap: () => onPick(c),
            )),
      ],
    );
  }
}

IconData weatherIcon(int code) {
  if (code == 0) return Icons.wb_sunny_outlined;
  if (code == 1 || code == 2) return Icons.cloud_queue;
  if (code == 3) return Icons.cloud_outlined;
  if (code == 45 || code == 48) return Icons.foggy;
  if (code >= 51 && code <= 57) return Icons.grain;
  if (code >= 61 && code <= 67) return Icons.umbrella_outlined;
  if (code >= 71 && code <= 77) return Icons.ac_unit;
  if (code >= 80 && code <= 82) return Icons.water_drop_outlined;
  if (code >= 85 && code <= 86) return Icons.ac_unit;
  if (code >= 95) return Icons.thunderstorm_outlined;
  return Icons.help_outline;
}

String weekdayLabel(DateTime date) {
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  return '周${names[date.weekday - 1]}';
}

String _hhmm(DateTime t) =>
    '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
