// 探针的登录助手。
//
// 服务开了鉴权之后，所有验证工具都会先撞上登录页。与其用注入 localStorage 那种
// 脆招（shared_preferences 会把值 JSON 编码，注入原串读不出来），
// 不如**老老实实走一遍登录** —— 顺便每次都在验证登录这条路本身还能用。
//
// 口令来源：HUPO_PASSWORD 环境变量，或 /tmp/owner-pw.txt（本机临时存放）。

import fs from 'node:fs';

function ownerPassword() {
  if (process.env.HUPO_PASSWORD) return process.env.HUPO_PASSWORD;
  try {
    const t = fs.readFileSync('/tmp/owner-pw.txt', 'utf8');
    return t.match(/口令：(\S+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 如果停在登录页，就登进去。已经登录则什么都不做。 */
export async function ensureLoggedIn(page, { timeoutMs = 9000 } = {}) {
  const pw = ownerPassword();
  const H = page.viewportSize()?.height ?? 860;
  const fieldY = Math.round(H * 0.555);
  const btnY = Math.round(H * 0.615);

  // 判断是不是停在登录页：点一下输入框位置，看有没有出现可编辑的 input
  await page.mouse.click(Math.round((page.viewportSize()?.width ?? 420) / 2), fieldY);
  await page.waitForTimeout(600);
  const editable = await page.locator('input, textarea').first().count().catch(() => 0);
  if (!editable) return false; // 不在登录页
  await page.mouse.click(Math.round((page.viewportSize()?.width ?? 420) / 2), fieldY);
  await page.waitForTimeout(300);

  if (!pw) {
    console.log('⚠ 探针没拿到口令（设 HUPO_PASSWORD 或写 /tmp/owner-pw.txt），会停在登录页');
    return false;
  }
  await page.keyboard.type(pw, { delay: 20 });
  await page.mouse.click(Math.round((page.viewportSize()?.width ?? 420) / 2), btnY);
  await page.waitForTimeout(timeoutMs);
  return true;
}
