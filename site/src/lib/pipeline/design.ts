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
  children?: AnyElement[]
}

export interface DesignReport {
  backgroundsLocked: number
  fontSizesRaised: number
  imagesInjected: number
  templatesDowngraded: number
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

/** 字号尺度:只升不降,保留相对层级 */
function liftedSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return size
  if (size >= 26) return Math.max(size, 32)
  if (size >= 20) return Math.max(size, 22)
  if (size >= 15) return Math.max(size, 18)
  if (size >= 12) return Math.max(size, 16)
  return Math.max(size, 11)
}

function hasImage(element: AnyElement): boolean {
  if (element.type === 'image') return true
  return (element.children || []).some(hasImage)
}

/**
 * 就地修正一份 deck 的背景/字号/图片,返回改动统计。
 * 图池按页序消费:同一张图不会在一份稿子里出现两次(用完即弃)。
 */
export function enforceDeckDesign(spec: unknown, images: DesignImage[] = []): DesignReport {
  const report: DesignReport = { backgroundsLocked: 0, fontSizesRaised: 0, imagesInjected: 0, templatesDowngraded: 0 }
  const deck = (spec || {}) as { slides?: unknown; theme?: { colors?: Colors } }
  const colors = deck.theme?.colors
  if (!colors) return report
  const slides = Array.isArray(deck.slides) ? (deck.slides as { template?: unknown; background?: unknown; elements?: AnyElement[] }[]) : []
  const pool = [...images]
  const usedPaths = new Set<string>()

  const walk = (element: AnyElement) => {
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

  for (const slide of slides) {
    const template = typeof slide.template === 'string' ? slide.template : 'content'

    // ① 背景锁回主题色板:模型自造的十六进制值一律丢弃(它不属于这套预设),
    //    模型在色板内做的明暗选择(比如章节页用 primary)则保留。
    if (!isThemeColor(slide.background, colors)) {
      slide.background = SECTION_TEMPLATES.has(template) ? colors.primary : colors.background
      report.backgroundsLocked += 1
    }

    // ③ image 页补图(在字号修正之前,让注入的 image 也走同一套元素树)
    const elements = Array.isArray(slide.elements) ? slide.elements : []
    slide.elements = elements
    if (template === 'image' && !elements.some(hasImage)) {
      const picked = pool.find((image) => !usedPaths.has(image.path))
      if (picked) {
        usedPaths.add(picked.path)
        elements.unshift({
          type: 'image',
          path: picked.path,
          credit: {
            subject: picked.caption,
            author: picked.author || 'Unsplash',
            licence: picked.licence || 'Unsplash License',
          },
        })
        report.imagesInjected += 1
      } else {
        // 没有可用图就别留着"图片页"占位
        slide.template = 'content'
        report.templatesDowngraded += 1
      }
    }

    // ② 字号抬到 PPT 尺度
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
