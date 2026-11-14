/**
 * pipeline/design.ts — 交稿前的"设计兜底"(确定性,不靠模型自觉)
 *
 * 三个真机问题换来的三段逻辑(2026-02,25 页真实生成实测):
 *
 * 1) **模型自造配色**:模型会在每页写 `background`(实测一份 25 页 deck 全页写成
 *    #12202B 深蓝 + 米色章节页),于是整份稿子脱离站点预设的视觉体系,看上去像
 *    另一个产品。这里把底锁回主题:章节页用 primary,其余用 background。
 *
 * 2) **字号文档化**:模型习惯给 12pt 正文。13.33×7.5 英寸的画布上 12pt 只占很小
 *    一块,页面显得空、显得"廉价"。这里把字号抬到 PPT 惯例尺度(只升不降,
 *    保留模型给的相对层级):≥26→32、≥20→22、≥15→18、≥12→16、其余→11。
 *
 * 3) **image 模板页没有图**:模型有时选了 image 原型却没给 image 元素,那页就只剩
 *    文字。这里从调研阶段已落盘的图池里补一张(带 credit);没有可用图时把模板
 *    退化成 content,不留一张"假图片页"。
 */

interface Colors {
  background: string
  surface: string
  foreground: string
  muted: string
  primary: string
  accent: string
  border: string
}

export interface DesignImage {
  /** 图库资产 ID(页面级绑定按它对齐;主题级候选可能没有) */
  id?: string
  path: string
  caption: string
  author?: string
  licence?: string
  pageUrl?: string
}

interface AnyElement {
  type?: string
  color?: unknown
  fontSize?: unknown
  bold?: unknown
  role?: unknown
  path?: unknown
  credit?: unknown
  fill?: unknown
  background?: unknown
  radius?: unknown
  children?: AnyElement[]
}

export interface DesignReport {
  backgroundsLocked: number
  fontSizesRaised: number
  imagesInjected: number
  templatesDowngraded: number
  /** 按页面绑定纠正的图片(模型选错图 / 漏选图) */
  imagesRebound: number
  /** 跨页重复使用的图片(改指未被占用的候选,或直接摘掉元素) */
  imagesDeduped: number
  /** 给了 fill 却没开 background 的卡片(引擎不会画它的底) */
  surfacesEnabled: number
}

/** 章节类模板:用主题的 primary 深底,与正文页形成明暗节奏 */
const SECTION_TEMPLATES = new Set(['section'])

function normalise(hex: unknown): string {
  return String(hex || '').trim().replace(/^#/u, '').toUpperCase()
}

/** 模型给的背景是否属于主题色板(不在色板里就是自造色) */
function isThemeColor(value: unknown, colors: Colors): boolean {
  const v = normalise(value)
  if (!v) return false
  return [colors.background, colors.surface, colors.primary, colors.foreground, colors.muted, colors.accent]
    .map(normalise)
    .includes(v)
}

/**
 * 字号尺度:只升不降,保留相对层级。
 *
 * **必须幂等** —— `liftedSize(liftedSize(x)) === liftedSize(x)`。这条不是洁癖:
 * 修复轮会把同一套兜底再跑一遍,如果 14pt→16pt 而 16pt 又会→18pt,那么"只修第 3 页"
 * 的一轮会顺手把所有正文页的字号再抬一格,几何随之改变,回归判据于是报"非目标页被改动",
 * 整轮修复被回滚 —— 真机上就是这样,自动修复一次都没成功过。
 * 所以每个档位的输出必须是本档位的固定点:12-17 一律 18,18 不再变。
 */
function liftedSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return size
  if (size >= 26) return Math.max(size, 32)
  if (size >= 20) return Math.max(size, 22)
  if (size >= 12) return Math.max(size, 18)
  return Math.max(size, 11)
}

function hasImage(element: AnyElement): boolean {
  if (element.type === 'image') return true
  return (element.children || []).some(hasImage)
}

/** 一页里所有 image 元素(含容器内的),带它所在的数组与下标,便于就地改写/摘除 */
interface ImageSlot {
  element: AnyElement
  siblings: AnyElement[]
  index: number
}

function collectImageSlots(elements: AnyElement[], out: ImageSlot[] = []): ImageSlot[] {
  elements.forEach((element, index) => {
    if (element?.type === 'image') out.push({ element, siblings: elements, index })
    if (Array.isArray(element?.children)) collectImageSlots(element.children, out)
  })
  return out
}

function creditOf(image: DesignImage): Record<string, string> {
  return {
    subject: image.caption || '配图',
    author: image.author || 'Unsplash',
    licence: image.licence || 'Unsplash License',
  }
}

/**
 * 就地修正一份 deck 的背景/字号/图片,返回改动统计。
 *
 * 图片按"页面绑定优先"落地(planPages[i].imageId = S3.5 页面级检索的结果):
 *   - 该页有绑定 → 图片元素一律改指绑定的那张(模型选错图/选了别的页的图都会被纠正)
 *   - 该页没绑定但原型是 image → 从池里取一张未占用的补上;池空则把原型降级成 content
 *   - 任何一张图在一份稿子里只能用一次:重复的改指未占用候选,池里没有了就摘掉元素
 *     (宁可少一张图,也不要在两页上放同一张照片)
 */
export function enforceDeckDesign(
  spec: unknown,
  images: DesignImage[] = [],
  planPages: Array<{ imageId?: string }> = [],
): DesignReport {
  const report: DesignReport = {
    backgroundsLocked: 0,
    fontSizesRaised: 0,
    imagesInjected: 0,
    templatesDowngraded: 0,
    imagesRebound: 0,
    imagesDeduped: 0,
    surfacesEnabled: 0,
  }
  const deck = (spec || {}) as { slides?: unknown; theme?: { colors?: Colors } }
  const colors = deck.theme?.colors
  if (!colors) return report
  const slides = Array.isArray(deck.slides) ? (deck.slides as { template?: unknown; background?: unknown; elements?: AnyElement[] }[]) : []
  const pool = images.filter((image) => image.path)
  const byId = new Map<string, DesignImage>()
  for (const image of pool) if (image.id) byId.set(image.id, image)
  const usedPaths = new Set<string>()

  const walk = (element: AnyElement) => {
    // 卡片底线:给了 fill / lineColor / radius 却没开 `background` 的容器,引擎一个像素都不画。
    // 模型经常只写 fill(提示词早期版本也这么示范),结果整份稿子看起来只有标题和散字。
    // 这一条不改设计意图:你说"这张卡要有底",那就把它画出来。
    if (element.type === 'container' && (element.background === undefined || element.background === null)) {
      const wantsSurface = element.fill !== undefined
        || (element.radius !== undefined && element.radius !== 0)
      if (wantsSurface) {
        element.background = true
        report.surfacesEnabled += 1
      }
    }
    if (element.type === 'text') {
      const size = Number(element.fontSize)
      if (Number.isFinite(size) && size > 0) {
        const lifted = liftedSize(size)
        if (lifted !== size) {
          element.fontSize = lifted
          report.fontSizesRaised += 1
        }
      }
    }
    ;(element.children || []).forEach(walk)
  }

  for (let pageIndex = 0; pageIndex < slides.length; pageIndex++) {
    const slide = slides[pageIndex]
    const template = typeof slide.template === 'string' ? slide.template : 'content'

    // ① 背景锁回主题色板:模型自造的十六进制值一律丢弃(它不属于这套预设),
    //    模型在色板内做的明暗选择(比如章节页用 primary)则保留。
    if (!isThemeColor(slide.background, colors)) {
      slide.background = SECTION_TEMPLATES.has(template) ? colors.primary : colors.background
      report.backgroundsLocked += 1
    }

    const elements = Array.isArray(slide.elements) ? slide.elements : []
    slide.elements = elements

    // ③ 页面绑定的图片优先(在补图之前:绑定本身就是"该用哪张图"的答案)
    const bound = planPages[pageIndex]?.imageId ? byId.get(planPages[pageIndex].imageId as string) : undefined

    // ② image 原型页没有图:用绑定的那张,否则从池里补一张未占用的
    if (template === 'image' && !elements.some(hasImage)) {
      const picked = bound && !usedPaths.has(bound.path)
        ? bound
        : pool.find((image) => !usedPaths.has(image.path))
      if (picked) {
        usedPaths.add(picked.path)
        elements.unshift({ type: 'image', path: picked.path, credit: creditOf(picked) })
        report.imagesInjected += 1
      } else {
        // 没有可用图就别留着"图片页"占位
        slide.template = 'content'
        report.templatesDowngraded += 1
      }
    }

    // ④ 绑定纠正 + 跨页去重
    const slots = collectImageSlots(elements)
    const dropped = new Set<ImageSlot>()
    for (const slot of slots) {
      const current = typeof slot.element.path === 'string' ? slot.element.path : ''
      if (bound && current && current !== bound.path) {
        slot.element.path = bound.path
        slot.element.credit = creditOf(bound)
        usedPaths.add(bound.path)
        report.imagesRebound += 1
        continue
      }
      if (!bound && current && usedPaths.has(current)) {
        const replacement = pool.find((image) => !usedPaths.has(image.path))
        if (replacement) {
          slot.element.path = replacement.path
          slot.element.credit = creditOf(replacement)
          usedPaths.add(replacement.path)
          report.imagesDeduped += 1
        } else {
          dropped.add(slot)
          report.imagesDeduped += 1
        }
        continue
      }
      if (current) usedPaths.add(current)
    }
    // 同一页内重复引用同一张图时,后来的那几处也摘掉(一页一张就够)
    const seenOnPage = new Set<string>()
    for (const slot of slots) {
      if (dropped.has(slot)) continue
      const path = typeof slot.element.path === 'string' ? slot.element.path : ''
      if (!path) continue
      if (seenOnPage.has(path)) {
        dropped.add(slot)
        report.imagesDeduped += 1
        continue
      }
      seenOnPage.add(path)
    }
    // 从后往前摘:下标不会因为删除而失效
    for (const slot of [...dropped].sort((a, b) => b.index - a.index)) {
      slot.siblings.splice(slot.index, 1)
    }

    // ⑤ 字号抬到 PPT 尺度
    elements.forEach(walk)
  }

  return report
}

/** 版面稀疏页(内容塌在页面上半部分) */
export interface SparsePage {
  page: number
  /** 内容底边占页高的比例(0-1),越小越空 */
  fill: number
  template: string
}

/**
 * 这些页不该垂直居中:正文页靠上对齐才符合阅读习惯(视线从标题往下走),
 * 而封面/章节/引语这类"一句话"页面居中才显得是有意留白,而不是忘了写内容。
 */
const BALANCE_TEMPLATES = new Set(['cover', 'section', 'quote', 'hero', 'credits'])
/** 居中后上下至少留这么多(英寸),否则宁可不动 */
const MIN_BALANCE_MARGIN = 0.45
/** 只有明显塌在上半屏的页才值得挪(否则改动只会引入抖动) */
const BALANCE_TRIGGER = 0.78

/**
 * 确定的垂直配平:把"一句话"页面的内容挪到版心中间。
 *
 * 引擎是流式排布,内容永远从 startY 往下摞 —— 于是封面常常是"标题贴顶 + 下半页空白"。
 * 这不是模型写错了内容,而是**几何**问题,不该再去让模型改内容;这里直接读第一遍
 * 构建的真实几何,算出内容高度,再改这一页的 `startY` 让它在页内居中。
 *
 * 只动 BALANCE_TEMPLATES、只动明显塌顶的页、只在挪完还剩足够页边距时动手。
 */
export function balancePageGeometry(
  spec: unknown,
  layout: unknown,
  pageSize?: { width?: number; height?: number },
): number {
  const deck = (spec || {}) as { slides?: Array<{ template?: unknown; startY?: number }> }
  const slides = Array.isArray(deck.slides) ? deck.slides : []
  const pages = Array.isArray(layout) ? (layout as Array<{ elements?: Array<{ y?: unknown; h?: unknown }> }>) : []
  const pageHeight = Number(pageSize?.height) > 0 ? Number(pageSize!.height) : 7.5
  let moved = 0
  pages.forEach((page, index) => {
    const slide = slides[index]
    if (!slide) return
    const template = String(slide.template || 'content')
    if (!BALANCE_TEMPLATES.has(template)) return
    const elements = Array.isArray(page?.elements) ? page.elements : []
    if (!elements.length) return
    let top = Number.POSITIVE_INFINITY
    let bottom = 0
    for (const element of elements) {
      const y = Number(element.y)
      const h = Number(element.h)
      if (!Number.isFinite(y)) continue
      top = Math.min(top, y)
      bottom = Math.max(bottom, y + (Number.isFinite(h) ? h : 0))
    }
    if (!Number.isFinite(top) || bottom <= top) return
    if (bottom / pageHeight > BALANCE_TRIGGER) return
    const height = bottom - top
    if (height > pageHeight - MIN_BALANCE_MARGIN * 2) return
    const target = (pageHeight - height) / 2
    const currentStart = Number.isFinite(Number(slide.startY)) ? Number(slide.startY) : top
    const delta = target - top
    if (Math.abs(delta) < 0.12) return
    slide.startY = Math.max(MIN_BALANCE_MARGIN, currentStart + delta)
    moved += 1
  })
  return moved
}

/** 这些模板本来就该"少字大图",不参与密度判定 */
const SPARSE_SKIP = new Set(['cover', 'section', 'quote', 'image', 'credits'])

/**
 * 从引擎的 layout 报告里挑出"内容只占上半屏"的页。
 * 判据:该页所有元素的最大下沿 < 页高 72%(7.5 英寸页 ≈ 5.4 英寸)。
 * 只用于触发"补内容"的修复轮,不直接改几何 —— 几何交给引擎,内容交给模型。
 */
export function sparsePages(layout: unknown, spec: unknown): SparsePage[] {
  const pages = Array.isArray(layout) ? (layout as Array<{ elements?: Array<{ y?: unknown; h?: unknown }> }>) : []
  const deck = (spec || {}) as { slides?: Array<{ template?: unknown }> }
  const slides = Array.isArray(deck.slides) ? deck.slides : []
  const pageHeight = 7.5
  const out: SparsePage[] = []
  pages.forEach((page, index) => {
    const template = String(slides[index]?.template || 'content')
    if (SPARSE_SKIP.has(template)) return
    const elements = Array.isArray(page?.elements) ? page.elements : []
    if (!elements.length) return
    let bottom = 0
    for (const element of elements) {
      const y = Number(element.y)
      const h = Number(element.h)
      if (!Number.isFinite(y)) continue
      bottom = Math.max(bottom, y + (Number.isFinite(h) ? h : 0))
    }
    const fill = bottom / pageHeight
    if (fill > 0 && fill < 0.72) out.push({ page: index + 1, fill: Math.round(fill * 100) / 100, template })
  })
  return out
}
