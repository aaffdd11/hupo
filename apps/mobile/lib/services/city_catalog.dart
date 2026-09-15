// 内置城市表。
//
// 为什么要内置：按名字查城市的公开服务里，小地方（例如嵊州）根本查不到，
// 而主人老家就在嵊州。所以常用城市先摆在本地，搜不到再走网络。

import 'weather.dart';

/// 常用城市：省会和主要城市，浙江全省铺满，绍兴各县市单列。
const List<City> kCityCatalog = [
  // 绍兴 · 浙江
  City(name: '嵊州', admin: '浙江·绍兴', pinyin: 'shengzhou', latitude: 29.5886, longitude: 120.8281),
  City(name: '新昌', admin: '浙江·绍兴', pinyin: 'xinchang', latitude: 29.4996, longitude: 120.9039),
  City(name: '诸暨', admin: '浙江·绍兴', pinyin: 'zhuji', latitude: 29.7137, longitude: 120.2363),
  City(name: '柯桥', admin: '浙江·绍兴', pinyin: 'keqiao', latitude: 30.0797, longitude: 120.4922),
  City(name: '上虞', admin: '浙江·绍兴', pinyin: 'shangyu', latitude: 30.0331, longitude: 120.8681),
  City(name: '越城', admin: '浙江·绍兴', pinyin: 'yuecheng', latitude: 29.9889, longitude: 120.5820),
  City(name: '绍兴', admin: '浙江', pinyin: 'shaoxing', latitude: 30.0023, longitude: 120.5810),
  City(name: '杭州', admin: '浙江', pinyin: 'hangzhou', latitude: 30.2937, longitude: 120.1614),
  City(name: '宁波', admin: '浙江', pinyin: 'ningbo', latitude: 29.8683, longitude: 121.5440),
  City(name: '温州', admin: '浙江', pinyin: 'wenzhou', latitude: 27.9994, longitude: 120.6668),
  City(name: '嘉兴', admin: '浙江', pinyin: 'jiaxing', latitude: 30.7522, longitude: 120.7500),
  City(name: '湖州', admin: '浙江', pinyin: 'huzhou', latitude: 30.8703, longitude: 120.0933),
  City(name: '金华', admin: '浙江', pinyin: 'jinhua', latitude: 29.0784, longitude: 119.6495),
  City(name: '衢州', admin: '浙江', pinyin: 'quzhou', latitude: 28.9359, longitude: 118.8742),
  City(name: '台州', admin: '浙江', pinyin: 'taizhou', latitude: 28.6584, longitude: 121.4200),
  City(name: '丽水', admin: '浙江', pinyin: 'lishui', latitude: 28.4517, longitude: 119.9220),
  City(name: '舟山', admin: '浙江', pinyin: 'zhoushan', latitude: 29.9853, longitude: 122.2072),
  // 直辖市与省会
  City(name: '北京', admin: '北京', pinyin: 'beijing', latitude: 39.9042, longitude: 116.4074),
  City(name: '上海', admin: '上海', pinyin: 'shanghai', latitude: 31.2222, longitude: 121.4581),
  City(name: '天津', admin: '天津', pinyin: 'tianjin', latitude: 39.1422, longitude: 117.1767),
  City(name: '重庆', admin: '重庆', pinyin: 'chongqing', latitude: 29.5603, longitude: 106.5577),
  City(name: '广州', admin: '广东', pinyin: 'guangzhou', latitude: 23.1167, longitude: 113.2500),
  City(name: '深圳', admin: '广东', pinyin: 'shenzhen', latitude: 22.5455, longitude: 114.0683),
  City(name: '南京', admin: '江苏', pinyin: 'nanjing', latitude: 32.0617, longitude: 118.7778),
  City(name: '苏州', admin: '江苏', pinyin: 'suzhou', latitude: 31.3114, longitude: 120.6175),
  City(name: '无锡', admin: '江苏', pinyin: 'wuxi', latitude: 31.5689, longitude: 120.2886),
  City(name: '合肥', admin: '安徽', pinyin: 'hefei', latitude: 31.8639, longitude: 117.2808),
  City(name: '福州', admin: '福建', pinyin: 'fuzhou', latitude: 26.0614, longitude: 119.3061),
  City(name: '厦门', admin: '福建', pinyin: 'xiamen', latitude: 24.4798, longitude: 118.0819),
  City(name: '南昌', admin: '江西', pinyin: 'nanchang', latitude: 28.6836, longitude: 115.8587),
  City(name: '武汉', admin: '湖北', pinyin: 'wuhan', latitude: 30.5833, longitude: 114.2667),
  City(name: '长沙', admin: '湖南', pinyin: 'changsha', latitude: 28.2282, longitude: 112.9388),
  City(name: '郑州', admin: '河南', pinyin: 'zhengzhou', latitude: 34.7578, longitude: 113.6486),
  City(name: '济南', admin: '山东', pinyin: 'jinan', latitude: 36.6683, longitude: 116.9972),
  City(name: '青岛', admin: '山东', pinyin: 'qingdao', latitude: 36.0662, longitude: 120.3826),
  City(name: '西安', admin: '陕西', pinyin: 'xian', latitude: 34.2583, longitude: 108.9286),
  City(name: '成都', admin: '四川', pinyin: 'chengdu', latitude: 30.6598, longitude: 104.0633),
  City(name: '昆明', admin: '云南', pinyin: 'kunming', latitude: 24.8801, longitude: 102.8329),
  City(name: '贵阳', admin: '贵州', pinyin: 'guiyang', latitude: 26.5833, longitude: 106.7167),
  City(name: '南宁', admin: '广西', pinyin: 'nanning', latitude: 22.8167, longitude: 108.3167),
  City(name: '海口', admin: '海南', pinyin: 'haikou', latitude: 20.0444, longitude: 110.3419),
  City(name: '石家庄', admin: '河北', pinyin: 'shijiazhuang', latitude: 38.0414, longitude: 114.4786),
  City(name: '太原', admin: '山西', pinyin: 'taiyuan', latitude: 37.8694, longitude: 112.5603),
  City(name: '沈阳', admin: '辽宁', pinyin: 'shenyang', latitude: 41.8057, longitude: 123.4315),
  City(name: '大连', admin: '辽宁', pinyin: 'dalian', latitude: 38.9140, longitude: 121.6147),
  City(name: '长春', admin: '吉林', pinyin: 'changchun', latitude: 43.8800, longitude: 125.3228),
  City(name: '哈尔滨', admin: '黑龙江', pinyin: 'haerbin', latitude: 45.7500, longitude: 126.6500),
  City(name: '呼和浩特', admin: '内蒙古', pinyin: 'huhehaote', latitude: 40.8106, longitude: 111.6522),
  City(name: '银川', admin: '宁夏', pinyin: 'yinchuan', latitude: 38.4681, longitude: 106.2731),
  City(name: '兰州', admin: '甘肃', pinyin: 'lanzhou', latitude: 36.0570, longitude: 103.8399),
  City(name: '西宁', admin: '青海', pinyin: 'xining', latitude: 36.6171, longitude: 101.7785),
  City(name: '乌鲁木齐', admin: '新疆', pinyin: 'wulumuqi', latitude: 43.8256, longitude: 87.6168),
  City(name: '拉萨', admin: '西藏', pinyin: 'lasa', latitude: 29.6500, longitude: 91.1000),
  City(name: '香港', admin: '香港', pinyin: 'hongkong', latitude: 22.2855, longitude: 114.1577),
  City(name: '台北', admin: '台湾', pinyin: 'taibei', latitude: 25.0478, longitude: 121.5319),
];

/// 在本地表里搜。名字、拼音、归属地任一命中都算。
List<City> searchCatalog(String query) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return const [];
  final exact = <City>[];
  final fuzzy = <City>[];
  for (final c in kCityCatalog) {
    if (c.name == q || c.pinyin == q) {
      exact.add(c);
    } else if (c.name.contains(q) || c.pinyin.startsWith(q) || c.admin.contains(q)) {
      fuzzy.add(c);
    }
  }
  return [...exact, ...fuzzy];
}
