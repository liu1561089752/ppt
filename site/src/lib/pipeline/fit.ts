/**
 * pipeline/fit.ts — 把排不下的一页**确定性地**收进画布
 *
 * 25 页真机跑出来的形态:内容量随页数线性增长,模型每页写 4-6 段,流程把文字一路往下排,
 * 引擎忠实写出 y=9.25in 的文字盒(画布只有 7.5in),交付时 40 条越界警告。
 *
 * 此前流程里只有两条修复路径,都不解决这个问题:
 *   - 交给模型整份重写:慢、贵,而且实测返回过 `requires path or data` 的非法 spec 被校验拒收;
 *   - 按页重写:同样可能引入新的越界,被回归判据回滚(实测 p2 OUT_OF_BOUNDS 连报两次)。
 *
 * 排不下是**算术问题**,不该靠模型猜。这里做两件确定的事,按优先级:
 *   ① 正文降一档字号(18→16→13→11),标题不动 —— 版面结构不变,只是密度变紧;
 *   ② 已经到下限还排不下,就摘掉优先级最低的叶子块(字号最小、位置最靠后的那一段)。
 * 只减不增、只删不加,所以永远不会产出一份非法 spec。
 */

/** 正文可用档位:降档时逐级往下挪,标题不参与(标题缩了会失去层级) */
const BODY_LADDER = [18, 16, 13, 11]
/** 标题类元素的最小字号:再挤也不能把标题压到和正文一样 */
const TITLE_FLOOR = 24

interface Node {
  type?: unknown
  text?: unknown
  fontSize?: unknown
  role?: unknown
  children?: Node[]
}

export interface FitResult {
  /** 实际动了多少处(0 表示已经无可再收) */
  changed: number
  /** 被收过的页码(1-based) */
  pages: number[]
  /** 人话摘要,写进日志/事件 */
  actions: string[]
}

function walk(elements: Node[], visit: (node: Node) => boolean | void): void {
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue
    if (visit(element) === false) continue
    if (Array.isArray(element.children)) walk(element.children, visit)
  }
}

function isTitle(node: Node): boolean {
  const role = String(node.role || '').toLowerCase()
  if (role === 'title' || role === 'heading' || role === 'kicker') return true
  return Number(node.fontSize) >= TITLE_FLOOR
}

/** 下一次字号:取比当前小的最近一档;已经到底返回 null */
function nextSmaller(size: number): number | null {
  const lower = BODY_LADDER.filter((step) => step < size)
  return lower.length ? lower[0] : null
}

/** 摘掉一页里"最不重要"的叶子文本块:优先字号最小的,同字号取最靠后的 */
function dropWeakestLeaf(elements: Node[]): boolean {
  let best: { list: Node[]; index: number; size: number } | null = null
  let textLeaves = 0
  const scan = (list: Node[]) => {
    list.forEach((element, index) => {
      if (!element || typeof element !== 'object') return
      if (Array.isArray(element.children) && element.children.length) {
        scan(element.children)
        return
      }
      if (element.type !== 'text') return
      textLeaves += 1
      const size = Number(element.fontSize) || 0
      if (size >= 16) return // 正文主体不删,只让注解类让位
      // 更小 = 更该让位;同字号取更靠后的那一段
      if (!best || size < best.size || (size === best.size && index > best.index)) {
        best = { list, index, size }
      }
    })
  }
  scan(elements)
  // 一页只剩一段文字时不许再删:那已经不是"让位",是把内容删没了
  if (!best || textLeaves <= 1) return false
  const found = best as { list: Node[]; index: number }
  found.list.splice(found.index, 1)
  return true
}

/**
 * 把指定页收进画布。每调用一次只收一档,调用方重建后再判断是否需要继续 ——
 * 这样"收多少"由引擎的真实几何决定,而不是靠猜一个倍数。
 */
export function fitPages(spec: { slides?: unknown }, pages: number[]): FitResult {
  const slides = Array.isArray(spec.slides) ? (spec.slides as { elements?: Node[] }[]) : []
  const result: FitResult = { changed: 0, pages: [], actions: [] }
  for (const page of pages) {
    const slide = slides[page - 1]
    if (!slide || !Array.isArray(slide.elements)) continue
    let touched = 0

    // ① 正文降一档
    walk(slide.elements, (node) => {
      if (node.type !== 'text') return
      if (isTitle(node)) return
      const size = Number(node.fontSize)
      if (!Number.isFinite(size) || size <= 0) return
      const smaller = nextSmaller(size)
      if (smaller === null) return
      node.fontSize = smaller
      touched += 1
    })

    // ② 已经到底还排不下,才摘叶子
    if (touched === 0 && dropWeakestLeaf(slide.elements)) {
      touched = 1
      result.actions.push(`p${page} 摘掉一段注解`)
    } else if (touched > 0) {
      result.actions.push(`p${page} 正文降档 ${touched} 处`)
    }

    if (touched > 0) {
      result.changed += touched
      result.pages.push(page)
    }
  }
  return result
}

// ── 反方向:内容太少就把这一页撑开 ──────────────────────────────────────────

/** 正文可放大的档位(与 BODY_LADDER 同一套刻度,只用到 22 为止:再大就不是正文了) */
const BODY_CEILING = 22
/** 标题最多放到这里:32pt 已是 13.33in 画布上的大标题,再大就变成海报 */
const TITLE_CEILING = 40

function nextBigger(size: number, ceiling: number): number | null {
  const steps = [11, 13, 16, 18, 22, 26, 28, 32, 36, 40]
  const bigger = steps.filter((step) => step > size && step <= ceiling)
  return bigger.length ? bigger[0] : null
}

/**
 * 把内容太少的页撑开。
 *
 * 25 页真机跑出来最普遍的缺陷不是越界,而是**下半屏空**:模型每页只写三四行,
 * 页面 7.5in 高、内容只排到 53-60%,像素判据报 CONTENT_STOPS_HIGH,视觉模型连着九页说
 * "下半部分大面积留白"。自检把问题报对了,但流程没有"填满"的动作 —— 只有"收进画布"。
 *
 * 这里做对称的一件事:把正文放大一档、标题放大一档,一档一档来,由调用方重建后用真实
 * 几何判断还空不空。只增不删、只改字号,不会产出非法 spec;放太大会越界,调用方会用
 * 引擎警告数把它回滚。
 */
export function expandPages(
  spec: { slides?: unknown },
  pages: number[],
  options: { growTitles?: boolean } = {},
): FitResult {
  const slides = Array.isArray(spec.slides) ? (spec.slides as { elements?: Node[] }[]) : []
  const result: FitResult = { changed: 0, pages: [], actions: [] }
  for (const page of pages) {
    const slide = slides[page - 1]
    if (!slide || !Array.isArray(slide.elements)) continue
    let touched = 0
    walk(slide.elements, (node) => {
      if (node.type !== 'text') return
      const size = Number(node.fontSize)
      if (!Number.isFinite(size) || size <= 0) return
      const title = isTitle(node)
      if (title && !options.growTitles) return
      const bigger = nextBigger(size, title ? TITLE_CEILING : BODY_CEILING)
      if (bigger === null) return
      node.fontSize = bigger
      touched += 1
    })
    if (touched > 0) {
      result.changed += touched
      result.pages.push(page)
      result.actions.push(`p${page} 放大 ${touched} 处`)
    }
  }
  return result
}
