// 自毁式 Service Worker（部署时覆盖 Flutter 生成的空文件）。
//
// 为什么需要它：
//   Flutter Web 默认注册 Service Worker 做离线缓存。一旦用户浏览器装过旧版 SW，
//   它会**一直**用缓存里的旧 main.dart.js —— 我们部署了新版本，用户看到的还是几小时前的，
//   而且因为 index.html 也可能被缓存，连"清理脚本"都加载不到。
//
// 这个文件的作用是一次性自愈：
//   浏览器每次导航都会来检查 flutter_service_worker.js 是否有更新 →
//   取到这个新文件 → 它清空所有缓存、注销自己、并让页面重新加载 →
//   从此该站点没有 Service Worker，之后每次部署都立即生效。
//
// 幂等：注销后不会再被注册（构建产物里 SW 是空的）。

self.addEventListener('install', () => {
  // 不等待旧的 SW，立即进入激活
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 1) 清空所有缓存（旧构建就藏在里面）
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (e) {
        // 忽略
      }

      // 2) 注销自己
      try {
        await self.registration.unregister();
      } catch (e) {
        // 忽略
      }

      // 3) 让所有打开的页面重新加载，拿到最新构建
      try {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
          client.navigate(client.url);
        }
      } catch (e) {
        // 忽略
      }
    })(),
  );
});

// 兜底：不拦截任何请求（把控制权完全交回网络）
self.addEventListener('fetch', () => {});
