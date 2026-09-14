// 前后对比：同一批问题，量整轮与结论到达时间
import { WebSocket } from 'ws';
const BASE='http://127.0.0.1:8091';
const questions=['最近老是失眠，躺下两小时睡不着','帮我看看这份周报的标题怎么改','每天下午特别困，是不是要补什么'];
for (const q of questions) {
  const conv='c_cmp_'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
  const t0=Date.now();
  const steps=[]; let firstText=null; let done=false;
  await new Promise((resolve)=>{
    const ws=new WebSocket(BASE.replace(/^http/,'ws')+`/api/stream?conversationId=${conv}&sinceSeq=0&dev=1`);
    ws.on('message',(raw)=>{const e=JSON.parse(raw.toString());
      if(e.type==='dev/step'&&e.status==='end'&&e.phase!=='turn') steps.push(`${e.phase} ${e.ms}ms`);
      if(e.type==='dev/step'&&e.status==='end'&&e.phase==='turn'){steps.push(`整轮 ${e.ms}ms`); if(!done){done=true;ws.close();resolve();}}
      if(e.type==='message/text'&&firstText===null&&e.text.trim()) firstText=Date.now()-t0;
      if(e.type==='task/created') steps.push('⏳变任务');
    });
    ws.on('open',async()=>{
      await fetch(`${BASE}/api/say`,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({conversationId:conv,text:q})});
      setTimeout(()=>{if(!done){done=true;ws.close();resolve();}},25000);
    });
  });
  console.log(`\n【${q}】`);
  console.log(`  ${steps.join(' | ')}`);
  console.log(`  第一句结论到达：${firstText?firstText+'ms':'（本轮没出结论，转任务了）'}`);
}
process.exit(0);
