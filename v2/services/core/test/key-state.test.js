// **"这一台现在有没有钥匙"**（契约 `docs/dev/48-SETTINGS-KEY.md`）。
//
// ⚠️ 三条状态在客户端看来必须是**分得开**的 —— 今天之前 ① 和 ③ 一模一样，
//    于是配置那一屏只能对"填过但被拒"的人说"你还没填过"（那是假话）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { keyStateOf } from '../src/key-state.js';

test('① 还没填过 ⇒ hasKey:false、keyBad:false', () => {
  assert.deepEqual(keyStateOf({}), { hasKey: false, keyBad: false });
});

test('② 有钥匙：**两个来源取或**（宿主那本账会忘，容器说的才算）', () => {
  assert.deepEqual(keyStateOf({ hasKeyPushed: true }), { hasKey: true, keyBad: false });
  assert.deepEqual(keyStateOf({ hasKeyReported: true }), { hasKey: true, keyBad: false });
  // ⚠️ 这一条是那个真 bug 的落点：**宿主忘了、容器还拿着** ⇒ 仍然是"有"。
  //    少了它，宿主一重启就会再问用户要一次钥匙。
  assert.equal(keyStateOf({ hasKeyPushed: false, hasKeyReported: true }).hasKey, true);
});

test('③ 填过但被判无效 ⇒ hasKey:false **而且** keyBad:true（这才是"换一串就好"）', () => {
  assert.deepEqual(keyStateOf({ rejected: true }), { hasKey: false, keyBad: true });
  // 两处都记着"有"也一样：被判无效就是没有，而且要说出为什么
  assert.deepEqual(keyStateOf({ hasKeyPushed: true, hasKeyReported: true, rejected: true }), {
    hasKey: false,
    keyBad: true,
  });
});

test('⚠️ 坏输入不许被当成"有"（宽容解析往"没有"那一侧倒）', () => {
  assert.deepEqual(keyStateOf({ hasKeyPushed: 1, hasKeyReported: 'yes' }), { hasKey: false, keyBad: false });
  assert.deepEqual(keyStateOf(), { hasKey: false, keyBad: false });
  assert.deepEqual(keyStateOf({ rejected: 'true' }), { hasKey: false, keyBad: false }, '字符串不算');
});
