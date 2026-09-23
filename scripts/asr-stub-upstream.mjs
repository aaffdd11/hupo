#!/usr/bin/env node
// **假的上游 ASR**（腾讯云那台的替身）—— **只在取证时用**。
//
// 🔴 **它绝不许出现在生产环境里**：它是靠 `HUPO_ASR_URL` 这个环境变量挂上来的，
//    而那一条**只该在"我要验整条链"的时候**存在（真实部署里一个字节都不设）。
//    它说的话是**写死的**，所以看到它的输出就说明"这段字不是真识别的"。
//
// 为什么需要它：钥匙是主人的（`AGENTS.md` §六 第 1 条），而"等钥匙到了再验"
// = 这一批没有判据。有了它，**除了腾讯云自己那台**，每一环都是真的：
// 真浏览器、真 `getUserMedia`、真降采样、真二进制帧、真中继、真映射、真收尾。
//
// 协议形状照腾讯云那条（`docs/dev/69-ASR-ROUTES.md` §四·补）：
//   ① 连上先回握手 `{code:0, message:'success', …}`；
//   ② 收到音频 ⇒ 按字节数吐 `result.slice_type`（0 = 半句，1 = 一句话完）；
//   ③ 收到 `{"type":"end"}` ⇒ 吐 `slice_type:2` + `final:1` 收尾。
//
// 用法：`node scripts/asr-stub-upstream.mjs --port 8099 [--say 今天天气怎么样]`

import nodeProcess from 'node:process';
// ⚠️ `ws` 是 CommonJS ⇒ 只能默认导入（命名导入会在 ESM 里报 SyntaxError）
import wsPkg from '../v2/services/core/node_modules/ws/index.js';
const { WebSocketServer } = wsPkg;

const argv = nodeProcess.argv.slice(2);
const valueOf = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number.parseInt(valueOf('--port', '8099'), 10);
const SAY = valueOf('--say', '今天天气怎么样');

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
wss.on('listening', () => {
  console.log(`▶ 假上游听着 ws://127.0.0.1:${PORT}/（它只会说「${SAY}」，别拿它当真的）`);
});
wss.on('connection', (ws) => {
  let bytes = 0;
  let saidHalf = false;
  console.log('▶ 有人连上来了（说明签名那一跳被跳过了 —— 这是桩）');
  ws.send(JSON.stringify({ code: 0, message: 'success', voice_id: 'stub', message_id: 'stub' }));
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      bytes += data.length;
      // 收到约 1/3 秒音频就先吐半句（让"实时"那一段看得见）
      if (!saidHalf && bytes >= 16000) {
        saidHalf = true;
        const half = SAY.slice(0, Math.max(1, Math.floor(SAY.length / 2)));
        ws.send(JSON.stringify({ code: 0, result: { slice_type: 0, voice_text_str: half }, final: 0 }));
      }
      return;
    }
    if (String(data).includes('"end"')) {
      console.log(`▶ 收到收尾请求；一共收到 ${bytes} 字节音频（≈${(bytes / 32000).toFixed(1)} 秒）`);
      ws.send(JSON.stringify({ code: 0, result: { slice_type: 2, voice_text_str: SAY }, final: 1 }));
    }
  });
});
