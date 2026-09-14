/**
 * 品类树（Taxonomy）：domain → category → subcategory，叶子上挂经验。
 *
 * 对应你说的"次 agent 以后的大类和子类，这样就能区分成几百个"。
 * 继承规则：子类经验 → 父类（category）经验 → 领域（domain）经验 → 全局通用经验。
 */

/** 冷启动种子树：先给一个能用的骨架，真实对话中再自动长新叶。 */
export const SEED_TREE = {
  技术: {
    编程: ['调试排错', '架构设计', '代码审查', '性能优化', '依赖与部署', '测试策略'],
    数据: ['数据清洗', '指标口径', '统计分析', '可视化', 'SQL 查询'],
    工具: ['编辑器配置', '命令行', '自动化脚本', '版本控制'],
  },
  写作: {
    小说: ['剧情结构', '人物塑造', '伏笔回收', '文风模仿', '续写衔接'],
    文案: ['标题打磨', '卖点提炼', '平台适配', '长文改写'],
    公文: ['总结汇报', '邮件正式稿', '方案撰写'],
  },
  生活: {
    健康: ['睡眠', '饮食', '运动计划', '就医准备'],
    财务: ['预算规划', '记账口径', '大额决策'],
    家居: ['收纳整理', '维修处理', '采购比价'],
  },
  事务: {
    日程: ['排期冲突', '提醒设置', '会议准备'],
    沟通: ['冲突化解', '说服表达', '道歉与拒绝'],
    学习: ['学习路径', '资料筛选', '知识复盘'],
  },
  通用: {
    问答: ['概念解释', '方案对比', '决策建议'],
    情绪: ['倾诉陪伴', '焦虑缓解', '动力恢复'],
    元对话: ['助手用法', '能力边界', '纠错与反馈'],
  },
}

/** 品类树的运行时结构。 */
export class Taxonomy {
  constructor(tree = SEED_TREE) {
    /** @type {Map<string, {path: string, domain: string, category: string, subcategory: string, custom: boolean}>} */
    this.nodes = new Map()
    for (const [domain, categories] of Object.entries(tree)) {
      for (const [category, subs] of Object.entries(categories)) {
        for (const sub of subs) this.add(domain, category, sub, false)
      }
    }
  }

  /** 路径统一格式：domain/category/subcategory。 */
  static path(domain, category, subcategory) {
    return `${domain}/${category}/${subcategory}`
  }

  /** 登记一个叶子节点。 */
  add(domain, category, subcategory, custom = true) {
    const path = Taxonomy.path(domain, category, subcategory)
    if (!this.nodes.has(path)) this.nodes.set(path, { path, domain, category, subcategory, custom })
    return path
  }

  has(path) {
    return this.nodes.has(path)
  }

  /**
   * 归一化 Router 的输出。
   *
   * 为什么要做模糊匹配：实测中分类器会输出 `技术/后端开发/接口故障排查`（把握 0.95），
   * 而树里只有 `技术/编程/…`。若"不精确匹配就掉全局兜底"，等于把分类器的高把握判断
   * 整个丢掉，经验沉淀与复用链就全断了。所以按下面顺序逐级兜底，尽量保住语义：
   *   1. 精确命中叶子 → 直接用
   *   2. 精确命中大类 → 借该大类下第一个叶子承载（大类级经验）
   *   3. 领域名模糊匹配（互相包含即算命中）→ 借该领域下最相近的大类与叶子
   *   4. 全树按词面找最相近的大类 → 借用
   *   5. 都没有 → 全局兜底 `通用/问答/问答·通用`
   *
   * 2–4 都会回报 `proposed`（建议的新叶路径）与 `borrowed`，供品类树长新叶。
   */
  normalize(classification) {
    const { domain = '通用', category = '问答', subcategory } = classification ?? {}
    const wanted = Taxonomy.path(domain, category, subcategory ?? '通用')
    if (this.nodes.has(wanted)) {
      return { path: wanted, isNew: false, node: this.nodes.get(wanted), how: 'exact' }
    }

    const proposed = { domain, category, subcategory: subcategory ?? '通用' }
    const borrow = (node, how, parts = proposed) => ({
      path: node.path,
      isNew: true,
      proposed: wanted,
      proposedParts: parts,
      node,
      borrowed: true,
      how,
    })

    // 1) 大类精确命中（同领域同名）
    const sameCategory = [...this.nodes.values()].filter((n) => n.domain === domain && n.category === category)
    if (sameCategory.length) return borrow(sameCategory[0], 'category-exact')

    // 2) 大类名模糊命中（"后端开发" ↔ "编程" 这类同义/近义写法，靠词面重叠识别）
    const all = [...this.nodes.values()]
    const bestCat = fuzzyName(category, all.map((n) => n.category))
    if (bestCat) {
      const candidates = all.filter((n) => n.category === bestCat)
      const best = pickClosest(candidates, subcategory ?? '')
      return borrow(best, 'category-fuzzy', { domain: best.domain, category: bestCat, subcategory: subcategory ?? '通用' })
    }

    // 3) 领域已知但大类名对不上 → 在该领域内挑词面最相近的大类
    //    （实测常见：分类器说"后端开发"，树里是"编程"；只要领域对得上就不该掉到全局兜底）
    if (this.domains().includes(domain)) {
      const inDomain = all.filter((n) => n.domain === domain)
      const byScore = [...inDomain].sort(
        (a, b) => nameOverlap(b.category, category) - nameOverlap(a.category, category),
      )
      const bestCatNode = byScore[0]
      const pool = inDomain.filter((n) => n.category === bestCatNode.category)
      const best = pickClosest(pool, subcategory ?? '')
      return borrow(best, 'domain-known', { domain, category: bestCatNode.category, subcategory: subcategory ?? '通用' })
    }

    // 4) 领域名模糊命中
    const domainGuess = fuzzyName(domain, this.domains())
    if (domainGuess) {
      const inDomain = all.filter((n) => n.domain === domainGuess)
      if (inDomain.length) {
        const best = pickClosest(inDomain, category)
        return borrow(best, 'domain-fuzzy', { domain: domainGuess, category: best.category, subcategory: subcategory ?? '通用' })
      }
    }

    // 5) 全局兜底
    const globalFallback = Taxonomy.path('通用', '问答', '问答·通用')
    return {
      path: globalFallback,
      isNew: true,
      proposed: wanted,
      proposedParts: proposed,
      node: this.nodes.get(globalFallback),
      borrowed: true,
      how: 'global-fallback',
    }
  }

  /** 树里出现过的领域名。 */
  domains() {
    return [...new Set([...this.nodes.values()].map((n) => n.domain))]
  }

  /** 从叶子到根的路径链（用于经验继承）。 */
  lineage(path) {
    const node = this.nodes.get(path)
    if (!node) return []
    return [
      { level: 'subcategory', path },
      { level: 'category', path: Taxonomy.path(node.domain, node.category, '*') },
      { level: 'domain', path: `${node.domain}/*/*` },
      { level: 'global', path: '*/*/*' },
    ]
  }

  /** 导出可落盘的树结构。 */
  toJSON() {
    const out = {}
    for (const node of this.nodes.values()) {
      out[node.domain] ??= {}
      out[node.domain][node.category] ??= []
      out[node.domain][node.category].push(node.subcategory)
    }
    return out
  }

  get size() {
    return this.nodes.size
  }
}

/** 目标名与候选名的字符重叠度（0..1）。 */
function nameOverlap(candidate, target) {
  const c = String(candidate ?? '')
  const t = String(target ?? '')
  if (!c || !t) return 0
  const shared = [...new Set(c)].filter((ch) => t.includes(ch)).length
  return shared / Math.max(c.length, t.length)
}

/** 词面模糊匹配：候选里找一个与目标"互相包含"或字符重叠最多的名字。 */
function fuzzyName(target, candidates) {
  const t = String(target ?? '')
  if (!t) return null
  let best = null
  let bestScore = 0
  for (const candidate of new Set(candidates)) {
    if (!candidate || candidate === t) continue
    // 互相包含直接判定命中（"后端开发" 含 "开发"，"编程" 与 "后端开发" 靠字符重叠打分）
    const contains = candidate.includes(t) || t.includes(candidate)
    const shared = [...new Set(candidate)].filter((ch) => t.includes(ch)).length
    const score = (contains ? 1 : 0) + shared / Math.max(candidate.length, t.length)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  // 阈值：至少要有一定字符重叠，否则宁可走全局兜底
  return bestScore >= 0.5 ? best : null
}

/** 在一组叶子里挑与目标描述最相近的一个。 */
function pickClosest(nodes, text) {
  const t = String(text ?? '')
  let best = nodes[0]
  let bestScore = -1
  for (const node of nodes) {
    const shared = [...new Set(node.subcategory)].filter((ch) => t.includes(ch)).length
    const score = shared / Math.max(node.subcategory.length, 1)
    if (score > bestScore) {
      bestScore = score
      best = node
    }
  }
  return best
}
