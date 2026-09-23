// **凭据文件那一小块**（`<HUPO_DATA>/creds.yaml`）：字段名、解析、合并、状态。
//
// ── 为什么单立成纯函数模块（只依赖 node 内置，连 fs 都不碰）────────
// 写这个文件的地方**不止一处**：
//   · 盒子里 `put-key.mjs`（人在容器里放一把）；
//   · 宿主经通道推给容器那一帧（`tenant-channel.mjs` → `tenant-shell.mjs`）。
// 而"哪六个名字算数""坏值怎么判"这条规则**只许住一处** ——
// 两处各写一份 = 迟早漂（这仓库的规矩：一条规则只住一处）。
//
// ── 文件格式 ──────────────────────────────────────────────
//   **一行一个 `名字: 值`**（现在实测就一行 `HUPO_MODEL_KEY: <key>`）。
//   🔴 **向后兼容**：老的 `HUPO_MODEL_KEY:` 那一行照旧读得出来。
//   ⚠️ 认不出的行**丢掉**（`parseCreds` 不抛）；`mergeCreds` 保留它们
//      （别的写入者写的行不许被抹掉）。
//   ⚠️ 值里**只许 ASCII 可打印字符**（`\x20`–`\x7e`）——
//      和 `/api/model-key` 那条路**同一条规矩**。
//
// ⚠️ 纯逻辑（`test/creds.test.js` 里逐条钉），不 import 任何别的 src 模块。

/** 六个字段：短名 ↔ `creds.yaml` 里的名字。**这层映射只住这一处**。 */
export const CRED_FIELDS = Object.freeze({
  model: 'HUPO_MODEL_KEY',
  image: 'HUPO_IMAGE_KEY',
  video: 'HUPO_VIDEO_KEY',
  voiceAppId: 'HUPO_VOICE_APPID',
  voiceSecretId: 'HUPO_VOICE_SECRET_ID',
  voiceSecretKey: 'HUPO_VOICE_SECRET_KEY',
});

/** 语音那三样：**三样齐了才算有**（缺一样就是没有）。 */
export const VOICE_FIELDS = Object.freeze(['voiceAppId', 'voiceSecretId', 'voiceSecretKey']);

/** 输出顺序（也是"哪一条写在最前面"）—— **语言那一把放最前**。 */
export const CRED_ORDER = Object.freeze(Object.keys(CRED_FIELDS));

const NAME_TO_FIELD = new Map(Object.entries(CRED_FIELDS).map(([field, name]) => [name, field]));
const KNOWN_NAMES = new Set(Object.values(CRED_FIELDS));

/** 认得出这个短名吗。 */
export function isCredField(field) {
  return typeof field === 'string' && Object.prototype.hasOwnProperty.call(CRED_FIELDS, field);
}

/** 短名 → 文件里的名字（认不出 ⇒ `null`）。 */
export function credNameOf(field) {
  return isCredField(field) ? CRED_FIELDS[field] : null;
}

/**
 * 值能不能收：**非空、且只有 ASCII 可打印字符**。
 *
 * ⚠️ 换行/中文/控制字符一律不许 —— 放进去就等于**把文件写坏**
 *    （一行一个的格式靠换行分家，而这一行还要被 `parseKey` 读成一把 key）。
 */
export function credValueOk(value) {
  return typeof value === 'string' && value.length > 0 && /^[\x20-\x7e]+$/.test(value);
}

/** 拆行（`\r\n` 也算；空行跳过）。**不抛**。 */
function linesOf(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .filter((l) => l.trim().length > 0);
}

/** 注释行（`#` 开头）—— 解析时跳过，合并时**原样留着**。 */
function isComment(line) {
  return line.trimStart().startsWith('#');
}

/**
 * `名字: 值` → `{name, field, value}`；**名字不是我们那六个** / 没冒号 ⇒ `null`。
 *
 * ⚠️ 名字认得、值空 ⇒ **仍然算这一行是我们的**（`value` 为 `''`）：
 *    不这么分的话，一个空的 `HUPO_MODEL_KEY:` 会被当成"别人的行"留着，
 *    再并一把进去就变成**两行同名**。
 */
function knownLineOf(line) {
  const i = line.indexOf(':');
  if (i <= 0) return null;
  const name = line.slice(0, i).trim();
  if (!KNOWN_NAMES.has(name)) return null;
  return { name, field: NAME_TO_FIELD.get(name), value: line.slice(i + 1).trim() };
}

/**
 * 逐行读成对象（**短名** → 值）。
 *
 * 🔴 **认不出的行丢掉、绝不抛**：这个文件可能被别的写入者碰过，
 *    也可能有半行残留 —— 为了一行坏话让整条路挂掉，比"少读一条"坏得多。
 *
 * @param {string} text
 * @returns {Record<string,string>} 只含认得出且非空的那些字段
 */
export function parseCreds(text) {
  const out = {};
  for (const line of linesOf(text)) {
    if (isComment(line)) continue;
    const kv = knownLineOf(line);
    if (!kv || kv.value.length === 0) continue;
    out[kv.field] = kv.value;
  }
  return out;
}

/**
 * 把若干字段并进去，**保留其它已有行**。
 *
 * @param {string} text  现在文件里那些字（读不到就给 `''`）
 * @param {Record<string,string>} patch  短名 → 值；**空值表示删掉那一行**
 * @returns {string} 新内容（一行一条，末尾带换行；一条都不剩就是 `''`）
 * @throws 值不是 ASCII 可打印字符时抛（**宁可不写，也不写坏**）
 */
export function mergeCreds(text, patch = {}) {
  for (const [field, value] of Object.entries(patch)) {
    if (!isCredField(field)) throw new Error(`认不出的字段名：${field}`);
    if (typeof value !== 'string') throw new Error(`字段 ${field} 的值要是字符串`);
    if (value.length > 0 && !credValueOk(value)) {
      throw new Error(`字段 ${field} 的值只能是 ASCII 可打印字符`);
    }
  }
  const touched = new Set();
  const out = [];
  for (const line of linesOf(text)) {
    const kv = isComment(line) ? null : knownLineOf(line);
    if (!kv) {
      // ⚠️ **不是我们管的行 ⇒ 原样留着**（别的写入者写的 / 注释，不许被抹掉）
      out.push(line);
      continue;
    }
    touched.add(kv.field);
    if (!Object.prototype.hasOwnProperty.call(patch, kv.field)) {
      // 空的 `NAME:` 归一成"没有这一条"（留着它再并一把进来就会变成两行同名）
      if (kv.value.length === 0) continue;
      out.push(`${kv.name}: ${kv.value}`);
      continue;
    }
    const next = patch[kv.field];
    if (next.length === 0) continue; // 空值 = 删掉这一行
    out.push(`${kv.name}: ${next}`);
  }
  // ★ **新字段按固定顺序补在后面**（语言那把放最前 —— `model-proxy` 的宽容解析先撞见它）
  for (const field of CRED_ORDER) {
    if (touched.has(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = patch[field];
    if (value.length === 0) continue;
    out.push(`${CRED_FIELDS[field]}: ${value}`);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/**
 * 给客户端的四个状态（图片 / 视频 / 语音各一把「现在有没有」）。
 *
 * ⚠️ `voice` = 三样**都**有才算有（《硬事实》：语音要 `HUPO_VOICE_APPID` +
 *    `HUPO_VOICE_SECRET_ID` + `HUPO_VOICE_SECRET_KEY` 三样）。
 *
 * @param {string} text
 * @returns {{model:boolean, image:boolean, video:boolean, voice:boolean}}
 */
export function credStatus(text) {
  const got = parseCreds(text);
  const has = (f) => typeof got[f] === 'string' && got[f].length > 0;
  return {
    model: has('model'),
    image: has('image'),
    video: has('video'),
    voice: VOICE_FIELDS.every(has),
  };
}
