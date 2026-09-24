// **凭据文件那一小块**（`<HUPO_DATA>/creds.yaml`）：字段名、解析、合并、状态。
//
// ── 为什么单立成纯函数模块（只依赖 node 内置）──────────────────
// 写它的地方不止一处：盒子里 `put-key.mjs`（人在容器里放一把）、
// 宿主经通道推给容器那一帧、以及"配置页那四样"（主人 2026-09-24 定的）。
// 而"哪几个名字算数""坏值怎么判""按什么顺序写"这条规则**只许住一处** ——
// 两处各写一份 = 迟早漂。
//
// ── 主人 2026-09-24 定的四样（配置页就是配它）──────────────────
//   · **语言大模型**：一把 key（`HUPO_MODEL_KEY`）
//   · **语音大模型**：**三样齐了才算有**（`HUPO_VOICE_APPID/SECRET_ID/SECRET_KEY`）
//     —— 与识别路（`src/asr-creds.js` 的 `TENCENT_APPID/SECRET_ID/SECRET_KEY`）**同一组含义**
//   · **图片生成**：一把 key（`HUPO_IMAGE_KEY`）
//   · **视频生成**：一把 key（`HUPO_VIDEO_KEY`）
//
// ── 🔴 写下去的**顺序**是有讲究的（不是审美）────────────────────
// 盒子里那个读文件的函数（`model-proxy.js` 的 `parseKey`）在"这份文件像 YAML"时，
// 取的是**第一个名字里带 `KEY`/`TOKEN`/`SECRET` 的那一行**。
// ⇒ 把 `HUPO_VOICE_SECRET_KEY` 写在 `HUPO_MODEL_KEY` 前面，
//   **模型那一把就会被换成一把语音密钥**（现象是上游回鉴权失败，看日志完全看不出原因）。
// 两道防线：① 这里固定"**语言那一把最先写**"（[#CRED_ORDER]）；
//          ② `parseKey` 改成**先认名字**（`HUPO_MODEL_KEY` 在就一定是它）。
//
// ⚠️ 向后兼容：老的只有 `HUPO_MODEL_KEY:` 一行的文件照旧读得出来；
//    认不出的行**丢掉**（`parseCreds` 不抛），`mergeCreds` 则**保留**它们
//    （别的写入者写的行不许被我们抹掉）。
// ⚠️ 值里**只许 ASCII 可打印字符**（`\x20`–`\x7e`）—— 与 `/api/model-key` 那条路、
//    与 `put-key.mjs` 同一条规矩。

/** 短名 ↔ 文件里的名字。**这层映射只住这一处**。 */
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

/** 🔴 写下去的次序（**语言那一把最先** —— 理由见文件顶上那段）。 */
export const CRED_ORDER = Object.freeze(Object.keys(CRED_FIELDS));

/** 配置页上的四样（`/api/space` 就回这四个的存在与否）。 */
export const CRED_GROUPS = Object.freeze(['model', 'voice', 'image', 'video']);

const NAME_TO_FIELD = new Map(Object.entries(CRED_FIELDS).map(([field, name]) => [name, field]));

/** 认得出这个短名吗。 */
export function isCredField(field) {
  return typeof field === 'string' && Object.prototype.hasOwnProperty.call(CRED_FIELDS, field);
}

/** 短名 → 文件里的名字（认不出 ⇒ `null`）。 */
export function credNameOf(field) {
  return isCredField(field) ? CRED_FIELDS[field] : null;
}

/** 一"样"底下有哪几个字段（语音是三样）。 */
export function fieldsOfGroup(group) {
  if (group === 'voice') return [...VOICE_FIELDS];
  return isCredField(group) ? [group] : [];
}

/**
 * 值能不能收：**非空、且只有 ASCII 可打印字符**。
 *
 * ⚠️ 换行/中文/控制字符一律不许 —— 放进去就等于**把文件写坏**
 *    （一行一个的格式靠换行分家，而这一行还要被当成一把 key 发给上游）。
 */
export function credValueOk(value) {
  return typeof value === 'string' && value.length > 0 && /^[\x20-\x7e]+$/.test(value);
}

/** 拆行（`\r\n` 也算；空行跳过）。**不抛**。 */
function linesOf(text) {
  return String(text ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
}

/** `名字: 值` 这一行读出来的那一对（不是这种行 ⇒ `null`）。 */
function pairOf(line) {
  const i = line.indexOf(':');
  if (i <= 0) return null;
  const name = line.slice(0, i).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  return { name, value };
}

/**
 * 读这份文件。**不抛**。
 *
 * @returns {{values: Record<string,string>, unknown: string[]}}
 *   `values` 只含我们认得的六个名字；`unknown` 是**认不出的那些行**（原样留着用）。
 */
export function parseCreds(text) {
  const values = {};
  const unknown = [];
  for (const line of linesOf(text)) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    const p = pairOf(line);
    const field = p ? NAME_TO_FIELD.get(p.name) : null;
    if (p && field && credValueOk(p.value)) {
      values[field] = p.value;
      continue;
    }
    // ⚠️ 名字认得但**值坏了**（空、或有控制字符）⇒ 也算"认不出的行"：
    //    **不许**把空值当成"有"（那就是"页面说有、实际发出去是空的"那一类假话）。
    unknown.push(line);
  }
  return { values, unknown };
}

/**
 * 合并：**我们要写的字段换掉，别的行一个字节都不动**。
 *
 * ⚠️ 保留 `unknown` 是**刻意的**：这份文件可能还有别的写入者
 *    （例如老的 `HUPO_MODEL_KEY` 之外的东西）—— 我们只负责自己那六个名字。
 *
 * @param {string} text  现在盘上那份（可能为空）
 * @param {Record<string,string>} patch  短名 → 新值（`''`/`null` ⇒ 删掉那一行）
 * @returns {string} 新的全文（**末尾一定有换行**）
 */
export function mergeCreds(text, patch = {}) {
  const before = parseCreds(text);
  // ⚠️ **认不出的行原样留着**（别的写入者写的东西不许被我们抹掉），
  //    而我们那六个名字**从原位置拿掉、末尾按 `CRED_ORDER` 重排** ——
  //    这是那道"顺序"防线的落点：**旧文件里顺序错了，也在这儿被纠正**。
  const others = [];
  for (const line of linesOf(text)) {
    const p = pairOf(line);
    const field = p ? NAME_TO_FIELD.get(p.name) : null;
    if (field) continue; // 我们那六个：不在这儿留，末尾重排
    others.push(line);
  }
  const next = [];
  for (const field of CRED_ORDER) {
    const asked = Object.prototype.hasOwnProperty.call(patch, field);
    const v = asked ? patch[field] : before.values[field];
    if (!credValueOk(v)) continue; // 没给、或给了空 ⇒ 没有这一行
    next.push(`${CRED_FIELDS[field]}: ${v}`);
  }
  const body = [...others, ...next].join('\n').replace(/\n*$/, '');
  return `${body}\n`;
}

/**
 * 那四样**有没有**（配置页与 `/api/space` 只看这个，**永远不回值**）。
 *
 * @returns {{model:boolean, voice:boolean, image:boolean, video:boolean}}
 */
export function credStatus(values = {}) {
  return {
    model: credValueOk(values.model),
    // ⚠️ 语音：**三样齐了才算有**（缺一样就是没有 —— 只有 appid 发不出请求）
    voice: VOICE_FIELDS.every((f) => credValueOk(values[f])),
    image: credValueOk(values.image),
    video: credValueOk(values.video),
  };
}
