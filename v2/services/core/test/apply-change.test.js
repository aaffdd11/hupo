// P2 手动执行的验收：`apply-change.sh` / `rollback.sh` 到底有没有按 §三 的形态办事。
//
// 依据：手册 `06-OPERATIONS.md` §三（P2）· §8.1–8.3（回退与重启的硬要求）·
//       `04-ROADMAP.md` 批 6「P2 apply 工具」· `08-SPEC.md` §13.3 的 **V9**。
//
// ⚠️ 为什么这一份必须**在临时仓库里跑真脚本**，而不是断言脚本里的字符串：
//    §13.3 的 **V13** 说得很清楚 —— 把关键参数写死的旁路工具，绿的是工具不是产品。
//    这两个脚本的产物就是"仓库的历史"，只有真的在 git 上跑一遍，才知道它有没有留下 commit。
//
// ⚠️ 临时仓库里那份 `.gitignore` 是**从真仓库拷的**，不是现编的：
//    `proposals/` 被忽略是"干净闸"能成立的前提（申请文件本身不算未提交改动）。
//    拷过来，这条前提就跟着真仓库一起被验了。
//
// ⚠️ 全程 `HUPO_REPO=<临时目录>` 且 `HUPO_SKIP_RESTART=1`：
//    **绝对不碰真仓库**，也**不许在测试里把服务拉起来**。
//    git 身份写在临时仓库的局部配置里（并屏蔽全局/系统配置），换台机器也一样跑。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
// test/ → core/ → services/ → v2/ → 仓库根
const REPO_ROOT = nodePath.resolve(HERE, '..', '..', '..', '..');
const APPLY = nodePath.join(REPO_ROOT, 'scripts', 'apply-change.sh');
const ROLLBACK = nodePath.join(REPO_ROOT, 'scripts', 'rollback.sh');
const REAL_GITIGNORE = nodePath.join(REPO_ROOT, '.gitignore');

/** 屏蔽全局与系统 git 配置：测试的结果不该随这台机器的 gitconfig 变。 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function git(repo, ...args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')} 应该成功，实际：${r.stderr}`);
  return r.stdout;
}

/** 跑被验的脚本。**同步**跑：这几个脚本本身就是"做完就退出"的形态。 */
function run(repo, script, args = []) {
  return spawnSync('bash', [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...GIT_ENV, HUPO_REPO: repo, HUPO_SKIP_RESTART: '1' },
  });
}

/** 一个真 git 仓库，一个初始 commit，外加一份真 `.gitignore`。 */
function makeRepo({ withProposals = true } = {}) {
  const repo = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'hupo-p2-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Hupo Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  nodeFs.copyFileSync(REAL_GITIGNORE, nodePath.join(repo, '.gitignore'));
  nodeFs.writeFileSync(nodePath.join(repo, 'app.txt'), 'v1\n');
  if (withProposals) nodeFs.mkdirSync(nodePath.join(repo, 'proposals'), { recursive: true });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', '初始');
  return repo;
}

/** 临时目录用完就删；调用方放在 `finally` 里。 */
function dispose(repo) {
  nodeFs.rmSync(repo, { recursive: true, force: true });
}

/**
 * 在 `proposals/` 里造一份**真的能打上**的补丁（用 `git diff` 生成，不是手抄的）。
 * 造完把文件放回原样 —— 打补丁时仓库必须是干净的。
 */
function makePatch(repo, { name, relPath, after, note }) {
  const dir = nodePath.join(repo, 'proposals');
  nodeFs.mkdirSync(dir, { recursive: true });
  const target = nodePath.join(repo, relPath);
  const before = nodeFs.readFileSync(target, 'utf8');
  nodeFs.writeFileSync(target, after);
  const diff = git(repo, 'diff', '--', relPath);
  nodeFs.writeFileSync(target, before);
  const file = nodePath.join(dir, name);
  nodeFs.writeFileSync(file, note ? `${note}\n${diff}` : diff);
  return file;
}

const subjects = (repo) => git(repo, 'log', '--format=%s').trim().split('\n');
const porcelain = (repo) => git(repo, 'status', '--porcelain');
const content = (repo, rel) => nodeFs.readFileSync(nodePath.join(repo, rel), 'utf8');

test('干净应用：留下一个 commit、文件真的变了、补丁也留了档（V9）', () => {
  const repo = makeRepo();
  try {
    makePatch(repo, {
      name: 'greet.patch',
      relPath: 'app.txt',
      after: 'v2\n',
      note: '# 把问候语换成 v2',
    });
    const r = run(repo, APPLY, ['proposals/greet.patch']);

    assert.equal(r.status, 0, r.stderr);
    // V9：跑完必须留下一个 commit，而且**只多这一个** —— 多出来的都不叫"退回这一步"。
    const log = subjects(repo);
    assert.equal(log.length, 2, `应只多一个 commit，实际：${log.join(' | ')}`);
    assert.equal(log[0], 'apply: greet.patch（由主人在本机执行）');
    assert.equal(content(repo, 'app.txt'), 'v2\n');

    // 补丁本身进同一个 commit：log 里留下的不只是"结果"，还有主人当时看的那份东西。
    const files = git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
    assert.ok(files.includes('app.txt'), `改动应进 commit，实际提交了：${files.join(', ')}`);
    const archived = files.find(
      (f) => f.startsWith('docs/dev/applied/') && f.endsWith('greet.patch'),
    );
    assert.ok(archived, `补丁应留档到 docs/dev/applied/，实际提交了：${files.join(', ')}`);
    assert.equal(
      nodeFs.readFileSync(nodePath.join(repo, archived), 'utf8'),
      nodeFs.readFileSync(nodePath.join(repo, 'proposals', 'greet.patch'), 'utf8'),
      '留档的必须和主人看的那一份逐字相同',
    );

    // 补丁开头那行注释要进 commit 正文：三个月后翻 log 的人先看到"为什么"。
    assert.match(git(repo, 'log', '-1', '--format=%B'), /把问候语换成 v2/);
    assert.equal(porcelain(repo), '');

    // 后续步骤要短到主人愿意看，而且**重启是主人自己跑的那一行**。
    assert.match(r.stdout, /✅ 已应用并留下一个 commit：/);
    assert.match(r.stdout, /verify-integrity\.mjs --build/);
    assert.match(r.stdout, /scripts\/restart-core\.sh/);
  } finally {
    dispose(repo);
  }
});

test('没有 proposals/ 这个目录 ⇒ 拒绝，报错要说清往哪放', () => {
  const repo = makeRepo({ withProposals: false });
  try {
    const stray = nodePath.join(repo, 'stray.patch');
    nodeFs.writeFileSync(
      stray,
      'diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-v1\n+v2\n',
    );
    const r = run(repo, APPLY, [stray]);

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /proposals/, '报错必须点名 proposals/，不能让主人去猜 realpath 的意思');
    // 脚本自己什么都没动：唯一的变化是我们刚放进去、还没被跟踪的那份补丁。
    assert.equal(porcelain(repo), '?? stray.patch\n');
    assert.deepEqual(subjects(repo), ['初始']);
  } finally {
    dispose(repo);
  }
});

test('补丁在仓库里但不在 proposals/ ⇒ 拒绝，且什么都没改', () => {
  const repo = makeRepo();
  try {
    // 放在仓库根：这正是"主人看的那份"和"真正生效的那份"可能不是同一份的入口。
    const stray = nodePath.join(repo, 'stray.patch');
    nodeFs.writeFileSync(
      stray,
      'diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-v1\n+v2\n',
    );
    const r = run(repo, APPLY, [stray]);

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /proposals/);
    assert.equal(porcelain(repo), '?? stray.patch\n', '脚本自己不该动任何东西');
    assert.equal(content(repo, 'app.txt'), 'v1\n');
    assert.deepEqual(subjects(repo), ['初始']);
  } finally {
    dispose(repo);
  }
});

test('仓库里还有没提交的改动 ⇒ 拒绝；主人显式 --allow-dirty 才放行', () => {
  const repo = makeRepo();
  try {
    makePatch(repo, { name: 'greet.patch', relPath: 'app.txt', after: 'v2\n' });
    // 一件与补丁无关的脏改动：它会混进那个 commit ⇒ 拒绝正是为了保护"回退一次=退回这一步"。
    nodeFs.writeFileSync(nodePath.join(repo, 'other.txt'), '还没提交\n');

    const refused = run(repo, APPLY, ['proposals/greet.patch']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /allow-dirty/, '拒绝时要告诉主人怎么才能继续（他得自己签字）');
    assert.equal(content(repo, 'app.txt'), 'v1\n');
    assert.deepEqual(subjects(repo), ['初始']);

    const allowed = run(repo, APPLY, ['proposals/greet.patch', '--allow-dirty']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(content(repo, 'app.txt'), 'v2\n');
    assert.equal(subjects(repo).length, 2);
  } finally {
    dispose(repo);
  }
});

test('打不上的补丁 ⇒ 退出码非 0，且没有留下 commit', () => {
  const repo = makeRepo();
  try {
    // 手写一份上下文对不上的补丁：`--check` 必失败。
    nodeFs.writeFileSync(
      nodePath.join(repo, 'proposals', 'bad.patch'),
      'diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-这一行文件里没有\n+随便\n',
    );
    const r = run(repo, APPLY, ['proposals/bad.patch']);

    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /什么都没改/);
    assert.deepEqual(subjects(repo), ['初始'], '--check 没过就不许动仓库');
    assert.equal(content(repo, 'app.txt'), 'v1\n');
    assert.equal(porcelain(repo), '');
  } finally {
    dispose(repo);
  }
});

test('回退之后：文件回到原样，历史里有一个 revert commit', () => {
  const repo = makeRepo();
  try {
    makePatch(repo, { name: 'greet.patch', relPath: 'app.txt', after: 'v2\n' });
    assert.equal(run(repo, APPLY, ['proposals/greet.patch']).status, 0);
    assert.equal(content(repo, 'app.txt'), 'v2\n');

    const r = run(repo, ROLLBACK, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(content(repo, 'app.txt'), 'v1\n', '撤回了改动，文件要回原样');

    const log = subjects(repo);
    assert.equal(log.length, 3, `回退是新增一个 commit，不是抹掉历史：${log.join(' | ')}`);
    assert.match(log[0], /^Revert /);
    assert.match(r.stdout, /✅ 已回退：/);
    // 回退是救援路径：它替主人把服务拉回来（和 apply 相反，理由写在脚本头里）。
    assert.match(r.stdout, /▶ 重启服务/);
    assert.equal(porcelain(repo), '');
  } finally {
    dispose(repo);
  }
});

test('不给参数的回退 = 只回退最近一次，不碰更早的改动', () => {
  const repo = makeRepo();
  try {
    // 更早的一次改动：回退不许顺手把它也撤了。
    nodeFs.writeFileSync(nodePath.join(repo, 'note.txt'), '另一件事\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', '另一件事');
    makePatch(repo, { name: 'greet.patch', relPath: 'app.txt', after: 'v2\n' });
    assert.equal(run(repo, APPLY, ['proposals/greet.patch']).status, 0);

    const r = run(repo, ROLLBACK, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(content(repo, 'app.txt'), 'v1\n', '最近这一次要撤回');
    assert.equal(content(repo, 'note.txt'), '另一件事\n', '更早那一次要原样留着');

    const log = subjects(repo);
    assert.equal(log.length, 4);
    assert.match(log[0], /^Revert "apply: greet\.patch/);
    assert.equal(log[2], '另一件事');
    assert.equal(log[3], '初始');
  } finally {
    dispose(repo);
  }
});

test('指定某一次的回退：撤的是那一次，不是最近一次', () => {
  const repo = makeRepo();
  try {
    nodeFs.writeFileSync(nodePath.join(repo, 'note.txt'), '另一件事\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', '另一件事');
    const target = git(repo, 'rev-parse', 'HEAD').trim();
    makePatch(repo, { name: 'greet.patch', relPath: 'app.txt', after: 'v2\n' });
    assert.equal(run(repo, APPLY, ['proposals/greet.patch']).status, 0);

    const r = run(repo, ROLLBACK, [target]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(nodeFs.existsSync(nodePath.join(repo, 'note.txt')), false, '指定的那次被撤回');
    assert.equal(content(repo, 'app.txt'), 'v2\n', '最近那次要留着');
    assert.match(subjects(repo)[0], /^Revert "另一件事/);
    assert.equal(porcelain(repo), '');
  } finally {
    dispose(repo);
  }
});

test('回退撞上后面的改动 ⇒ 说清楚怎么手动收拾，且不留半途状态', () => {
  const repo = makeRepo();
  try {
    makePatch(repo, { name: 'greet.patch', relPath: 'app.txt', after: 'v2\n' });
    assert.equal(run(repo, APPLY, ['proposals/greet.patch']).status, 0);
    const applied = git(repo, 'rev-parse', 'HEAD').trim();
    // 后面又改了同一处 ⇒ 再回头撤那一次，git 不敢替主人决定（3 方合并撞车）。
    nodeFs.writeFileSync(nodePath.join(repo, 'app.txt'), 'v3\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', '再改一次');

    const r = run(repo, ROLLBACK, [applied]);
    assert.notEqual(r.status, 0);
    // 半途状态必须被撤干净：不然主人下一次不管做什么都踩在没结束的回退上。
    assert.equal(nodeFs.existsSync(nodePath.join(repo, '.git', 'REVERT_HEAD')), false);
    assert.equal(porcelain(repo), '', '失败之后仓库要和敲命令之前一样');
    assert.equal(content(repo, 'app.txt'), 'v3\n');
    assert.equal(subjects(repo)[0], '再改一次', '失败不许留下半个 commit');
    assert.match(r.stderr, /git revert --abort/, '要告诉主人怎么自己收拾');
  } finally {
    dispose(repo);
  }
});

test('只看用法：-h 打印用法，什么都不动', () => {
  const repo = makeRepo();
  try {
    const r = run(repo, APPLY, ['-h']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /用法/);
    assert.deepEqual(subjects(repo), ['初始']);
    assert.equal(porcelain(repo), '');
  } finally {
    dispose(repo);
  }
});
