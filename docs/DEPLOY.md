# 部署说明（Hupo 客户端）

## 站点

| 项 | 值 |
|---|---|
| **主域名** | **https://hupo.stalkerai.cn** |
| 备用域名 | `http://hupo.chat`（仅 HTTP，见下"已知问题"） |
| 静态根目录 | `/var/www/hupo` |
| nginx 配置 | `/etc/nginx/conf.d/hupo-stalkerai.conf`（+ `hupo-chat.conf`） |
| HTTPS | Let's Encrypt，certbot 自动续期（90 天） |
| 公网 IP | 120.26.179.211（阿里云杭州） |

## 部署 / 更新

```bash
# 一条命令：静态分析 → 测试 → 构建 → 部署
scripts/deploy-web.sh
```

部署脚本会先跑 `flutter analyze` 与 `flutter test`，**任一失败即中止**，
不会把坏构建推上线。

## 首次部署（换机器时）

```bash
# 1. 装 Flutter（约 1.44G 下载、2.4G 解压，注意磁盘）
mkdir -p ~/sdk && cd ~/sdk
curl -L -o flutter.tar.xz https://storage.flutter-io.cn/flutter_infra_release/releases/stable/linux/flutter_linux_3.35.1-stable.tar.xz
tar xf flutter.tar.xz && rm flutter.tar.xz
export PATH="$HOME/sdk/flutter/bin:$PATH"

# 2. 建目录与 nginx vhost（见 scripts/enable-https.sh 的注释）
sudo mkdir -p /var/www/hupo /var/www/certbot

# 3. 部署 + 启 HTTPS
scripts/deploy-web.sh
scripts/enable-https.sh hupo.stalkerai.cn
```

## 证书

```bash
# 状态
sudo certbot certificates | grep -A3 hupo.stalkerai.cn
# 续期演练
sudo certbot renew --dry-run --cert-name hupo.stalkerai.cn
```

certbot 已注册定时任务自动续期，无需手工干预。
**注意**：certbot 同一时间只能跑一个实例；若报 `Another instance of Certbot is already running`，
等前一个跑完再试（不要强行中断，可能留下锁）。

## 已知问题：hupo.chat 无法签发证书

**现象**：Let's Encrypt 验证持续 403；同一台机器、同一 nginx、同一插件的
`dsh.stalkerai.cn` 却 `dry run successful`。唯一变量是域名。

**排查到的证据**：

| 观察 | 结果 |
|---|---|
| LE 的请求是否到达本机 nginx | ✅ 是（访问日志有 `23.178.112.x`） |
| nginx 对 LE 的响应 | `200` 但 **0 字节** |
| 同一 URL 本机访问 | `200`、87 字节（正常） |
| 挑战文件状态（钩子自检） | 644 `www-data`、87 字节 ✅ |
| 换子域 `test.hupo.chat` | ❌ 同样 403 |
| 换域名 `hupo.stalkerai.cn` | ✅ **一次签成** |

**结论**：`hupo.chat` 存在**域名级拦截**。本机是阿里云杭州（大陆），
大陆节点上 80/443 对外提供服务的域名需要 **ICP 备案**——
`*.stalkerai.cn` 已备案所以正常，`hupo.chat` 大概率未备案。

**处理**：主域名切换为 `hupo.stalkerai.cn`。
若之后要用 `hupo.chat`，需要先在阿里云完成备案（或确认没有配 CDN/WAF 拦截）。

## 接入服务端（下一步）

服务端就绪后，在 `hupo-stalkerai.conf` 的 443 server 块里放开 API 反代
（配置里已写好注释模板），并把客户端的 `MockTransport` 换成 `WebSocketTransport`：

```dart
WebSocketTransport(baseUrl: 'https://hupo.stalkerai.cn', token: /* 设备令牌 */)
```

协议见 `packages/protocol/PROTOCOL.md` —— **改协议先改那份**。

## 运维备忘

- 磁盘：部署前检查剩余空间（Flutter 构建缓存增长快，本次曾因磁盘 92% 触发 `No space left on device`）
- 清理构建缓存：`cd apps/mobile && flutter clean`
- 静态产物带 hash，可长缓存；`index.html` 与 `flutter_service_worker.js` 不缓存（配置已设）
