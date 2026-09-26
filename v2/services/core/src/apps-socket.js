// 小程序那几条工具的**本地通道**（乙-2 · 契约 `docs/dev/59-USER-APPS.md` §二）。
//
// ── 它和账本那条是同一个形状（照抄它，别自创）────────────────
// 模型那一侧看到的是几条 MCP 工具，那些工具跑在**另一个进程**里（dsh 拉起的 stdio 服务器）。
// 那个进程**不许自己写盘** —— 校验、取版本号、落盘、审计全都要走**服务端这一个写入者**。
// ⇒ 两边之间要一条通道，就是这个。
//
// ── 为什么是 Unix domain socket ──────────────────────────
// MCP 那头唯一的传值口是配置里的 `env`，而 DSH 会把匹配 `/KEY|PASSWORD|SECRET|TOKEN/i`
// 的名字和所有 `DSH_*` **清洗掉** ⇒ 要传令牌就只能把令牌写进**仓库里那份配置**（破纪律）。
// 域套接字没有这个问题：**准入靠文件权限**（0600），没有秘密可以泄露。
//
// ⚠️ 它是**本机内部**的一条口（只在文件系统上、不听端口）。
// ⚠️ 协议是**一行一条 JSON**：`{op,…}` → `{ok,…}`；任何一条坏输入**只让那一条失败**。

import nodeFs from 'node:fs';
import nodeNet from 'node:net';
import nodePath from 'node:path';

import { AppsError } from './apps.js';
import { shouldTellAppFail } from './app-fail-words.js';
import { NEEDS_ASK, asksToMakeApp } from './apps-consent.js';
import { NEEDS_ASK_IMAGE, asksToDrawImage } from './image.js';
import { OutboundError, assertOutboundAllowed } from './outbound.js';
import { PublishedError, authorHashOf } from './published.js';
import { reviewForPublish } from './review.js';
import { handSocketToAgent } from './socket-owner.mjs';
import { USAGE_KINDS } from './usage.js';
import { mirrorArtifactIntoWorkspace, snapshotBeforeInstall, snapshotWorkspace, workspaceStat } from './workspace.js';

/** 小程序那条口放哪。**跟着那个人的目录走**（`<他那一格>/apps.sock`）。 */
export function appsSocketPath(dir) {
  return nodePath.join(dir, 'apps.sock');
}

/**
 * 一行最长多少。**它是内存防呆，不是"包"的上限**（那三道住 `apps.js` 的 `create()`）。
 *
 * ★ `114`：用户端**没有**尺寸上限（主人：*"所以不需要什么压缩"*）⇒ 这一条跟着抬起来
 *    （与 `apps-migrate.js` 那条同量级）。⚠️ 真正大的一份**不必走这一行**：
 *    助手写在那一间目录里的文件就是它（`files` 可以不给，见 `mcp-apps-server.mjs`）。
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * 把一条请求变成一条回答。**纯同步**（制品那套操作全是同步的）。
 *
 * ⚠️ 这里**只做能做的事**：`create` / `list`（还有 `rollback`，给以后用）。
 *    `publish` / `install` / `grant` 那几件**还没实现** ⇒ 这里给一句**明确的"还没做"**，
 *    **绝不许**回一个"成了"（那就是这个项目最忌的假话：工具说做完了、其实没做）。
 *
 * @param {import('./apps.js').Apps} apps
 * @param {object} req
 * @param {object} [ctx]  共享库与"这是谁"（发布/装上要它们）
 *   · `published`  共享库（`Published`）
 *   · `sub`        这是谁（**身份只从这里来**，绝不从请求里读）
 *   · `authorName` 他对外显示的名字（默认按哈希生成，**绝不显示手机号**）
 *   · `onInstalled(info)` 装上了 ⇒ 让他的桌面自己刷新（外面往流里推一条）
 *   · `turnInput()` **这一轮他自己说的那句话**（P1-22：造东西那条闸要看它）。
 *     🔴 它是**服务端自己记的**（`dispatcher.turnInput`），**绝不从请求里读**；
 *     没接线 ⇒ 当作"没有明说"（**fail-closed**，见 `apps-consent.js` 顶上）。
 *   · `workspace` **子工作区那一刀**（`AppWorkspaces` · 契约 `83-APP-WORKSPACE.md`）：
 *     造/装的时候由**服务端**建 `<dir>/workspaces/<scope>/` 并把产物落进去，
 *     制品库那一份是**从工作区读回来的快照**。没接线 ⇒ 老路照旧（不建工作区）。
 *   · `reviewPolicy` **产品层那份预审规则**（只读挂载＋指纹）；读不到 ⇒ 预审不自动放行。
 *   · `reviewAgent` **真跑预审的那个 agent**（`review-agent.js` 造的 DSH 评审；
 *     给了它就"真的调用一次模型"，而且那一次算力记到**这个 app** 头上，96 第 3 条）。
 *   · `operatorAgent` **运营方那一侧的复评**（宿主的 agent，96 第 1 条）：
 *     接了就独立再读一遍源码，与预审**对不上 ⇒ escalate**（`reviewForPublish`）。
 *   · `usage` **用量账**（`UsageLedger`）：预审消耗记进 `<id>/usage.jsonl`。
 *   · `onAppFailed(info)` ★ **这一次没做成 ⇒ 要有一条主人看得见的话**
 *     （主人 2026-09-26 真机现场 · 契约 `docs/dev/111-APP-LIVE-UPDATE.md` §六）：
 *     收到 `{op, id, title, error, verdict, refused}`。
 *     ⚠️ 只在 `shouldTellAppFail()` 说该说的时候叫 —— 那两档"要回头问他一句"
 *        的拒绝（`needs-ask` / `needs-choice`）**不算失败**，叫了就是假话。
 * @returns {object} 永远 `{ok:true,…}` 或 `{ok:false,error,…}`（**绝不抛**）
 */
export async function handleAppsOp(apps, req, ctx = {}) {
  const r = await runAppsOp(apps, req, ctx);
  // ★ **没做成 / 被拒 ⇒ 主动说一句**（见上面 `onAppFailed` 那段）。
  //   ⚠️ 它**不改判决**：说话失败不许把这次失败变成别的东西（原样把 `r` 还回去）。
  try {
    if (r?.ok !== true && shouldTellAppFail({ op: req?.op, refused: r?.refused })) {
      ctx.onAppFailed?.({
        op: req?.op,
        id: req?.id,
        // ⚠️ 名字优先取**制品里那一版**的（由调用方解析）；这里给的是请求里那个，
        //    它只有"新造一个但没成"时才用得上（那时候制品库里还没有它）。
        title: req?.app?.title ?? null,
        error: r?.error,
        verdict: r?.verdict,
        refused: r?.refused,
      });
    }
  } catch {
    /* 说一句人话失败，不许动判决 */
  }
  return r;
}

/**
 * 真正的那些动作（**一个 switch**）。
 *
 * ⚠️ 它**不导出**：外面看到的那条口是上面那个 `handleAppsOp` ——
 *     "没做成要说话"那一刀挂在那一个入口上，**任何调用方都漏不掉**
 *     （直接调这一份就会绕过它）。
 */
async function runAppsOp(apps, req, ctx = {}) {
  const op = req?.op;
  if (typeof op !== 'string') return { ok: false, error: '没说要做什么' };
  try {
    switch (op) {
      case 'create': {
        // ★ **他明说才许写**（P1-22）：造东西是"往他桌面上放一个他没要的东西"的唯一入口，
        //   所以闸装在**写盘之前**，而且看的是**他自己那一句话**（不是请求里带的任何字段）。
        //
        // 🔴 **按房间取"他那句话"**（2026-09-26 修 · 契约 `102` 落地时发现）：
        //   原来这里只问 `ctx.turnInput()` = **主线那一间**的当轮输入 ⇒
        //   他在**某个小程序的房间里**说"帮我做一个…"时，读到的是主线那份（多半是空的）
        //   ⇒ **误拒**。工具那侧把它这一轮在哪一间（`HUPO_APPS_SCOPE`）带在
        //   `req.scope` 上回来了 ⇒ 这里问**那一间**。
        //   ⚠️ 认不出那一间 / 取不到 ⇒ `null` ⇒ **拒**（fail-closed 不变）。
        const turnInput = typeof ctx.turnInputFor === 'function'
          ? ctx.turnInputFor(typeof req.scope === 'string' && req.scope.trim() !== '' ? req.scope.trim() : null)
          : (typeof ctx.turnInput === 'function' ? ctx.turnInput() : null);
        if (!asksToMakeApp(turnInput)) {
          return { ok: false, error: NEEDS_ASK, refused: 'needs-ask' };
        }
        const a = req.app ?? {};
        // ★★ **服务端那一刀**（契约 `83-APP-WORKSPACE.md` §三·4）：**服务端**把这一间
        //   建出来 ＋（给了内容就）落进去 —— 不靠模型记得建目录。
        //
        // 🔴 **`114`：用户端到这里就结束了 —— 只登记，不打成包。**
        //    主人 2026-09-26：*"所谓的版本快照，只在市场中存在。不在用户端。"*
        //    ⇒ 桌面点开的是**这一间工作区**（`/w/`，`112`），内容改了它自己就是新的；
        //      "压到 266KB > 单页 256KB"那堵墙**从这一刀起不存在**（那一套只属于"包"）。
        //    ⚠️ 老路（没接工作区那一刀：单测 / 旧部署）照旧走 `apps.create()`，一个字没变。
        let created;
        if (ctx.workspace) {
          const given = a.files && typeof a.files === 'object' && !Array.isArray(a.files)
            ? Object.keys(a.files).length
            : 0;
          ctx.workspace.ensure(a.id, { title: a.title, entry: a.entry });
          // ⚠️ **内容可以不在这儿给**：他（或者助手）在那一间目录里直接写文件就是**部署**
          //    （cwd 就是那一间）⇒ `files` 缺省 = "已经在里面了"。
          if (given > 0) ctx.workspace.write(a.id, a.files);
          const stat = workspaceStat(ctx.workspace, a.id);
          created = apps.register({
            id: a.id,
            title: a.title,
            icon: a.icon,
            // ⚠️ 入口以**工作区里真实存在的那个**为准（工作区可能不是模型刚交的那份）
            entry: a.entry ?? stat.entry ?? 'index.html',
            permissions: a.permissions ?? [],
            createdBy: 'agent',
            createdTurn: Number.isInteger(req.turn) ? req.turn : null,
            rootHash: stat.rootHash,
            bytes: stat.bytes,
          });
          // ★ **桌面自己长出来**（`app/installed` 是瞬态事件：客户端收到就重拉清单）。
          //   ⚠️ 它是瞬态的、不占号：所以顺手也把"这一间的内容变了"那条路留着
          //      （改了文件 ⇒ `app/workspace-changed`）—— 两条各管各的。
          try {
            ctx.onInstalled?.({ id: created.id, title: created.title });
          } catch {
            /* 喊不出去不许让"登记成了"这件事失败 */
          }
        } else {
          // ⚠️ **老路照旧**：没接工作区那一刀时（单测/旧部署）行为一个字不变。
          created = apps.create({
            id: a.id,
            title: a.title,
            icon: a.icon,
            entry: a.entry,
            files: a.files,
            permissions: a.permissions ?? [],
            createdBy: 'agent',
            createdTurn: Number.isInteger(req.turn) ? req.turn : null,
          });
        }
        const m = created;
        // ★ **这一轮真的造了一个 app**（A1·「发现就报」）：说给调度器听。
        //   ⚠️ 它只**记账**（那一轮里造过什么），报不报由调度器在收口时比主目录。
        //   ⚠️ 回调失败不许让"造出来了"这件事失败（东西已经在盘上了）。
        try {
          ctx.onAppBuilt?.({ id: m.id, title: m.title, op: 'create' });
        } catch {
          /* 记账失败不影响制品 */
        }
        // ⚠️ **`icon` 要带回去**（2026-09-23）：造它的人可能**没给图标**（或者给错了），
        //    而服务端会自动配一个 —— 那边得知道**最后配的是哪个**，才说得出一句实话
        //    （第一版漏了这个字段 ⇒ 工具回执会把 `undefined` 念给模型听）。
        return { ok: true, id: m.id, version: m.version, title: m.title, icon: m.icon, rootHash: m.rootHash };
      }
      // ── **画一张图**（P1-27 后半 · 主人 2026-09-24："图片需要打通"）──────────
      //
      // ⚠️ 它**借住**在小程序这条通道上：这条通道的形状正是"工具只递请求、动手的只有服务端"
      //    （`59-USER-APPS.md` §二）。⚠️ **为什么不新开一条**：能力层
      //    （`hupo-capabilities.yml`）是 **strict** —— 加一条 MCP 要主人重建开机清单
      //    ⇒ 先借住，**下次重建时再拆出去**（记在 `77-BLOCKERS.md`）。
      //
      // 🔴 **他明说才许生成**：判据只读**服务端自己记的当轮输入**（`ctx.turnInput()`），
      //    请求里写什么都不作数（与 `create` 那条同一个道理）。
      case 'draw': {
        const turnInput = typeof ctx.turnInput === 'function' ? ctx.turnInput() : null;
        if (!asksToDrawImage(turnInput)) {
          return { ok: false, error: NEEDS_ASK_IMAGE, refused: 'needs-ask' };
        }
        if (typeof ctx.drawImage !== 'function') return { ok: false, error: '这台部署还没接上画图那条路' };
        const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
        if (prompt === '') return { ok: false, error: '先写一句想要什么图。' };
        const r = await ctx.drawImage(ctx.sub, prompt);
        if (!r?.ok) return { ok: false, error: r?.text ?? '这次没画成，等会儿再试。' };
        // ★ **P2-3：画了几张也进那个账本**（一个账本三个计数器）。
        //   ⚠️ 归到**叫它画的那一间**（`req.scope` 由工具那侧带上；空 ⇒ 主线）。
        //     记不上账**不许**把这一张图弄没（`UsageLedger.note` 自己吞错）。
        const scope = typeof req.scope === 'string' && req.scope.trim() !== '' ? req.scope.trim() : 'main';
        ctx.usage?.note(scope, { kind: USAGE_KINDS.image, images: (r.urls ?? []).length, scopeId: scope });
        // ⚠️ 只回"画好了 + 图在哪"（**没有钥匙**）
        return { ok: true, urls: r.urls ?? [] };
      }
      case 'list':
        return { ok: true, apps: apps.list() };
      case 'rollback':
        return { ok: true, version: apps.rollback(req.id, req.version) };
      // ── 发布 / 下架 / 装上 / 看共享库（乙-3）────────────────
      case 'publish': {
        if (!ctx.published) return { ok: false, error: '这台部署还没开共享库' };
        // ★★ **`114`：发布 = 把"他正在改的那一间"打成一个包**（主人原话：
        //    *"a 推到市场，就是一个包"*）。
        //    🔴 **"包"的那三道上限（单文件 / 整版 / 文件数）从这一刀起才生效** ——
        //      用户端（他自己那一份）一个都不查。打不成 ⇒ 如实拒，
        //      而且**他那一份照旧能用**（与从前那种"存不下就等于没有"完全不同）。
        if (ctx.workspace && typeof ctx.workspace.has === 'function' && ctx.workspace.has(req.id)) {
          try {
            const stat = workspaceStat(ctx.workspace, req.id);
            const cur = apps.current(req.id);
            const curMan = cur === null ? null : apps.manifest(req.id, cur);
            // ⚠️ 工作区**一个文件都没有**（占位页被删了 / 还没写）⇒ **不重打**
            //    （那会把一个空目录打成一版；有包的那一份照旧发它自己）
            if (stat.files.length > 0 && (!curMan || curMan.rootHash !== stat.rootHash)) {
              // 与"装/升级前留底"同一个做法：从工作区读一份快照落进制品库（**查上限**）
              snapshotWorkspace({
                apps,
                workspaces: ctx.workspace,
                id: req.id,
                title: apps.meta(req.id)?.title ?? null,
                icon: apps.meta(req.id)?.icon,
                createdBy: 'user',
                createdTurn: Number.isInteger(req.turn) ? req.turn : null,
              });
            }
          } catch (err) {
            return {
              ok: false,
              refused: 'package-too-big',
              error: `要发给大家的那一份打不出来（${err?.message ?? err}）`,
            };
          }
        }
        // 🔴 **申报那条出界闸先跑**（92 §③ 阶段 2／98 §② 阶段 3 的硬规矩）：说不清来路的东西
        //    一份都不许出去。预审是**上架流程的第一步**，但它跑在这条**前置校验**之后
        //    —— 顺序是"先说清来路 → 再申报与评审"。
        //    ⚠️ `published.publish` 里还会再跑一次同一道闸（幂等，不是第二份逻辑）。
        assertOutboundAllowed({ route: 'publish', apps, workspaces: ctx.workspace ?? null, id: req.id });
        // ★ **预审 = 上架流程的第一步，自动跑**（96 第 4 条）。
        //   它按顺序：规则（产品层只读＋指纹）→ 申报（A16 · fail-closed）→ 代码扫描（R1／R2）
        //   → 用量（盒里日均 vs 申报量级）→ 评审 agent（真的那台 DSH；没接上 ⇒ 不自动放行）。
        //   结论**绑 `rootHash`** 落 `review.jsonl`（R5）；低风险自动放行、高风险找主人。
        //   ★ **运营方那一侧的复评**（96 第 1 条）：`ctx.operatorAgent` 接了就在预审过了之后
        //     独立再读一遍整份源码；两份对不上 ⇒ **escalate**（`reviewForPublish`）。
        //   🔴 拒的时候**共享库一个字节都不动**（预审跑在 `published.publish` 之前）。
        const rev = await reviewForPublish({
          apps,
          id: req.id,
          policy: ctx.reviewPolicy ?? null,
          preAgent: typeof ctx.reviewAgent === 'function' ? ctx.reviewAgent : null,
          operatorAgent: typeof ctx.operatorAgent === 'function' ? ctx.operatorAgent : null,
          usage: ctx.usage ?? null,
          turn: Number.isInteger(req.turn) ? req.turn : null,
        });
        if (!rev.allow) {
          return {
            ok: false,
            refused: rev.refused ?? rev.verdict,
            verdict: rev.verdict,
            review: rev.review ?? null,
            error: `${rev.words} —— 这一版没上架`,
          };
        }
        // 🔴 **出界那一条独木桥**（92 §③ 阶段 2）：`published.publish` 是共享库唯一的写入者，
        //    而它第一件事就是过 `outbound.assertOutboundAllowed`。这里把**这一间房**递过去
        //    （申报住 `<scope>/.exp/` 与 `<scope>/.data/`）—— 少了它，出界检查就只能按默认布局找了。
        //    ⚠️ `published.publish` 里还有**外联申报（A16）**那道闸（读不到 ⇒ 拒）。
        const r = ctx.published.publish(apps, {
          id: req.id,
          authorSub: ctx.sub,
          authorName: ctx.authorName,
          workspaces: ctx.workspace ?? null,
        });
        return { ok: true, id: r.id, version: r.version, title: r.title, verdict: rev.verdict };
      }
      case 'unpublish': {
        if (!ctx.published) return { ok: false, error: '这台部署还没开共享库' };
        const r = ctx.published.unpublish(req.id, ctx.sub);
        return { ok: true, id: r.id, published: false };
      }
      case 'install': {
        if (!ctx.published) return { ok: false, error: '这台部署还没开共享库' };
        // ★ **装／升级前的三件事**（90 Q4.3／Q4.5 · 89 §⑫ 说这是"最该先做的一件"）：
        //   ① **先拍工作区快照**（先于任何覆盖；拍不下来 ⇒ 不许装）；
        //   ② 工作区 hash ≠ 当前 `rootHash` ⇒ **他改过** ⇒ **不许静默覆盖**；
        //   ③ 二选一：**刷新**（用上游那份，旧版留档）／**分叉**（留他改的，记上游）——
        //      **默认分叉**（`req.mode` 缺省就是分叉那一侧：不覆盖）。
        //   🔴 反着验：没有快照就覆盖 ⇒ 红；默认那次安装把工作区改了 ⇒ 红。
        const mode = req.mode === 'refresh' ? 'refresh' : req.mode === 'fork' ? 'fork' : null;
        let snapshot = null;
        let changed = false;
        if (ctx.workspace && ctx.workspace.has(req.id)) {
          // ⚠️ 先记下"拍快照之前"指针那一版 —— 拍快照本身会移指针，晚一步就比不出来了
          const cur = apps.current(req.id);
          const curMan = cur === null ? null : apps.manifest(req.id, cur);
          // ① 🔴 **先拍快照，再动任何东西**
          try {
            snapshot = snapshotBeforeInstall({
              apps,
              workspaces: ctx.workspace,
              id: req.id,
              createdTurn: Number.isInteger(req.turn) ? req.turn : null,
            });
          } catch (err) {
            return {
              ok: false,
              refused: 'no-snapshot',
              error: `装之前先给你手里那份留个底，这一步没做成（${err?.message ?? err}）—— 所以什么都没动。`,
            };
          }
          // ② **改过没有**：工作区 hash 与当前那一版的 `rootHash` 一比就知道（两个 hash 同源）
          //    ⚠️ 空工作区（没有可丢的东西）不算"改过" —— 它连快照都没得拍
          changed = !snapshot.empty && (!curMan || curMan.rootHash !== snapshot.rootHash);
          if (changed && mode === null) {
            // ③ 默认（分叉侧）：**什么都不覆盖**，把两项摆给他看
            return {
              ok: false,
              refused: 'needs-choice',
              default: 'fork',
              options: ['refresh', 'fork'],
              snapshot: { version: snapshot.version, rootHash: snapshot.rootHash },
              error:
                '这个小程序你手里这份跟上游不一样了。直接装新的会把你的改动盖掉 —— 先说一声要哪种：'
                + '「刷新」= 用上游那份，你改的先留个底、随时能退回来；'
                + '「分叉」= 留着你改的这份，把上游那一版记下来。不说就按分叉办。',
            };
          }
        }
        const r = ctx.published.installInto(apps, req.id);
        const upstreamHash = apps.manifest(req.id, r.version)?.rootHash ?? null;
        const forked = changed && mode === 'fork';
        if (forked) {
          // ★ **分叉 = 记上游、留自己的**：上游那一版已经登记在制品库里（上面那一步），
          //   把指针拨回**你手里那份**（快照那一版），**工作区一个字节都不动**。
          //   边落 `hupo/apps/<id>/lineage.json`（登记，不写进不可变清单 —— 90 Q4.9）。
          try {
            apps.rollback(req.id, snapshot.version);
            apps.noteLineage(req.id, {
              kind: 'fork',
              baseRootHash: upstreamHash,
              baseVersion: r.version,
              myVersion: snapshot.version,
            });
          } catch (err) {
            return { ok: false, error: `上游那一版收下了，但分叉没记成：${err?.message ?? err}` };
          }
        } else if (ctx.workspace) {
          // ★ **刷新 / 没改过 / 新装**：把刚装好的那一版镜像进工作区。
          //   ⚠️ 读的是**制品库那一版**（不是共享库）：复制模型下它已经是他的了。
          try {
            mirrorArtifactIntoWorkspace({ apps, workspaces: ctx.workspace, id: r.id });
          } catch (err) {
            // ⚠️ 制品装上了、工作区没镜像成 —— **如实说**（别回一句"好了"让他们以为
            //    那间房里也有东西）。制品本身是好的，所以这不算整件事失败。
            return {
              ok: false,
              error: `装上了，但它那间工作区没建好：${err?.message ?? err}`,
            };
          }
        }
        // ★ 装上了 ⇒ **让他的桌面自己刷新**（流里推一条；客户端收到就重拉清单）
        //   ⚠️ 分叉那一路桌面上的东西**没变**（留的是他自己那份）⇒ 不喊"装上了"
        if (!forked) {
          try {
            ctx.onInstalled?.({ id: r.id, title: r.title });
          } catch {
            /* 推送失败不许让"装上"这件事失败（他下次开机也会拉到） */
          }
        }
        // ★ **装上来也算"这一轮造了一个 app"**（A1·「发现就报」）：
        //   装它的时候同样会在工作区之外写东西（一个图标 = 一个工作区，不分来源）。
        try {
          ctx.onAppBuilt?.({ id: r.id, title: r.title, op: 'install' });
        } catch {
          /* 同上：记账失败不影响制品 */
        }
        return {
          ok: true,
          id: r.id,
          version: r.version,
          title: r.title,
          forked,
          current: apps.current(r.id),
          snapshot: snapshot ? { version: snapshot.version, rootHash: snapshot.rootHash } : null,
        };
      }
      case 'discover': {
        if (!ctx.published) return { ok: false, error: '这台部署还没开共享库' };
        return { ok: true, apps: ctx.published.discover(), me: authorHashOf(ctx.sub ?? '') };
      }
      case 'uninstall': {
        // ★ **卸载**（乙-4）：🔴 **真回收**（决策 D3.11，契约 `docs/dev/103-APP-DELETE.md` §七）——
        //   `Apps.remove()` 是**唯一落点**：制品挪进 `.removed/`，另外三样（那一间的工作区、
        //   那条日志里 `scopeId==id` 的行、助手那边那一间的会话目录）一起搬走，
        //   并且记下被拿走的号（`reclaimed.json`，N22 的唯一例外）。
        //   ⚠️ **不是"删错了能拿回来"** —— 今天没有任何入口能把它装回来（B29）；
        //   工具那边说的话也照这条改过（`mcp-apps-server.mjs` 的 `app_uninstall`）。
        apps.remove(req.id);
        return { ok: true, id: req.id, removed: true };
      }
      case 'grant':
      case 'revoke': {
        // ★ **授予/撤权**（乙-4b）：`ask` 那条路已经通了（在**他自己的环境里**花）
        const want = apps.grants(req.id);
        const next = op === 'grant'
          ? [...new Set([...want, 'ask'])]
          : want.filter((p) => p !== 'ask');
        const kept = apps.setGrants(req.id, next);
        return { ok: true, id: req.id, permissions: kept };
      }
      default:
        return { ok: false, error: `认不出这条请求：${op}` };
    }
  } catch (err) {
    if (err instanceof AppsError || err instanceof PublishedError || err instanceof OutboundError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: `没做成：${err?.message ?? err}` };
  }
}

/** 那条口（听一个域套接字）。 */
export class AppsSocket {
  #apps;
  #path;
  #log;
  #server = null;
  #ready = null;
  #ctx;

  /**
   * @param {object} o
   * @param {import('./apps.js').Apps} o.apps
   * @param {string} o.socketPath
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ apps, socketPath, log = () => {}, ctx = {} }) {
    if (!apps) throw new AppsError('apps 必填');
    if (!socketPath) throw new AppsError('socketPath 必填');
    this.#apps = apps;
    this.#path = socketPath;
    this.#log = log;
    this.#ctx = ctx;
  }

  get path() {
    return this.#path;
  }

  /**
   * 开始听。
   * ⚠️ **先删旧的套接字文件**（上次没善终会留下它，而 `listen()` 撞上报的是 `EADDRINUSE`
   *    ——那句话看起来像"端口被占"）。
   * ⚠️ 权限 **0600**：准入就是它。
   */
  listen() {
    if (this.#server) return this;
    nodeFs.mkdirSync(nodePath.dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      nodeFs.unlinkSync(this.#path);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const server = nodeNet.createServer((conn) => this.#onConnection(conn));
    server.on('error', (err) => {
      this.#log(`[apps] 本地通道出错：${err?.message ?? err}`);
    });
    // ⚠️ 文件一出生就得是 0600（不能"先按 umask 建、回头再 chmod"：那个窗口里谁都能连）
    const prev = process.umask(0o177);
    try {
      server.listen(this.#path);
    } finally {
      process.umask(prev);
    }
    this.#ready = new Promise((resolve) => {
      server.once('listening', () => {
        try {
          nodeFs.chmodSync(this.#path, 0o600);
        } catch (err) {
          this.#log(`[apps] 本地通道权限没设上：${err?.message ?? err}`);
        }
        // 🔴 **盒子里还得把它交给 agent**：那边**服务是 root 起的、agent 是 uid 1000**，
        //    0600 且属主 root ⇒ agent 连不上（2026-09-24 真机复现：EACCES）。
        //    规则只住在 `socket-owner.mjs`；宿主上这条是空操作。
        handSocketToAgent(this.#path, { log: (m) => this.#log(`[apps] ${m}`) });
        resolve();
      });
    });
    this.#server = server;
    return this;
  }

  /** 通道真的开始听了（测试与启动用它**避免猜时机**）。 */
  ready() {
    return this.#ready ?? Promise.resolve();
  }

  close() {
    const s = this.#server;
    this.#server = null;
    return new Promise((resolve) => {
      if (!s) {
        resolve();
        return;
      }
      s.close(() => resolve());
    });
  }

  async #onConnection(conn) {
    let buf = '';
    conn.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_LINE_BYTES) {
        // 一行太长：**回一句再断开**（不许把内存吃光）
        conn.end(`${JSON.stringify({ ok: false, error: '这一行太长了' })}\n`);
        buf = '';
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let req = null;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(`${JSON.stringify({ ok: false, error: '这一行不是 JSON' })}\n`);
          continue;
        }
        // ⚠️ **一条坏输入只让那一条失败**（`handleAppsOp` 自己保证不抛）
        conn.write(`${JSON.stringify(await handleAppsOp(this.#apps, req, this.#ctx))}\n`);
      }
    });
    conn.on('error', (err) => this.#log(`[apps] 连接出错：${err?.message ?? err}`));
  }
}
