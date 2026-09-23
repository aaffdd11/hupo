// **`creds.yaml` 的读写规则**（契约 `docs/dev/76-CREDS-TABS.md` §三）。
//
// 🔴 为什么单立一份判据：这份文件从 2026-09-24 起**不止一把钥匙**（语言 / 图片 / 视频 / 语音），
//    而它同时被**三个**写入者碰（中心推下来的、容器里的 `put-key`、宿主投递目录）。
//    ⇒ 两条最贵的规矩必须钉死：
//      ① **写入一律是合并**：只动点名的那一个字段，**别的行原样留着**
//         （分两次填，谁也不会把谁抹掉 —— 那是"填了图片就把语言弄没了"那种事故）；
//      ② **向后兼容**：老的一行 `HUPO_MODEL_KEY: …` 照旧读得出来、照旧是语言那把。
//
// ⚠️ 名字表（短名 ↔ `HUPO_*`）**只住在 `src/creds.mjs`** —— 别在判据里再抄一份（抄了会漂）。
//    所以下面一律用 `CRED_FIELDS` / `credNameOf` 取值，不写字面量。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CRED_FIELDS,
  VOICE_FIELDS,
  credNameOf,
  credStatus,
  credValueOk,
  isCredField,
  mergeCreds,
  parseCreds,
} from '../src/creds.mjs';

const N = (f) => credNameOf(f); // 那个字段在文件里叫什么名字

test('① 老格式（只有语言那一行）照旧读得出来 —— 向后兼容', () => {
  const text = `${N('model')}: sk-abc\n`;
  assert.deepEqual(parseCreds(text), { model: 'sk-abc' });
  assert.deepEqual(credStatus(text), { model: true, image: false, video: false, voice: false });
});

test('② 合并只动点名那一个字段，**别的行原样留着**（负向对照）', () => {
  const before = `${N('model')}: sk-abc\n`;
  const after = mergeCreds(before, { image: 'ark-1' });
  // 语言那把**不许**被抹掉 —— 这一条就是"填了图片就把语言弄没了"那个事故的回归条
  assert.match(after, new RegExp(`${N('model')}: sk-abc`), '语言那一行必须还在');
  assert.match(after, new RegExp(`${N('image')}: ark-1`));
  assert.deepEqual(parseCreds(after), { model: 'sk-abc', image: 'ark-1' });
});

test('②·补 认不出的行（别人的注释/别的写入者）也不许被吃掉', () => {
  const before = `# 手写的注释\n${N('model')}: sk-abc\nSOMETHING_ELSE: keep-me\n`;
  const after = mergeCreds(before, { video: 'v-1' });
  assert.match(after, /SOMETHING_ELSE: keep-me/, '别人的行不许被抹掉');
  assert.deepEqual(parseCreds(after), { model: 'sk-abc', video: 'v-1' });
});

test('③ 值给空 ⇒ 那一行**没了**（不是留一个空值）', () => {
  const before = mergeCreds('', { model: 'sk-abc', image: 'ark-1' });
  const after = mergeCreds(before, { image: '' });
  assert.deepEqual(parseCreds(after), { model: 'sk-abc' });
  assert.doesNotMatch(after, new RegExp(N('image')));
});

test('④ 语音要**三样齐**才算有（缺一样 ⇒ false）', () => {
  const full = mergeCreds('', { voiceAppId: '1', voiceSecretId: 'AKID', voiceSecretKey: 'sk' });
  assert.equal(credStatus(full).voice, true, '三样齐 ⇒ 有');
  for (const missing of VOICE_FIELDS) {
    const patch = { voiceAppId: '1', voiceSecretId: 'AKID', voiceSecretKey: 'sk' };
    delete patch[missing];
    const text = mergeCreds('', patch);
    assert.equal(credStatus(text).voice, false, `少了 ${missing} ⇒ 不算有`);
  }
});

test('⑤ 值里的非 ASCII / 换行**被拦住**（负向对照：不许写进文件）', () => {
  assert.equal(credValueOk('sk-abc-123'), true);
  assert.equal(credValueOk('钥匙'), false, '中文不是 key 能有的字符');
  assert.equal(credValueOk('sk-abc\nINJECT: 1'), false, '换行等于**往文件里注入一行**');
  assert.equal(credValueOk(''), false, '空值只在"删那一行"时有意义，不算一个值');
});

test('⑥ 坏行不抛、也不进结果（认不出来就当没有）', () => {
  const text = '没有冒号的一行\n: 没名字\nNO_COLON\n' + `${N('model')}: sk-abc\n`;
  assert.deepEqual(parseCreds(text), { model: 'sk-abc' });
});

test('⑦ 字段名：认得出的就那六个，别的一律不认（负向对照）', () => {
  assert.deepEqual(Object.keys(CRED_FIELDS).sort(), [
    'image',
    'model',
    'video',
    'voiceAppId',
    'voiceSecretId',
    'voiceSecretKey',
  ]);
  assert.equal(isCredField('model'), true);
  assert.equal(isCredField('banana'), false, '不认得的字段不许被当成语言那把');
  assert.equal(isCredField(''), false);
});
