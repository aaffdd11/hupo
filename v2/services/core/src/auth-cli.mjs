// 设密码 / 撤销令牌。`npm run set-pass -- "你的密码"`
//
// 为什么单独一个 CLI、而不是做个"首次打开时设密码"的网页：
// **设密码这一步本身就是最高权限**——网页版等于把"设密码"这个动作
// 暴露给任何先连上的人（谁先到谁设）。而这一步在**本机**做，
// 和 VPS 上那些站点用 `.htpasswd` 是同一个思路：
// **权限的起点必须在机器上，不能在网络上。**
//
// 手册 D2 也说清楚了：登录页那句话是"装机器时给你的那一串"——
// 也就是**装的时候**就有，不是打开浏览器时现设。

import nodePath from 'node:path';
import { Auth } from './auth.js';

const DATA = process.env.HUPO_DATA ?? nodePath.resolve('data');
const [cmd, ...rest] = process.argv.slice(2);

const auth = new Auth({ dataDir: DATA });

function usage() {
  console.log(`用法：
  npm run set-pass                    ← 从标准输入读（推荐，密码不进 ps / 历史）
  npm run set-pass -- "你的密码"        ← 直接给（⚠️ 会短暂出现在 ps 与 shell 历史里）
  npm run revoke -- <令牌>             撤销一个令牌
  npm run auth-status                 看当前状态

说明：
  · 密码至少 6 位（按**码点**数，一个汉字算一位）。
  · 密码只存哈希（scrypt 加盐），明文不落盘、不进日志。
  · 数据目录：${DATA}
`);
}

/**
 * 取密码。
 *
 * ⚠️ 优先走 stdin：**命令行参数会出现在 `ps` 的输出里**（同机其他用户能看到），
 *    也会被 shell 历史记下来。stdin 不会。
 */
async function readPassword() {
  const arg = rest[0];
  if (arg) {
    console.error('⚠️ 密码是命令行参数传进来的——它会出现在 ps 与 shell 历史里。');
    console.error('   下次可以用：cat | npm run set-pass（或 echo 管道）');
    return arg;
  }
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

switch (cmd) {
  case 'set': {
    const password = await readPassword();
    if (!password) {
      console.error('✗ 没给密码。用法：npm run set-pass（从 stdin 读）');
      process.exit(2);
    }
    auth.setPassword(password);
    console.log('✓ 密码已设。服务**不用重启**——它会在 1 秒内自己发现（按文件 mtime）。');
    console.log(`  ⚠️ 已经有令牌的人不需要重新登录；要踢掉谁，用 npm run revoke -- <令牌>。`);
    break;
  }
  case 'revoke': {
    const token = rest[0];
    if (!token) {
      console.error('✗ 没给令牌。');
      process.exit(2);
    }
    console.log(auth.revoke(token) ? '✓ 已撤销' : '✗ 这个令牌本身就无效（或已过期）');
    break;
  }
  case 'status': {
    console.log(`数据目录：${DATA}`);
    console.log(`密码：${auth.needsSetup ? '❌ 没设 ⇒ 服务会 fail-closed（除三个公开路由外一律 503）' : '✓ 已设'}`);
    break;
  }
  default:
    usage();
    if (cmd) process.exit(2);
}
