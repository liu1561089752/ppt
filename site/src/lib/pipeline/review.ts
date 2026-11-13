/**
 * pipeline/review.ts — 逐页问题的统一账本
 *
 * 四个来源的结论**分开记录**,绝不混成一个分数(几何分不能冒充审美分):
 *   shape    — 这一页有没有画出它该有的东西:图表页有没有图、对照页有没有两栏、
 *              指标页有没有指标卡。**这是"整份 deck 变成文字列表"的唯一自动防线。**
 *   geometry — 引擎 `--layout-out` 的真实盒子:溢出、重叠、贴边、字号过小、对比度
 *   pixels   — 渲染出来的图:整页发白、内容塌在上半屏、纯色板
 *   vision   — 视觉模型的审美判断:重心、层级、拥挤、图文关系(未配置时为空)
 *
 * 输出 `PageProblem[]`,`page` 是 1-based 页码,供"只改问题页"的修复轮使用;
 * `fingerprintPages()` 用来验证修复没有顺手改坏其它页。
 */
import type { DeckSpecJson, PreviewSlide } from './types'
import { contrastRatio } from './contrast'

export type ProblemSource = 'shape' | 'geometry' | 'pixels' | 'vision'

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

// ── 原型构图审查 ───────────────────────────────────────────────────────────

interface SpecElement {
  type?: string
  text?: unknown
  fontSize?: unknown
  children?: SpecElement[]
  chartType?: unknown
  path?: unknown
  rows?: unknown
  columns?: unknown
  columnTracks?: unknown
  columnSpan?: unknown
}

/** 把一页的元素树压平成 (元素, 所在栏数) 序列 —— 判构图只需要这两样 */
function flattenElements(elements: SpecElement[] | undefined, columns = 1): Array<{ element: SpecElement; columns: number }> {
  const out: Array<{ element: SpecElement; columns: number }> = []
  const walk = (list: SpecElement[] | undefined, inheritedColumns: number) => {
    for (const element of Array.isArray(list) ? list : []) {
      if (!element || typeof element !== 'object') continue
      const own = Array.isArray(element.columnTracks) && element.columnTracks.length
        ? element.columnTracks.length
        : Math.max(inheritedColumns, Number(element.columns) > 1 ? Math.floor(Number(element.columns)) : inheritedColumns)
      out.push({ element, columns: own })
      if (Array.isArray(element.children)) walk(element.children, own)
    }
  }
  walk(elements, columns)
  return out
}

/** 数字类文本(69% / 3.2s / 1,200 / 2026)—— 指标页靠它承载信息 */
function looksNumeric(text: unknown): boolean {
  const value = String(text ?? '').trim()
  if (!value || value.length > 16) return false
  return /\d/u.test(value) && /^[\d\s.,%+\-/：:年月日亿元万千百sSms倍xX×]+$/u.test(value)
}

/**
 * 原型构图审查:这一页有没有画出它该有的**东西**。
 *
 * 引擎的几何校验只管"盒子对不对",不管"该有的东西在不在":一个图表页只写两段文字,
 * 几何完全合法、渲染也不空,但那页就是变成了文字列表 —— 整份 deck 的品质塌陷主要
 * 发生在这里,而且到现在为止没有任何自动检查发现它。
 *
 * 判据全部是结构性的(有没有 chart 元素、有没有两栏容器、卡片够不够),不看措辞,
 * 所以既能交给修复轮,也不会因为文案不同而误报。
 */
export function reviewComposition(spec: DeckSpecJson | undefined): PageProblem[] {
  const slides = Array.isArray(spec?.slides) ? spec!.slides as unknown as Array<Record<string, unknown>> : []
  const problems: PageProblem[] = []
  slides.forEach((slide, index) => {
    const page = index + 1
    const template = String(slide?.template || 'content')
    const flat = flattenElements(slide?.elements as SpecElement[] | undefined)
    const elements = flat.map((entry) => entry.element)
    const count = (type: string): number => elements.filter((element) => element.type === type).length
    const containers = elements.filter((element) => element.type === 'container')
    const textCount = count('text')
    const cards = containers.filter((container) => container.columns === undefined || Number(container.columns) <= 1)
    const multiColumn = containers.filter((container) => Number(container.columns) > 1 || Array.isArray(container.columnTracks))
    const childrenOf = (container: SpecElement): number =>
      Array.isArray(container.children) ? container.children.length : 0
    const widest = multiColumn.reduce((best, container) => Math.max(best, childrenOf(container)), 0)

    const push = (code: string, detail: string, advice: string, severity: 'warning' | 'info' = 'warning') => {
      problems.push({ page, code, severity, detail, source: 'shape', advice })
    }

    switch (template) {
      case 'chart':
        if (count('chart') === 0) {
          push('SHAPE_MISSING_CHART',
            '这一页标的是图表页,但规格里没有任何 chart 元素',
            '把这些数字写成 chart 元素(数据进内嵌工作簿),不要用文字或表格代替图表;右侧留一栏写读图结论。')
        }
        break
      case 'table':
        if (count('table') === 0) {
          push('SHAPE_MISSING_TABLE',
            '这一页标的是表格页,但规格里没有任何 table 元素',
            '要用 table 元素承载对照数据(首行表头),不要把表格写成用文本拼的行。')
        }
        break
      case 'image':
        if (count('image') === 0) {
          push('SHAPE_MISSING_IMAGE',
            '这一页标的是配图页,但规格里没有 image 元素',
            '从配图清单里取本页指定的 path 放一张图(fit=cover,h 3.5-4.2),再配一段说明与署名。')
        }
        break
      case 'kpi': {
        const numeric = elements.filter((element) => element.type === 'text' && looksNumeric(element.text)).length
        if (cards.length < 2 && numeric < 2) {
          push('SHAPE_NO_METRICS',
            `指标页没有可看的指标:卡片 ${cards.length} 个、数字文本 ${numeric} 个`,
            '至少给 2-4 个指标卡(容器 + 大字号数值 + 标签 + 一句注解);数字要单独成元素,不要混在正文里。')
        } else if (cards.length >= 2 && cards.length > 4) {
          push('SHAPE_TOO_MANY_CARDS',
            `指标页有 ${cards.length} 张卡片,一页放不下这么多个重心`,
            '收敛到 2-4 个最有说服力的指标;其余的换成一句注解或放到下一页。', 'info')
        }
        break
      }
      case 'comparison':
      case 'process':
      case 'bento': {
        const needed = template === 'comparison' ? 2 : 3
        if (widest < needed) {
          push(template === 'comparison' ? 'SHAPE_NOT_TWO_COLUMNS' : 'SHAPE_NOT_ENOUGH_STEPS',
            `这一页没有做出${template === 'comparison' ? '两栏对照' : '多步并列'}的版心:最宽的一组只有 ${widest} 个子元素`,
            template === 'comparison'
              ? '用 columns:2 的容器装两栏(各一段说明),底部再加一句结论条。'
              : `用 columns:${needed} 以上的容器装 ${needed} 个以上的并列项(每项一个小标题 + 一句说明)。`)
        }
        break
      }
      case 'cover':
      case 'section':
      case 'quote': {
        // 停顿页:重心要少。卡片一多,停顿感就没了。
        if (cards.length >= 3 || textCount > 8) {
          push('SHAPE_OVERBUILT_PAUSE_PAGE',
            `停顿页塞了 ${cards.length} 张卡片 / ${textCount} 段文本,它应该只有一句话`,
            '封面 / 章节 / 引语页只留一个重心:一行 kicker、一句主标题、最多一段说明。内容多就该换成正文页。', 'info')
        }
        break
      }
      default: {
        // content / editorial / hero / credits:至少要有"标题之外的一段正文"
        const bodies = elements.filter((element) => element.type === 'text'
          && element.text !== undefined
          && !looksNumeric(element.text)
          && Number(element.fontSize ?? 0) < 24).length
        if (bodies < 2 && count('chart') + count('table') + count('image') === 0) {
          push('SHAPE_THIN_PAGE',
            `这一页除标题外只有 ${bodies} 段正文,也没有图表/表格/配图`,
            '补一个真正承载信息的主体:一组对照、一个数据块、一张图,或者一段把它讲透的正文。')
        }
        break
      }
    }

    // 通用:一页里重复同一种构图太多次,读起来就是"卡片墙"
    if (cards.length > 6) {
      push('SHAPE_CARD_WALL',
        `这一页有 ${cards.length} 张卡片,已经是一堵卡片墙`,
        '把同类项合并成一栏列表,或者拆成两页:一页讲结论,一页讲证据。')
    }
  })
  return dedupe(problems)
}

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
