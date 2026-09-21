// **盒内的 root 小代理**：它持有那把 key，而 agent **读不到明文**
// （多租户 ②-3 · 契约 `docs/dev/37-MULTITENANT.md` §12.2 右边那一列 · `39-PERMISSIONS.md` §5.2）。
//
// ── 它解决什么 ────────────────────────────────────────────
// 决策 ① 说"**agent 读不到自己的 key**"。可 dsh 调模型**必须**有一把 key。
// ⇒ 把"持有"和"使用"分开：
//
//     明文  只住在 `/run/hupo/creds.yaml`（**tmpfs · root 0600**）
//     持有  这个代理（root 身份跑）
//     使用  agent 把请求发给**本机这个口**，代理替它把 `Authorization` 换成真 key
//
//   ⇒ agent 那一侧**一个字节的明文都没有**：它的 env 里只有一个**占位符**
//     （`HUPO_MODEL_TICKET`，名字刻意避开 `_API_KEY` / `_TOKEN` / `_SECRET` / `DEEPSEEK`
//       —— 否则会踩 V4b 那条 `env` 扫描：`39-PERMISSIONS.md` §7.2.1）。
//
// ── 四条不许破 ────────────────────────────────────────────
//   ① 🔴 **只监听回环**（`127.0.0.1`）。容器有**自己的网络命名空间** ⇒ 盒外进不来；
//      绑 `0.0.0.0` 就等于把"用你 key 的资格"递给同网段的一切；
//   ② 🔴 **不许打印 / 落盘 / 回显 key**，任何一条日志里都不许出现（本文件里
//      key 只以变量的形式存在，`log()` 只拿得到路径与状态）；
//   ③ **流式转发**：模型那边是 SSE，**不许把响应缓冲下来**
//      （缓冲了就不是流式了 —— 用户会看到"它憋半天然后一次全出来"）；
//   ④ **没有 key 时如实 503**，不许拿占位符去试上游
//      （那样用户看到的是"模型报鉴权错"，而真正的原因在我们这边 —— 那是假话）。
//
// ⚠️ **这一层不是"认证"**：容器里只有两个身份（root 服务、uid 1000 的 agent），
//    而回环口在**这个容器自己的网络命名空间**里 ⇒ 边界就是"容器"本身。
//    `SO_PEERCRED` 那一条留在**宿主↔容器**那条通道上（②-4），不在这一层。

import nodeFs from 'node:fs';
import nodeHttp from 'node:http';

/** 默认端口。⚠️ 与 `hupo-model-proxy.yml` 里那个 `baseURL` **必须一致**。 */
export const DEFAULT_PROXY_PORT = 8787;

/** key 住在哪（tmpfs · root 0600 · 由 ②-4 注入）。 */
export const DEFAULT_KEY_FILE = '/run/hupo/creds.yaml';

/** 真上游。 */
export const DEFAULT_UPSTREAM = 'https://api.deepseek.com';

/**
 * 从那份文件里**读**出 key。
 *
 * ⚠️ 格式**故意宽容**（写它的是我们自己，但两处别各写一套解析）：
 *    * 单行、非空 ⇒ 那一行就是 key；
 *    * 像 YAML 那种 `名字: 值` ⇒ 取**名字里带 KEY/TOKEN/SECRET** 的那一条，
 *      没有就取第一行。引号会去掉。
 * ⚠️ **纯函数**（给 `test/unit` 钉）：它出错的代价是"拿半个 key 去请求"。
 */
export function parseKey(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) return null;
  const strip = (v) => v.trim().replace(/^["']|["']$/g, '');

  // ⚠️ **先判"这份文件像不像 YAML"**，别一头钻进"整份就是一把 key"那条路：
  //    实测踩过 —— `NAME:`（名字有、值空）会被当成"整份就是 key"，
  //    于是**字面量 `NAME:` 被拿去当 key 发给上游**（现象是上游回鉴权失败，
  //    而真正原因是解析把空值当成了值）。⇒ 有冒号就**只**按 YAML 解。
  const looksYaml = lines.some((l) => l.indexOf(':') > 0);
  if (!looksYaml) return strip(lines[0]);

  const pairs = lines
    .map((l) => {
      const i = l.indexOf(':');
      if (i <= 0) return null;
      return { name: l.slice(0, i).trim(), value: strip(l.slice(i + 1)) };
    })
    .filter((p) => p && p.value.length > 0);
  if (pairs.length === 0) return null; // 有名字没值 ⇒ **没有 key**，不是"名字就是 key"
  const named = pairs.find((p) => /(KEY|TOKEN|SECRET)/i.test(p.name));
  return (named ?? pairs[0]).value;
}

/** 读 key 文件；读不到 / 读出来是空的 ⇒ `null`（**不抛**，让调用方回 503）。 */
export function readKeyFile(file, fs = nodeFs) {
  try {
    const k = parseKey(fs.readFileSync(file, 'utf8'));
    return k && k.length > 0 ? k : null;
  } catch {
    return null;
  }
}

/**
 * 起这个代理。
 *
 * @param {object} o
 * @param {string} [o.keyFile]
 * @param {string} [o.upstream]
 * @param {number} [o.port]
 * @param {string} [o.host]  ⚠️ 只有测试会改它（生产必须回环）
 * @param {Function} [o.fetchImpl]
 * @param {(m:string)=>void} [o.log]  ⚠️ **只许传不敏感的东西**
 */
export function startModelProxy({
  keyFile = process.env.HUPO_KEY_FILE ?? DEFAULT_KEY_FILE,
  upstream = process.env.HUPO_UPSTREAM ?? DEFAULT_UPSTREAM,
  port = Number.parseInt(process.env.HUPO_PROXY_PORT ?? String(DEFAULT_PROXY_PORT), 10),
  host = '127.0.0.1',
  fetchImpl = globalThis.fetch,
  log = (m) => console.log(m),
} = {}) {
  const base = String(upstream).replace(/\/+$/u, '');

  const server = nodeHttp.createServer(async (req, res) => {
    // ⚠️ key **每一次请求现读**：这样"还没注入"和"刚注入"都不用重启代理。
    const key = readKeyFile(keyFile);
    if (!key) {
      // ④ 如实说：不是"模型鉴权失败"，是"我们这边还没有 key"
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no-key', text: '这一台还没有配好模型凭据。' }));
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    const headers = { ...req.headers };
    // 🔴 **只换这一件**：别的头原样带过去
    headers.authorization = `Bearer ${key}`;
    // ⚠️ 长度可能被客户端写成别的；让 fetch 自己算（去掉之后它会按 body 重算）
    delete headers['content-length'];
    headers.host = new URL(base).host;

    let up;
    try {
      up = await fetchImpl(`${base}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
    } catch (err) {
      // ⚠️ 这里**不许**把 headers/url 打出来（url 里可能带查询参数）
      log(`  ⚠️ 代理转不出去：${err?.message ?? err}`);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream-unreachable' }));
      return;
    }

    // ③ **流式**透传（不缓冲）
    res.writeHead(up.status, Object.fromEntries(up.headers));
    if (!up.body) return res.end();
    for await (const c of up.body) {
      if (!res.write(Buffer.from(c))) {
        await new Promise((r) => res.once('drain', r));
      }
    }
    res.end();
  });

  return {
    server,
    /** @returns {Promise<{port:number}>} */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          // ⚠️ 这一行里**没有 key**，也不该有
          log(`  模型代理 ${host}:${addr.port} → ${base}（key 从 ${keyFile} 现读）`);
          resolve({ port: addr.port });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ── 直接跑（镜像里就是这么起的）────────────────────────────
// ⚠️ 只在**被直接执行**时起，被 import 时不起（测试要 import 那些纯函数）。
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startModelProxy()
    .listen()
    .catch((err) => {
      console.error(`✗ 模型代理起不来：${err?.message ?? err}`);
      process.exit(1);
    });
}
