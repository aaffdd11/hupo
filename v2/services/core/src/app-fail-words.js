// **"这个小程序没做成"那一句人话**（主人 2026-09-26 的真机现场 ·
// 契约 `docs/dev/111-APP-LIVE-UPDATE.md` §六）。
//
// ── 为什么非有它不可（真机现场，原话）──────────────────────────
// `app_create` / `app_install` / `app_publish` 那几条工具回的都是
// **写给模型看的话**（`handleAppsOp` 那个 `{ok:false, error}`）。模型不转述，
// **主人那边一点提示都没有** —— 那一间的最后一句是
// 「压到 200KB、再转成文本就 266KB，超了单页 256KB 的上限。我试几种压法。」，
// 然后**没有然后了**：他不知道这件事停在哪、还要不要他做点什么。
//
// 🔴 **只说这张表里的话 ＋ 那个小程序的名字。**
//    工具那些 `error` 是给模型看的（里头有内部短名，还有"工作区"这种**禁用词**）
//    ⇒ **一个字都不许原样上屏**（`AGENTS.md` §六.4：界面上出现内部词 = 缺陷）。
//    ⇒ 所以这里是**分类 → 一句固定的话**：分类靠我们自己那几句错话里的关键词
//      （`apps.js` / `published.js`，同一个仓库里改它们就得回来对一次），
//      认不出来 ⇒ 兜底那几句（**宁可少说，也不许把原文端上去**）。
//
// ⚠️ **两种"没做成"不算失败、不喊**（见 `shouldTellAppFail`）：
//    它们是**要回头问他一句**的（助手会把话带回来），喊一条"没做成"就是**假话**。

/** 哪几条动作没做成时要说话。 */
export const APP_FAIL_OPS = Object.freeze(['create', 'install', 'publish']);

/**
 * **这两类不是"失败"，是"要问他一句"** ⇒ 不喊。
 *
 * * `needs-ask`（P1-22）：他本人没说要做 ⇒ 助手该回头问一句"要我做一个吗"。
 * * `needs-choice`（90 Q4.3）：他手里那份跟上边不一样 ⇒ 助手该回头问
 *   "刷新还是分叉"。**这时候说"没装成"是假话**（是等他拿主意）。
 */
export const APP_FAIL_QUIET_REFUSALS = Object.freeze(['needs-ask', 'needs-choice']);

/**
 * 这一次没做成，要不要**主动跟他说一句**。
 *
 * @param {object} o
 * @param {string} [o.op]      动作（`create` / `install` / `publish`）
 * @param {string} [o.refused] 服务端给的拒绝档（`needs-ask` / `needs-choice` …）
 */
export function shouldTellAppFail({ op, refused } = {}) {
  if (!APP_FAIL_OPS.includes(String(op ?? ''))) return false;
  if (APP_FAIL_QUIET_REFUSALS.includes(String(refused ?? ''))) return false;
  return true;
}

/** 那几句（**只有这一处**；`who` 就是"那个小程序"）。
 *
 * ★ **`114`：三条"太大/太多"分动作** —— 用户端（`create`）**这几条已经不该再出现**
 *   （他自己那一份不查上限）；它们今天只属于**发到市场那一步**（`publish`）＋
 *   从市场装来的包。所以发不出去的时候，话要说成"**发给大家的那一份**"，
 *   而不是"没能存下" —— 后者会让他以为**自己那份也没了**（那是假话）。
 */
const REASONS = Object.freeze({
  'file-too-big': (who, op) => (op === 'publish'
    ? `${who}要发给大家的那一份里有个东西太大了 —— 你自己那份照旧能用，要发的话先拆小一点。`
    : `${who}这一版没能存下：里头有一份东西太大了。拆小一点，我再来一次。`),
  'total-too-big': (who, op) => (op === 'publish'
    ? `${who}要发给大家的那一份整套太大了 —— 你自己那份照旧能用，要发的话先拆小一点。`
    : `${who}这一版没能存下：整套东西太大了。拆小一点，我再来一次。`),
  'too-many-files': (who, op) => (op === 'publish'
    ? `${who}要发给大家的那一份里份数太多了 —— 你自己那份照旧能用，要发的话先合掉几份。`
    : `${who}这一版没能存下：份数太多了。合掉几份，我再来一次。`),
  'too-many-versions': (who) => `${who}改的次数太多了，得先腾点地方 —— 你说一声我来收拾。`,
  empty: (who) => `${who}这一版是空的，没能存下。`,
  'entry-missing': (who) => `${who}这一版里没有那个开门的文件，没能存下。`,
  name: () => '这个名字我用不了 —— 换一个短一点的，我再来一次。',
  'name-taken': () => '这个名字已经有人用了 —— 换一个吧。',
  'not-mine': (who) => `你这儿还没有${who} —— 先做出来，再发。`,
  'not-shared': (who) => `大家那边还没有${who}，装不了。`,
  unpublished: (who) => `${who}已经下架了，装不了。`,
  tampered: (who) => `${who}那一版的内容跟登记的对不上，我没敢装。`,
  'no-snapshot': (who) => `装${who}之前没能给你手里那份留成底，所以我什么都没动。`,
  'not-allowed': (who) => `${who}要的那一项现在还不给，没能存下。`,
  review: (who) => `${who}这一版没能发给大家：有个检查它没过。`,
  declaration: (who) => `${who}没说清它要往外发什么，我没敢发。`,
  unknown: (who) => `${who}这次没成，我先停在这儿了。`,
});

/**
 * 这一句人话。
 *
 * ⚠️ **兜底分动作**（说得出"没存下 / 没装成 / 没发出去"，就比一句干巴巴的"失败了"强）。
 *
 * @param {object} o
 * @param {string} o.op      `create` / `install` / `publish`
 * @param {string} [o.title] 那个小程序的名字（**用户给的那个**；没有 ⇒ 不点名）
 * @param {string} [o.error] 工具那句（**只看关键词**，绝不原样上屏）
 * @param {string} [o.verdict] 评审结论（`pass` / `escalate` / `reject`）
 * @param {string} [o.refused] 拒绝档
 * @returns {string} 一句能上屏的人话
 */
export function appFailText({ op, title, error, verdict, refused } = {}) {
  const who = nameOf(title);
  const key = reasonOf({ op, error, verdict, refused });
  // 认不出原因 ⇒ **按动作兜底**（"没存下 / 没装成 / 没发出去"比一句"失败了"强）
  if (key === 'unknown') return appFailFallback({ op, title });
  const make = REASONS[key] ?? REASONS.unknown;
  return make(who, op);
}

/** 那个名字（没有 ⇒ 一句不点名的说法）。 */
function nameOf(title) {
  const t = typeof title === 'string' ? title.trim() : '';
  return t === '' ? '有个小程序' : `「${t}」`;
}

/**
 * 分类（**纯文字判断**）。
 *
 * ⚠️ 关键词抄的是 `apps.js` / `published.js` 里我们自己那几句错话 ——
 *    改那几句的人**要回来把这一份对一次**（`test/app-fail-words.test.js` 拿真错话钉着）。
 */
function reasonOf({ op, error, verdict, refused } = {}) {
  const e = typeof error === 'string' ? error : '';
  const r = String(refused ?? '');
  // ① **先看工具那句话里的关键词**（我们自己写的那几句，最具体）
  if (/外联|申报|出界|来路/.test(e)) return 'declaration';
  if (/你自己这儿还没有这个/.test(e)) return 'not-mine';
  if (/共享库里没有这一条|这一条不在共享库里/.test(e)) return 'not-shared';
  if (/已经下架/.test(e)) return 'unpublished';
  if (/单个文件太大/.test(e)) return 'file-too-big';
  if (/文件太多/.test(e)) return 'too-many-files';
  if (/整个制品太大/.test(e)) return 'total-too-big';
  if (/版本太多了/.test(e)) return 'too-many-versions';
  if (/一个文件都没有|那一版里一个文件都没有/.test(e)) return 'empty';
  if (/入口文件不在制品里|没有那个开门的文件/.test(e)) return 'entry-missing';
  if (/留个底/.test(e)) return 'no-snapshot';
  if (/这个名字已经被别人用了/.test(e)) return 'name-taken';
  if (/名字太长|名字不能是空的|要有一个名字|这个名字我用不了/.test(e)) return 'name';
  if (/权限现在还不给|权限不认识/.test(e)) return 'not-allowed';
  if (/对不上|被人动过/.test(e)) return 'tampered';
  // ② 再看服务端给的拒绝档
  if (r === 'no-apps' || r === 'no-app' || r === 'review-not-recorded'
      || r === 'needs-snapshot' || r === 'no-snapshot') {
    return r === 'needs-snapshot' || r === 'no-snapshot' ? 'no-snapshot' : 'review';
  }
  if (r === 'declaration' || r === 'outbound' || r === 'no-declaration' || r === 'forbidden-outbound') {
    return 'declaration';
  }
  // ③ 上架那一路**其余的拒绝**都是那次检查没过（`no-policy` / `reviewer-rejected` /
  //    `review-disagreement` / `no-operator-review` / `escalate` …）
  if (op === 'publish' && (r !== '' || (verdict !== undefined && verdict !== null))) return 'review';
  return 'unknown';
}

/**
 * 兜底那几句**分动作**的说法（认不出原因时用；比"失败了"强一点点）。
 *
 * ⚠️ 它只在"分类认不出"时有意义 —— 认得出来时走 `REASONS` 里那一句。
 */
export function appFailFallback({ op, title } = {}) {
  const who = nameOf(title);
  if (op === 'install') return `${who}没能装成，我先停在这儿了。`;
  if (op === 'publish') return `${who}这一版没能发出去，我先停在这儿了。`;
  return `${who}这一版没能存下，我先停在这儿了。`;
}
