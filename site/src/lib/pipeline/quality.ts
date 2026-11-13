import type { OutlinePlan, PageOutline, DeckSpecJson, PreviewSlide } from './types'

export interface QualityIssue {
  code: string
  severity: 'warning' | 'info'
  pages: number[]
  message: string
}
export interface OutlineQualityReport {
  score: number
  archetypeCount: number
  issues: QualityIssue[]
}
export interface RenderedPageMetrics {
  page: number
  elementCount: number
  textCount: number
  imageCount: number
  contentBottomRatio: number
  imageAreaRatio: number
}
export interface RenderedLayoutReport {
  score: number
  pages: RenderedPageMetrics[]
  issues: QualityIssue[]
}
export interface DeckQualityReport {
  score: number
  slideCount: number
  textElements: number
  imageElements: number
  chartElements: number
  tableElements: number
  issues: QualityIssue[]
}

const VISUAL_FALLBACK: Record<string, string> = {
  cover: '以标题和副标题建立主题，使用强弱层级与大面积留白，不堆叠信息卡片。',
  section: '用章节标题、短引导语和强烈色块建立叙事停顿，不放常规内容列表。',
  hero: '采用主标题与辅助视觉的非对称构图，形成一个明确视觉焦点。',
  content: '围绕一个结论组织少量证据，采用清晰标题、正文和重点强调。',
  editorial: '采用杂志式编辑布局，以一段主张配合侧栏注释或关键事实。',
  kpi: '用少量大数字形成视觉层级，每个指标配简短解释，避免重复卡片堆叠。',
  comparison: '建立明确的对照轴，左右内容必须可比较，最后给出结论。',
  process: '用步骤、阶段或因果关系形成连续阅读路径。',
  quote: '突出一句关键引述，来源和解释作为次级信息。',
  bento: '用不等权重的模块形成大小节奏，主模块明显大于辅助模块。',
  table: '用结构化表格承载精确比较，表前给结论，表后给解读。',
  chart: '用图表表达一个趋势或差异，标题写结论而非图表名称。',
  image: '让图片承担主要叙事，配简短标题和必要注释，图片必须与页面结论相关。',
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function countElements(elements: unknown[], type: string): number {
  let count = 0
  for (const item of elements) {
    if (!item || typeof item !== 'object') continue
    const element = item as { type?: string; children?: unknown[] }
    if (element.type === type) count++
    if (Array.isArray(element.children)) count += countElements(element.children, type)
  }
  return count
}

/** Deterministic outline audit. It reports weak planning without silently rewriting meaning. */
export function reviewOutlinePlan(plan: OutlinePlan): OutlineQualityReport {
  const pages = Array.isArray(plan.pages) ? plan.pages : []
  const issues: QualityIssue[] = []
  const templates = pages.map((page) => compact(page.template) || 'content')
  const archetypeCount = new Set(templates).size

  for (let index = 2; index < templates.length; index++) {
    if (templates[index] === templates[index - 1] && templates[index] === templates[index - 2]) {
      issues.push({
        code: 'REPEATED_ARCHETYPE_RUN',
        severity: 'warning',
        pages: [index - 1, index, index + 1],
        message: `第 ${index - 1}-${index + 1} 页连续使用 ${templates[index]} 原型，建议调整页面表达方式。`,
      })
    }
  }
  if (pages.length >= 8 && archetypeCount < Math.min(4, Math.ceil(pages.length / 5))) {
    issues.push({
      code: 'LOW_ARCHETYPE_DIVERSITY',
      severity: 'warning',
      pages: [],
      message: `整份大纲只有 ${archetypeCount} 种页面原型，叙事节奏可能单调。`,
    })
  }
  const messageMap = new Map<string, number[]>()
  pages.forEach((page, index) => {
    const message = compact(page.keyMessage).toLowerCase()
    if (message) messageMap.set(message, [...(messageMap.get(message) || []), index + 1])
    if (!compact(page.visualIntent)) issues.push({
      code: 'MISSING_VISUAL_INTENT', severity: 'info', pages: [index + 1],
      message: `第 ${index + 1} 页缺少明确视觉意图，规格生成阶段将使用原型默认构图策略。`,
    })
    if (page.template === 'image' && !compact(page.imageQuery)) issues.push({
      code: 'MISSING_IMAGE_QUERY', severity: 'warning', pages: [index + 1],
      message: `第 ${index + 1} 页为图片页，但没有提供场景检索词。`,
    })
    if (!compact(page.keyMessage)) issues.push({
      code: 'MISSING_KEY_MESSAGE', severity: 'info', pages: [index + 1],
      message: `第 ${index + 1} 页缺少一句话核心结论。`,
    })
  })
  for (const [message, matches] of messageMap) {
    if (matches.length > 1) issues.push({
      code: 'DUPLICATE_KEY_MESSAGE', severity: 'warning', pages: matches,
      message: `第 ${matches.join('、')} 页的核心结论重复。`,
    })
  }
  const deductions = issues.reduce((sum, issue) => sum + (issue.severity === 'warning' ? 9 : 2), 0)
  return { score: Math.max(0, 100 - deductions), archetypeCount, issues }
}

/** Build-stage audit measures the actual editable object mix, not only whether OOXML is valid. */
export function reviewDeckSpec(spec: DeckSpecJson, expectedPages: number): DeckQualityReport {
  const slides = Array.isArray(spec.slides) ? spec.slides : []
  const issues: QualityIssue[] = []
  let textElements = 0
  let imageElements = 0
  let chartElements = 0
  let tableElements = 0
  slides.forEach((slide, index) => {
    const elements = Array.isArray(slide.elements) ? slide.elements : []
    const count = (type: string) => countElements(elements, type)
    const text = count('text')
    const image = count('image')
    const chart = count('chart')
    const table = count('table')
    textElements += text
    imageElements += image
    chartElements += chart
    tableElements += table
    if (text === 0) issues.push({
      code: 'NO_TEXT_OBJECTS', severity: 'warning', pages: [index + 1],
      message: `第 ${index + 1} 页没有可编辑文字对象。`,
    })
    if (['chart', 'table', 'image'].includes(slide.template || '') && count(slide.template || '') === 0) {
      issues.push({
        code: 'ARCHETYPE_WITHOUT_CORE_ELEMENT', severity: 'warning', pages: [index + 1],
        message: `第 ${index + 1} 页标记为 ${slide.template}，但没有对应核心元素。`,
      })
    }
    if (text > 18 && image === 0 && chart === 0 && table === 0) issues.push({
      code: 'TEXT_HEAVY_PAGE', severity: 'warning', pages: [index + 1],
      message: `第 ${index + 1} 页包含 ${text} 个文字对象且缺少视觉元素，可能过于拥挤。`,
    })
  })
  if (slides.length !== expectedPages) issues.push({
    code: 'SLIDE_COUNT_MISMATCH', severity: 'warning', pages: [],
    message: `实际规格 ${slides.length} 页，预期 ${expectedPages} 页。`,
  })
  const deductions = issues.reduce((sum, issue) => sum + (issue.severity === 'warning' ? 12 : 0), 0)
  return {
    score: Math.max(0, 100 - deductions),
    slideCount: slides.length,
    textElements,
    imageElements,
    chartElements,
    tableElements,
    issues,
  }
}

/**
 * Audit the geometry actually emitted by the native layout engine.
 * Ratios use the real page dimensions; this is a deterministic geometry check,
 * not a substitute for human review of rendered typography and art direction.
 */
export function reviewRenderedLayout(
  layout: PreviewSlide[] | undefined,
  spec: DeckSpecJson,
  pageSize?: { width: number; height: number },
): RenderedLayoutReport {
  const pages: RenderedPageMetrics[] = []
  const issues: QualityIssue[] = []
  const width = Number(pageSize?.width) > 0 ? Number(pageSize?.width) : 13.333
  const height = Number(pageSize?.height) > 0 ? Number(pageSize?.height) : 7.5
  const pageArea = width * height
  const sparseSkip = new Set(['cover', 'section', 'quote', 'image', 'credits'])
  ;(layout || []).forEach((slide, index) => {
    const elements = Array.isArray(slide?.elements) ? slide.elements : []
    let bottom = 0
    let imageArea = 0
    let textCount = 0
    let imageCount = 0
    for (const element of elements) {
      const x = Number(element.x)
      const y = Number(element.y)
      const w = Number(element.w)
      const h = Number(element.h)
      if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
        bottom = Math.max(bottom, y + h)
        if (element.type === 'image') imageArea += w * h
      }
      if (element.type === 'text') textCount++
      if (element.type === 'image') imageCount++
    }
    const template = compact(spec.slides[index]?.template) || 'content'
    const contentBottomRatio = Math.round(Math.min(1, bottom / height) * 1000) / 1000
    const imageAreaRatio = Math.round(Math.min(1, imageArea / pageArea) * 1000) / 1000
    pages.push({
      page: index + 1,
      elementCount: elements.length,
      textCount,
      imageCount,
      contentBottomRatio,
      imageAreaRatio,
    })
    if (elements.length > 0 && !sparseSkip.has(template) && contentBottomRatio < 0.68) {
      issues.push({
        code: 'SPARSE_RENDERED_COMPOSITION',
        severity: 'warning',
        pages: [index + 1],
        message: `第 ${index + 1} 页实际元素只延伸到页面高度的 ${Math.round(contentBottomRatio * 100)}%，下半部可能过空。`,
      })
    }
    if (template !== 'image' && imageAreaRatio > 0.78) {
      issues.push({
        code: 'IMAGE_AREA_DOMINATES',
        severity: 'info',
        pages: [index + 1],
        message: `第 ${index + 1} 页图片占页面面积约 ${Math.round(imageAreaRatio * 100)}%，请确认文字仍有足够阅读空间。`,
      })
    }
    if (elements.length === 0) {
      issues.push({
        code: 'EMPTY_RENDERED_PAGE',
        severity: 'warning',
        pages: [index + 1],
        message: `第 ${index + 1} 页没有实际布局元素。`,
      })
    }
  })
  const deductions = issues.reduce((sum, issue) => sum + (issue.severity === 'warning' ? 12 : 3), 0)
  return { score: Math.max(0, 100 - deductions), pages, issues }
}

/** One shared composition contract is injected into both planning and spec prompts. */
export function compositionGuidance(page: PageOutline): string {
  const archetype = compact(page.template) || 'content'
  const base = VISUAL_FALLBACK[archetype] || VISUAL_FALLBACK.content
  const intent = compact(page.visualIntent)
  return intent ? `${base} 本页专项视觉意图：${intent}` : base
}
