// 把 SW 自愈脚本注入 index.html（幂等）
import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('用法: node inject-sw-cleanup.mjs <index.html>'); process.exit(1); }

const SNIPPET = `  <script>
    // 自愈：注销历史 Service Worker 并清空缓存。
    // 旧版 SW 会一直拿缓存里的旧 main.dart.js，导致部署了新版本用户也看不到。
    // 这里在每次加载时主动清理，用户不需要手动清缓存。
    (function () {
      try {
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations().then(function (rs) {
            rs.forEach(function (r) { r.unregister(); });
          });
        }
        if (window.caches && caches.keys) {
          caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); });
        }
      } catch (e) { /* 清理失败不影响使用 */ }
    })();
  </script>
`;

let html = fs.readFileSync(file, 'utf8');
if (html.includes('注销历史 Service Worker')) {
  console.log('  已注入过，跳过');
} else {
  html = html.replace('</body>', `${SNIPPET}</body>`);
  fs.writeFileSync(file, html);
  console.log('  ✅ 已注入');
}
