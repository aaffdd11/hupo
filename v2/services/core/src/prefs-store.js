// **跟着账号走的偏好**（主人 2026-10-04 定：*"壁纸不要按设备存"*）。
//
// ── 这一份解决什么 ────────────────────────────────────────
//   壁纸原来和"亮暗 / 字号"一样存在**设备**里（`SharedPreferences`，key `hupo_wallpaper`）⇒
//   换一台设备登录就回到默认那张暖纸。主人 2026-10-04 看到文稿里的截图问了这件事，
//   当场拍板：**壁纸跟着账号走**。
//
//   ⇒ 落点选**中心这份按人存档**，形状与 `creds-store.js` **逐条对齐**：
//     · 一个人一份文件（`<dataDir>/prefs/<sub>.json`，`0600`，原子写）；
//     · 文件名里的 `sub` **要洗**（它来自验签令牌，但"拿它拼路径"这件事本身必须自己再挡一道）；
//     · 坏文件 / 读不到 ⇒ **当"没记录"**（不许因此让谁打不开）。
//
// ⚠️ **为什么不在他盒子里**：盒子那条路是"整份重写"的另一套（见 `creds-store.js` 顶上那段），
//    而现在**只有界面**要读这一格（盒子里的东西没人问它）⇒ 放中心最省事、也不多开一趟隧道。
//    真要搬进盒子，那时是另一件事（判据里那条"按人分"照旧管用）。
//
// ⚠️ **它只装"界面自己挑的偏好"**：不认识的东西一律**不存**（见 `checkWallpaperId`）——
//    这一格不是"随便塞点什么都行"的袋子。

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/** 这一份存档放哪（**一个规则，只住这一处**）。 */
export function prefsDir(dataDir) {
  return nodePath.join(dataDir, 'prefs');
}

/** 某个人的那一份。**认不出的 `sub` ⇒ `null`**（同 `credsFileFor` 那条纪律）。 */
export function prefsFileFor(dataDir, sub) {
  if (typeof sub !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sub)) return null;
  return nodePath.join(prefsDir(dataDir), `${sub}.json`);
}

/**
 * **壁纸 id 认不认**：`''`（不设）或 `wp-<数字>`（客户端那 28 张就是 `wp-01`…`wp-28`）。
 *
 * ⚠️ **只认形状、不认范围**：`wp-29` 也收下（换一包壁纸时中心不必跟着改），
 *    客户端那一侧本来就"认不出来 ⇒ 回默认"（`models/wallpaper.dart` 那条纪律）。
 * ⚠️ 别的任何东西（对象 / 超长串 / `../../etc/passwd`）⇒ **`null`**（调用方如实回 400）。
 *
 * @returns {string|null} 归一化后的值；`null` = 不合法
 */
export function checkWallpaperId(v) {
  if (typeof v !== 'string') return null;
  if (v === '') return '';
  if (v.length > 16) return null;
  return /^wp-[0-9]{1,4}$/.test(v) ? v : null;
}

/**
 * 读某个人的偏好。读不到 / 坏了 ⇒ **`wallpaper: null`**（＝"这一格没记录过"）。
 *
 * 🔴 **`null` 与 `''` 是两件事**：`''` = 他明确选了"不设（默认那张纸）"；
 *    `null` = 我们从没记过 ⇒ 客户端要拿**本机那份**顶上去（老用户升级上来的那一下，
 *    不然他设备上挑过的壁纸会被"没记录"抹成默认）。
 *
 * @returns {{wallpaper: string|null, updatedAt: number|null}}
 */
export function readUserPrefs(dataDir, sub, fs = nodeFs) {
  const empty = { wallpaper: null, updatedAt: null };
  const file = prefsFileFor(dataDir, sub);
  if (!file) return empty;
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return empty; // 没有 / 读不懂 ⇒ 没记录（不抛）
  }
  if (!j || typeof j !== 'object') return empty;
  const w = checkWallpaperId(j.wallpaper);
  if (w === null) return empty;
  const at = Number.isFinite(j.updatedAt) ? j.updatedAt : null;
  return { wallpaper: w, updatedAt: at };
}

/**
 * 写。（**原子写 ＋ 0600**：先写 `.tmp` 再 `rename` —— 与 `writeUserCreds` 同一个道理。）
 *
 * @returns {{ok:boolean, why:string, prefs:{wallpaper:string|null,updatedAt:number|null}}}
 */
export function writeUserPrefs(dataDir, sub, patch = {}, { fs = nodeFs, now = Date.now } = {}) {
  const file = prefsFileFor(dataDir, sub);
  if (!file) return { ok: false, why: 'bad-sub', prefs: { wallpaper: null, updatedAt: null } };
  const w = checkWallpaperId(patch.wallpaper);
  if (w === null) {
    return { ok: false, why: 'bad-wallpaper', prefs: readUserPrefs(dataDir, sub, fs) };
  }
  const next = { wallpaper: w, updatedAt: now() };
  try {
    fs.mkdirSync(prefsDir(dataDir), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, why: `write-failed:${err?.code ?? 'unknown'}`, prefs: readUserPrefs(dataDir, sub, fs) };
  }
  return { ok: true, why: 'ok', prefs: next };
}
