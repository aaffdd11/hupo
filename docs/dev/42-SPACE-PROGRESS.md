# 42 · 开空间要**能被用户看见进度**

> 主人 2026-09-21：*"创建 docker 空间要能够对用户展示进度。"*

## 一、🔴 先说清楚"进度"在这里是什么意思

项目有一条**硬规矩**：**不许假进度**（`38` §8.3 点名过 —— 没有百分比、没有"看着在动、
其实不知道到哪"）。主人要"看得见进度"，而这条规矩**不冲突**：

> **进度 = 把服务端真的知道的那几件事，如实摆给他看。**

所以我们**没有**做进度条、**一个百分号都没有**（判据在 `space_test.dart` 里，专门扫这个）。

## 二、那三步（**每一条都是真事实**）

| 步 | 名字 | 服务端凭什么知道 | 界面上那句话 |
|---|---|---|---|
| 1 | `assigned` | 租户表里有他（`tenantOf(userId)`） | 给你留好一台，只属于你 |
| 2 | `starting` | **那一台连上来了没有**（`channel.hasTunnel()` 真的知道） | 把它开起来 |
| 3 | `ready` | 同上（语义上是"可以用"） | 马上就好 |

界面：`✓ 做完了` / `… 正在做` / `· 还没轮到` —— **三个符号就够，没有数字**。

⚠️ **不给百分比的理由**：我们**不知道**"还要多久"（那取决于容器什么时候连上来）。
编一个数字就是"看着在动、其实不知道到哪"，**比诚实的一句更坏**。

## 三、顺手修掉的一条**安全相关**的判定

`SpaceInfo.fromJson` 原来把**认不出的 `state`** 当成 `ready`：

```dart
state: state == 'preparing' ? 'preparing' : 'ready',   // ❌ 别的一律当就绪
```

⇒ 新加的 `queued` / `starting` 会被当成**就绪** ⇒ **把人送进一个还没准备好的世界**。

改成**两条不同的路**（新的判据在 `space_test.dart`）：

| 情况 | 结果 | 为什么 |
|---|---|---|
| **缺 `state`**（老服务端） | **就绪** | 兼容那条纪律：不许把老用户挡在门外 |
| **给了 `state` 但不认识** | **不就绪** | 把人送进没准备好的世界更坏 |

## 四、还有一件**如实说**的

池子只有两台（`hupo-a`/`hupo-b`）⇒ 第 3 个号**没分到**。那不是"正在开"：

* 服务端回 `state: 'queued'`（**不是** `preparing`）；
* 界面说的是 **"前面还有人，得等一下：我们这边地方有限。"**

⚠️ 要放更多人 ⇒ **先把池子做大**（`scripts/create-tenant-pool.sh` 里加用户）。
这一条与 `41-SPECIAL-CODE.md` §四 是同一件事。

## 五、改了哪几处

| 处 | 改了什么 |
|---|---|
| `src/space-steps.js`（新） | `stepsFor(done)` —— **纯函数**，独立成文件是为了**能进 `test/unit`**（放 `serve.js` 里 import 会把整个服务跑起来） |
| `src/serve.js` | `tenantStatusOf` 带上 `steps`；`queued` / `starting` 两个新状态 |
| `lib/models/space.dart` | `SpaceStep` + `parseList`（**认不出的步丢掉，不许编**）+ 那条"给了 state 就照它算" |
| `lib/models/space_words.dart` | `spaceStepWords`（三步的人话）+ `waitingQueued` |
| `lib/screens/waiting_screen.dart` | 清单（✓/…/·）+ `queued` 那一句 |
| `lib/main.dart` | 把 `steps` / `queued` 递下去 |
