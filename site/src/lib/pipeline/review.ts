/**
 * pipeline/review.ts — 逐页问题的统一账本
 *
 * 三个来源的结论**分开记录**,绝不混成一个分数(几何分不能冒充审美分):
 *   geometry — 引擎 `--layout-out` 的真实盒子:溢出、重叠、贴边、字号过小、对比度
 *   pixels   — 渲染出来的图:整页发白、内容塌在上半屏、纯色板
 *   vision   — 视觉模型的审美判断:重心、层级、拥挤、图文关系(未配置时为空)
 *
 * 输出 `PageProblem[]`,`page` 是 1-based 页码,供"只改问题页"的修复轮使用;
 * `fingerprintPages()` 用来验证修复没有顺手改坏其它页。
 */
import type { DeckSpecJson, PreviewSlide } from './types'
import { contrastRatio } from './contrast'

export type ProblemSource = 'geometry' | 'pixels' | 'vision'

export interface PageProblem {
  page: number
  code: string
  severity: 'warning' | 'info'
  detail: string
  source: ProblemSource
  /** 给模型的可执行修法(不写坐标,只写内容与结构层面的动作) */
  advice?: string
}

/** 渲染图度量(preview_deck.py 出的 PNG 经 render_metrics.py 量出来的) */
export interface PagePixelMetrics {
  page: number
  file?: string
  width?: number
  height?: number
  background?: string
  ink_ratio?: number
  ink_rows_ratio?: number
  content_bottom_ratio?: number
  bottom_band_ink_ratio?: number
  distinct_colours?: number
}

/** 引擎 layout 里的盒子(与 PreviewElement 同形,只取算分需要的字段) */
interface Box {
  type: string
  x?: number
  y?: number
  w?: number
  h?: number
  text?: string
  fontSize?: number
  color?: string
  fill?: string | null
}

const DEFAULT_WIDTH = 13.333
const DEFAULT_HEIGHT = 7.5
/** 正文字号下限:13.33in 宽画布上 10pt 已经很难看清,9pt 基本是错 */
const TINY_TEXT_PT = 10
const SMALL_TEXT_PT = 12
/** 文字框离页边小于这个距离就是贴边(英寸) */
const EDGE_MARGIN_IN = 0.32
/** 两个文字盒重叠面积超过较小盒的这个比例 = 真重叠(不是并排贴边) */
const OVERLAP_RATIO = 0.18
/** 同一行文字的最低可读对比度 */
const MIN_CONTRAST = 3.0

function boxesOf(slide: PreviewSlide | undefined): Box[] {
  const elements = Array.isArray(slide?.elements) ? slide.elements : []
  return elements as unknown as Box[]
}

function area(box: Box): number {
  const w = Number(box.w)
  const h = Number(box.h)
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w * h : 0
}

function overlapArea(a: Box, b: Box): number {
  const ax = Number(a.x), ay = Number(a.y), aw = Number(a.w), ah = Number(a.h)
  const bx = Number(b.x), by = Number(b.y), bw = Number(b.w), bh = Number(b.h)
  if (![ax, ay, aw, ah, bx, by, bw, bh].every(Number.isFinite)) return 0
  const dx = Math.min(ax + aw, bx + bw) - Math.max(ax, bx)
  const dy = Math.min(ay + ah, by + bh) - Math.max(ay, by)
  return dx > 0 && dy > 0 ? dx * dy : 0
}

function compact(value: unknown, limit = 18): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * 几何审查:只报"能算出数字"的问题,每条都带实测值,便于模型按证据改。
 * 没有 layout(引擎没给 --layout-out)时返回空,调用方据此标注"几何审查未执行"。
 */
export function reviewGeometry(
  layout: PreviewSlide[] | undefined,
  spec: DeckSpecJson,
  pageSize?: { width: number; height: number },
): PageProblem[] {
  if (!Array.isArray(layout) || !layout.length) return []
  const width = Number(pageSize?.width) > 0 ? Number(pageSize!.width) : DEFAULT_WIDTH
  const height = Number(pageSize?.height) > 0 ? Number(pageSize!.height) : DEFAULT_HEIGHT
  const problems: PageProblem[] = []

  layout.forEach((slide, index) => {
    const page = index + 1
    const boxes = boxesOf(slide)
    const texts = boxes.filter((box) => box.type === 'text')
    const slideBg = String((spec.slides[index] as { background?: unknown } | undefined)?.background
      || spec.theme?.colors?.background || 'FFFFFF')

    // ① 字号:小于 10pt 的正文/说明基本不可读,<12pt 只提示
    for (const box of texts) {
      const size = Number(box.fontSize)
      if (!Number.isFinite(size) || size <= 0) continue
      if (size < TINY_TEXT_PT) {
        problems.push({
          page, code: 'TINY_TEXT', severity: 'warning', source: 'geometry',
          detail: `字号 ${size}pt:「${compact(box.text)}」在放映尺寸下几乎看不清`,
          advice: '把这段文字并入正文或省去,不要靠缩字号塞内容;正文不低于 12pt。',
        })
      } else if (size < SMALL_TEXT_PT) {
        problems.push({
          page, code: 'SMALL_TEXT', severity: 'info', source: 'geometry',
          detail: `字号 ${size}pt:「${compact(box.text)}」偏小`,
          advice: '说明性文字可提到 12pt 以上。',
        })
      }
    }

    // ② 贴边 / 越界:文字被切掉是最伤阅读的错
    for (const box of texts) {
      const x = Number(box.x), y = Number(box.y), w = Number(box.w), h = Number(box.h)
      if (![x, y, w, h].every(Number.isFinite)) continue
      if (x < -0.02 || y < -0.02 || x + w > width + 0.02 || y + h > height + 0.02) {
        problems.push({
          page, code: 'TEXT_OUT_OF_PAGE', severity: 'warning', source: 'geometry',
          detail: `文字盒越界:(${x.toFixed(2)}, ${y.toFixed(2)}) ${w.toFixed(2)}×${h.toFixed(2)}in,画布 ${width}×${height}in`,
          advice: '压短这段文字,或把它拆到下一页;不要手动写坐标。',
        })
        continue
      }
      const left = x, right = width - (x + w), top = y, bottom = height - (y + h)
      const tightest = Math.min(left, right, top, bottom)
      if (tightest < EDGE_MARGIN_IN) {
        problems.push({
          page, code: 'TEXT_TOO_CLOSE_TO_EDGE', severity: 'info', source: 'geometry',
          detail: `文字离页边只有 ${tightest.toFixed(2)}in:「${compact(box.text)}」`,
          advice: '这是页边距问题:减少同页元素数量或缩短文字,让版面自己收进来。',
        })
      }
    }

    // ③ 文字压文字:排除容器背景与图片,只比文本盒
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i], b = texts[j]
        const smaller = Math.min(area(a), area(b))
        if (smaller <= 0) continue
        const overlap = overlapArea(a, b)
        if (overlap / smaller < OVERLAP_RATIO) continue
        problems.push({
          page, code: 'TEXT_OVERLAP', severity: 'warning', source: 'geometry',
          detail: `两段文字重叠 ${Math.round((overlap / smaller) * 100)}%:「${compact(a.text)}」与「${compact(b.text)}」`,
          advice: '删掉其中一段,或把两段合并成一条;重叠说明内容量超过了这一页的容量。',
        })
      }
    }

    // ④ 对比度:深底深字/浅底浅字(引擎忠实写入,只能在这里抓)
    for (const box of texts) {
      const color = String(box.color || spec.theme?.colors?.foreground || '')
      if (!/^#?[0-9a-f]{6}$/i.test(color.replace('#', ''))) continue
      const ratio = contrastRatio(color, slideBg)
      if (ratio > 0 && ratio < MIN_CONTRAST) {
        problems.push({
          page, code: 'LOW_CONTRAST_TEXT', severity: 'warning', source: 'geometry',
          detail: `文字对比度 ${ratio.toFixed(2)}:1(字号 ${box.fontSize ?? '?'}pt):「${compact(box.text)}」`,
          advice: '这一页的背景色与文字色撞了:改用主题的浅色/深色组合,不要自造色值。',
        })
      }
    }

    // ⑤ 内容量:文字盒面积占比过高 = 拥挤
    const textArea = texts.reduce((sum, box) => sum + area(box), 0)
    const pageArea = width * height
    if (pageArea > 0 && textArea / pageArea > 0.62) {
      problems.push({
        page, code: 'TEXT_DENSITY_HIGH', severity: 'warning', source: 'geometry',
        detail: `文字盒合计占页面 ${Math.round((textArea / pageArea) * 100)}%`,
        advice: '这一页要减内容:删掉重复表述、把要点压到 3-4 条,或拆成两页。',
      })
    }
  })

  return dedupe(problems)
}

/** 这些原型天生"少字",不该按"内容没排到底"来判 */
const SPARSE_BY_DESIGN = new Set(['cover', 'section', 'quote', 'credits'])

export interface PixelReviewContext {
  /** 每页的页面原型(与 metrics 的 page 对齐,1-based) */
  templates?: string[]
  /** 用的哪个渲染器:preview 会把图表画成占位框,图表页"看起来很空"是渲染器的局限 */
  renderer?: string
}

/** 像素审查:渲染图上"看得出来"的问题 */
export function reviewPixels(
  metrics: PagePixelMetrics[] | undefined,
  context: PixelReviewContext = {},
): PageProblem[] {
  if (!Array.isArray(metrics) || !metrics.length) return []
  const problems: PageProblem[] = []
  const templates = context.templates || []
  for (const page of metrics) {
    const number = Number(page.page)
    if (!Number.isFinite(number)) continue
    const template = String(templates[number - 1] || 'content')
    const sparseByDesign = SPARSE_BY_DESIGN.has(template)
    // 预览渲染器不画图表数据:图表页的"空"不是版面问题,降级成 info 并说明原因
    const chartCaveat = context.renderer === 'preview' && template === 'chart'
    if (typeof page.ink_ratio === 'number' && page.ink_ratio < 0.03) {
      if (!sparseByDesign) {
        problems.push({
          page: number, code: 'PAGE_MOSTLY_EMPTY',
          severity: chartCaveat ? 'info' : 'warning', source: 'pixels',
          detail: `渲染后只有 ${(page.ink_ratio * 100).toFixed(1)}% 的像素有内容`
            + (chartCaveat ? '(预览渲染器把图表画成占位框,不代表真实放映效果)' : ''),
          advice: '这一页几乎是一张白纸:补一个真正承载信息的主体(图表 / 图片 / 指标块 / 对照),不要只留标题。',
        })
      }
    }
    if (typeof page.content_bottom_ratio === 'number'
      && page.content_bottom_ratio > 0 && page.content_bottom_ratio < 0.62) {
      if (!sparseByDesign) {
        problems.push({
          page: number, code: 'CONTENT_STOPS_HIGH',
          severity: chartCaveat ? 'info' : 'warning', source: 'pixels',
          detail: `内容只排到页面高度的 ${Math.round(page.content_bottom_ratio * 100)}%`
            + (chartCaveat ? '(预览渲染器的图表占位框所致)' : ''),
          advice: '下半页是空的:把这一页补成完整的版面(多用一组对照/数据/步骤),不要靠放大字号填。',
        })
      }
    }
    if (typeof page.distinct_colours === 'number' && page.distinct_colours < 6) {
      problems.push({
        page: number, code: 'FLAT_PAGE', severity: 'warning', source: 'pixels',
        detail: `渲染后只有 ${page.distinct_colours} 种颜色,几乎是一块纯色`,
        advice: '这一页没有可看的内容:检查元素是否真的写进去了。',
      })
    }
  }
  return dedupe(problems)
}

export interface GroupedPageProblems {
  page: number
  problems: PageProblem[]
  /** 给修复提示词用的一行行证据(按来源署名,模型能分清"图上看出来的"与"算出来的") */
  lines: string[]
}

/** 按页归并,并渲染成修复提示词里的证据行 */
export function groupByPage(problems: PageProblem[]): GroupedPageProblems[] {
  const byPage = new Map<number, PageProblem[]>()
  for (const problem of problems) {
    const list = byPage.get(problem.page) || []
    list.push(problem)
    byPage.set(problem.page, list)
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, list]) => ({
      page,
      problems: list,
      lines: list.map((problem) => `[${problem.source}/${problem.code}] ${problem.detail}`
        + (problem.advice ? ` → 改法:${problem.advice}` : '')),
    }))
}

/**
 * 一页的几何指纹:元素数 + 每个盒子的取整坐标。
 * 用途是"修复只改了问题页"的验证 —— 非目标页的指纹变了,说明模型顺手改了别处,
 * 那一轮必须回滚,不能把"修好一页、弄坏三页"当成功。
 */
export function fingerprintPages(layout: PreviewSlide[] | undefined): string[] {
  if (!Array.isArray(layout)) return []
  return layout.map((slide, index) => {
    const boxes = boxesOf(slide)
    const stamp = boxes
      .map((box) => [
        box.type,
        Math.round(Number(box.x ?? 0) * 100),
        Math.round(Number(box.y ?? 0) * 100),
        Math.round(Number(box.w ?? 0) * 100),
        Math.round(Number(box.h ?? 0) * 100),
      ].join(':'))
      .sort()
      .join('|')
    return `${index + 1}#${boxes.length}#${stamp}`
  })
}

/** 比较两轮指纹,返回"被改动过的页码"(1-based) */
export function changedPages(before: string[], after: string[]): number[] {
  const changed: number[] = []
  const length = Math.max(before.length, after.length)
  for (let index = 0; index < length; index++) {
    if ((before[index] || '') !== (after[index] || '')) changed.push(index + 1)
  }
  return changed
}

function dedupe(problems: PageProblem[]): PageProblem[] {
  const seen = new Set<string>()
  return problems.filter((problem) => {
    const key = `${problem.page}|${problem.code}|${problem.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
