# 参赛投稿（儿童人工智能大赛）

> 这一目录放的是**交出去的那一份文稿**，以及生成它的源文件。

| 文件 | 是什么 |
|---|---|
| **`琥珀-作品设计说明.pdf`** | ✅ **要交的就是这一份**（A4 · **9 页**）。**前半本**（封面 ＋ 第一部分）＝ **用最少的字讲清意义**：它是什么 / 给谁用 / 为什么值得做 / 它能做什么 / 跟常见助手不一样在哪 ＋ 一张真实桌面截图；**后半本**（第二部分 ＋ 附录）＝ **技术**：技术原理（三张结构图 ＋ 一节**跟豆包 / 元宝 / Codex 的对比**）· 实现过程 · 测试结果 · 安全考虑 · 创新点 · 不足与改进 · 演示步骤 · 名词解释 |
| `submission.html` | **源文件**（排版 + 全部正文都在里面；改文字改这一份，然后重新生成 PDF） |
| `images/desktop.png` | 文稿里的截图（线上真实桌面） |
| `design-note.md` | **内部素材稿**（给写材料用的家底：规则逐条对照、4 分钟演示脚本、评委四关注点怎么对齐、如实说）。**不是交上去的那一份** |

## 下载地址（线上）

**<https://w.stalkerai.cn/hupo-design-note.pdf>** —— 就是上面那份 PDF（`application/pdf`，点开就能读）。

⚠️ **只用这一个 ASCII 名字**：中文名的那个地址（`/琥珀-作品设计说明.pdf`）**实测在公网那段转发上会坏**
（前面那台 nginx 把百分号编码的路径弄丢 ⇒ 200 回来的是**页面**而不是文件）。本机直连是好的，
所以不是我们的路由问题；但"点了会返回页面"的链接比没有链接更坏 ⇒ **不摆它**。
（部署脚本每次会把这一份拷进静态根：`web/hupo-design-note.pdf`，因为 `deploy-web-v2.sh` 会重建那个目录。）

## 版式过了一遍 impeccable（2026-10-04）

用 [`pbakaus/impeccable`](https://github.com/pbakaus/impeccable) 那个检测器扫过这一份
（`node cli/bin/cli.js detect submission.html`）：**56 → 51 条**，真问题都改了
（箭头对比度 8 条清零 · 标题字距 · 破折号 19→6 · 去掉被它点名禁止的"左边一条色杠"的告示牌）；
剩下那 51 条是**两端对齐**（37，中文印刷的常态，故意留）与**行距**（14，复核下来像是它的单位换算问题，
最小例复现不出来）。顺带按同一套工艺底线改了：**独立封面页** · 版心收窄到 22mm · 七档字号阶 ·
**每页页码** · 表格隔行浅底。详见 [`dev/185`](../dev/185-IMPECCABLE-DOC-PASS.md)。

## ⚠️ 另有一份**按徐汇「雏鹰杯」规则**做的稿子（2026-10-04）

这一份（9 页）是**通用版**。区里那个比赛有**字数上限 3000 字**、**不许出现个人信息**、
**必须按"作品简介 / 设计制作过程 / 使用说明 / 创新点"四段**写 ⇒ 另出了一份
[`xuhui-2026/作品设计说明.pdf`](xuhui-2026/作品设计说明.pdf)（**2558 字**），
以及要交的五样材料清单与分工：[`xuhui-2026/README.md`](xuhui-2026/README.md)。

## 交之前要填的四处

封面上那四个空：**参赛作者 / 年级 / 学校 / 指导教师**，还有**日期**。
（另外：文中的措辞请按作者自己的口吻再顺一遍 —— 比赛的作品说明应当是作者的话。）

## 怎么重新生成 PDF

```bash
cd docs/contest
~/.cache/hupo-chrome/chrome/*/chrome-linux64/chrome \
  --headless=new --disable-gpu --no-sandbox --no-pdf-header-footer \
  --print-to-pdf="琥珀-作品设计说明.pdf" file://"$PWD/submission.html"
```

（本机没有系统 chrome；那个二进制是给浏览器检查那条路准备的，`~/.cache/hupo-chrome/` 底下。
打印时用的中文字体是系统自带的 Noto Sans CJK，不需要联网。）

## 文稿里写的每一个数字，出处都在仓库里

| 文稿里说的 | 出处 |
|---|---|
| 1513 条服务端判据 | `cd v2/services/core && npm test`（142 个判据文件） |
| 客户端三道硬闸 + 128 份界面判据 | `bash scripts/check-client.sh` |
| 线上就是仓库这一版 | `bash scripts/check-web-drift.sh` · `bash scripts/check-tenant-code-drift.sh` |
| 浏览器探针（1 条连接 / 202 帧 / 凭证续期） | `HUPO_TOKEN=… node scripts/check-web-browser.mjs --wait --shot …` |
| 199 份文档指针全对 | `node scripts/check-docs.mjs` |
| 开机完整性 220 个文件 | `node scripts/verify-integrity.mjs` · 清单在 `/etc/hupo/integrity.json` |
| 每台小主机 4 GiB / 三台在跑 | `docs/dev/00-PROGRESS.md` #271 那一条的实测读数 |
| V1.0 定档（tag 与两个产物指纹） | `docs/dev/180-V1-FREEZE.md` |

⚠️ **如实**：文稿里"在研 / 还没有"的那几件（手机上的语音输出、短信登录、iOS、性能优化）**就是还没做**，
写在 §八（不足与改进方向）里，没有冒充已完成。
