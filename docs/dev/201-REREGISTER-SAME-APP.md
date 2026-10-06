# 201 · **"开发有点慢"** —— 同一间的"再登记"被"他明说才许写"拒了

> **主人原话**（2026-10-06 晚）：*「现在小程序开发过程有点慢。是不是最后的打包它没有完成？」*
>
> **先回答**：**没有"打包"卡住** —— 那个小程序（「奥数小站」）**早就做完了**：
> 工作区里有真内容、`building=false`、版本 2、助手 20:33:30 也说了「做完了」。
> **慢的是那两分半**，而且根子找到了。

---

## 一、真读数（他盒子里那一间的时间线，全部逐帧取出来的）

| 时刻 | 发生了什么 |
|---|---|
| 20:31:16 | 他在那一间里问：**「我做好了吗？冷吗」**（`user/echo`） |
| 20:31:37 | 助手调 `mcp__apps__app_create {id:'aoshu-grades-2', title:'奥数小站', icon:'school', entry:'index.html'}` —— 把**那一间已经有的那个小程序再登记一次**（同一个 id、不带内容） |
| 20:31:37 | 🔴 **被拒**：`needs-ask` ⇒ 回给模型的话是「这个我没动手：往你桌面上放东西，得你亲口说一句要什么……」 |
| 20:31:42–20:32:12 | **它掉头去读自己的源码**：`Find the gate message` ⇒ `/app/code/src/apps-consent.js` ⇒ `Inspect apps-socket scope handling and env` ⇒ `/app/code/src/apps-socket.js` ⇒ `Inspect dispatcher turn input recording` ⇒ `/app/code/src/dispatcher.js` ⇒ `/app/code/src/job.js` ⇒ `Find where turnInputFor is wired` ⇒ `Inspect worlds ctx wiring` |
| 20:33:30 | 才回一句「做完了。」 |

⇒ **那两分半全花在"查自己为什么被拒"**：不是打包慢，是一道闸把它自己的**收尾确认**拦了，
然后它开始自查（它读得懂那份源码 —— 产品层在它盒子里是只读挂着的）。

## 二、那一道闸为什么会拦

`apps-socket.js` 的 `create` 里那道 **`NEEDS_ASK`**（"他明说才许写"，P1-22）读的是
**当轮那句话**（`turnInputFor(scope)` 取的就是「我做好了吗？冷吗」）＋ 他最近说过的几句
（`askedRecently`，窗口很小）—— 那句里没有"做一个…" ⇒ 两道都不认 ⇒ 拒。

🔴 可那**不是**"往他桌面上放一个他没要的东西"：**那一格已经在他桌面上**（同一个 id）。
而且模型本来就能**直接写那一间工作区的文件**（那条路一个字都没闸）—— 卡这一刀既不一致、
也没有保护作用。

## 三、改法（一处、只放这一种）

```js
// 同一个 id、同一间 ⇒ 再登记不算"放新东西"，不需要"他明说"
const selfReRegister =
  scopeNow !== null && scopeNow !== 'main' && a.id === scopeNow && isAnAppRoom(apps, scopeNow);
if (!selfReRegister && !asksToMakeApp(turnInput) && !askedRecently(recent)) ⇒ needs-ask
```
（顺带把 `scopeNow` / `a` 的取值挪到那道闸**前面** —— 判据要用它们。）

⚠️ **只放这一种**：主线里造新东西、在**别的小程序**里造东西 ⇒ 照旧要"明说"。

**判据**（`test/app-create.test.js`）：同一间的再登记 ⇒ **过**；同一间里造**另一个** id ⇒
照旧 `inside-app`；**主线里**造新东西而他没明说 ⇒ 照旧 `needs-ask`。
**变异验证**：把 `selfReRegister` 钉成 `false` ⇒ 当场红（5 过 / 1 挂），还原即绿。

## 四、这一刀**没动**的（如实说）

1. **在某一间里要"另开一处"或造新东西** ⇒ 照旧被拒，助手会让他回桌面说一句
   （同一天 20:33:46 那次就是这样：`job_start` 从那一间发 ⇒ 「小程序房间里……派不出新活」）。
   那是定好的规矩（只有桌面那一层能开新的）—— **今天没动它**。
2. **助手"读自己源码"这个习惯**：它读得懂 `/app/code/src/*`（产品层在盒子里只读挂着，
   是我们有意这么做的）。这次它拿它去追一句拒绝的原因，花了两分半。
   那是**盒子里那个助手的行为**（人格/纪律那一层），不是这一刀的范畴 ⇒ **留给主人拍**
   （要么明说"别读自己的源码"，要么让它读、但在读之前先回答用户）。
