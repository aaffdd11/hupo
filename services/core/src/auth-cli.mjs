// 设口令的运维命令。
//
//   node src/auth-cli.mjs --random          # 生成一个强口令（只在屏幕上出一次）
//   node src/auth-cli.mjs '我的口令ABC123...'  # 用指定口令
//   node src/auth-cli.mjs --status           # 看看现在设没设
//
// 为什么单独一个命令：口令**不能进代码、不能进仓库、不能进日志**。
// 这里只把哈希写进 data/auth.json（0600），明文只在屏幕上出现这一次。

import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { Auth, passwordProblem } from './auth.js';

const cfg = loadConfig();
const auth = new Auth(cfg.dataDir, { enabled: true });

const arg = process.argv[2];

if (arg === '--token') {
  // 给本机脚本用（watch.mjs / browser-check.mjs 这些验证工具）。
  // 能读 data/auth.json 的人已经拥有这台机器了，所以这里不算额外开口子；
  // 但它**只在本机命令行**能用，没有任何网络入口。
  if (!auth.hasPassword) {
    console.error('✗ 还没设口令，鉴权没生效，不需要令牌');
    process.exit(1);
  }
  const token = auth.issueToken();
  console.log(token);
  console.error(`（有效期 ${Math.round(auth.sessionTtlMs / 86400000)} 天）`);
  process.exit(0);
}

if (!arg || arg === '--status') {
  console.log(`口令：${auth.hasPassword ? '已设置' : '⚠ 未设置（服务当前对所有请求放行）'}`);
  console.log(`鉴权生效：${auth.active ? '是' : '否'}`);
  process.exit(0);
}

let password = arg;
if (arg === '--random') {
  // 32 个字符、四种字符齐全 —— 这台机器上跑着能动系统文件的 agent，口令不能凑合
  const abc = 'abcdefghijkmnopqrstuvwxyz';
  const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const num = '23456789';
  const sym = '-_';
  const pick = (s) => s[crypto.randomInt(s.length)];
  const chars = [pick(abc), pick(ABC), pick(num), pick(sym)];
  const all = abc + ABC + num + sym;
  while (chars.length < 28) chars.push(pick(all));
  // 洗牌
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  password = chars.join('');
}

const problem = passwordProblem(password);
if (problem) {
  console.error(`✗ ${problem}`);
  process.exit(1);
}

auth.setPassword(password);
console.log(`✓ 口令已设置（只存哈希，明文不落盘）`);
if (arg === '--random') {
  console.log('');
  console.log(`  口令：${password}`);
  console.log('');
  console.log('  ⚠ 这串只在屏幕上出现这一次。现在就去登录页存进密码管理器。');
}
console.log(`  文件：${auth.file}（权限 600）`);
console.log('  改完记得重启服务：sudo systemctl restart concierge-core');
