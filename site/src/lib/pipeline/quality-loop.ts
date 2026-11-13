/**
 * pipeline/quality-loop.ts — 渲染 → 检查 → 只修问题页 → 重渲染的闭环
 *
 * 这条链路解决的是"几何检查不等于审美检查"这件事:
 *
 *   render   把成品 .pptx 渲染成逐页 PNG(没有渲染就没有"看过")
 *   pixels   量图:整页有没有内容、内容排到多高、是不是纯色(确定性)
 *   geometry 量引擎真实盒子:字号、贴边、重叠、对比度、文字密度(确定性)
 *   vision   视觉模型评审美:焦点/层级/留白/图文关系(可缺席,缺席就写"未执行")
 *   repair   只把有问题的页交给模型重写,非目标页一个字节都不动
 *   verify   重建后比对逐页几何指纹:非目标页变了 → 回滚这一轮
 *
 * 循环形状刻意是"检查 → 修 → 再检查":报告里的问题清单永远描述**要交付的那一份**,
 * 不存在"改完还没看就宣布通过"。修不好就说修不好。
 */
import { dirname, resolve } from 'path'
import {
  reviewGeometry, reviewPixels, groupByPage, fingerprintPages, changedPages,
  type PageProblem,
} from './review'
import { renderDeck, measureRenderedPages, type RenderResult, type PixelMetricsResult } from './render'
import { reviewDeckVisually, visionConfigured, type DeckVisionReview } from './vision'
import { repairSpecPages, type PageRepairResult, type ResearchForSpec } from './spec'
import type { DeckSpecJson, GenerateInput, NativeBuildResult, OutlinePlan } from './types'

export interface QualityLoopRepair {
  round: number
  /** 交给模型的页 */
  pages: number[]
  /** 重建后实际发生几何变化的页(1-based) */
  changedPages: number[]
  /** 非目标页被改动 → 这一轮已回滚 */
  rolledBack: boolean
  /** 模型没给有效修改的页 */
  missedPages: number[]
  error?: string
}

export type QualityLoopStop =
  | 'clean'
  | 'repairs-exhausted'
  | 'no-repair-applied'
  | 'regression'
  | 'render-unavailable'
  | 'disabled'
  | 'error'

export interface QualityLoopReport {
  enabled: boolean
  /** 做了几轮检查 */
  reviews: number
  /** 真的重建了几轮 */
  repairs: QualityLoopRepair[]
  stopped: QualityLoopStop
  render?: { ok: boolean; renderer: string; pages: number; ms?: number; error?: string; notes: string[] }
  pixels?: { ok: boolean; pages: number; averages?: Record<string, number>; error?: string }
  vision?: { enabled: boolean; provider: string; model?: string; note: string; pages: number; rounds: number }
  /** 交付那一份成品的残留问题(几何 / 像素 / 视觉,各自带 source) */
  problems: PageProblem[]
  /** 交付那一份成品 */
  spec: DeckSpecJson
  built: NativeBuildResult
  ms: number
  note: string
}

export interface QualityLoopDeps {
  input: GenerateInput
  taskId: string
  plan: OutlinePlan
  research: ResearchForSpec
  spec: DeckSpecJson
  built: NativeBuildResult
  /** 成品路径(重建会覆盖它) */
  outPath: string
  /** 复用管线的构建函数(带进度事件) */
  rebuild: (spec: DeckSpecJson) => Promise<NativeBuildResult>
  emitStage: (stage: string) => Promise<void>
  /** 关闭开关(env NATIVE_VISUAL_REPAIR=0) */
  enabled?: boolean
  /** 最多修几轮 */
  maxRepairs?: number
  /**
   * 可替换的四个外部依赖(渲染 / 度量 / 视觉 / 页级修复)。
   * 生产不传,测试传桩 —— 否则"非目标页被改动就回滚"这条逻辑只能靠真机撞。
   */
  hooks?: {
    render?: (pptxPath: string, outDir: string) => Promise<RenderResult>
    measure?: (dir: string) => Promise<PixelMetricsResult>
    vision?: (pages: Array<{ page: number; file: string }>) => Promise<DeckVisionReview>
    repair?: (
      input: GenerateInput, taskId: string, plan: OutlinePlan, spec: DeckSpecJson,
      targets: Array<{ page: number; lines: string[] }>, research?: ResearchForSpec,
    ) => Promise<PageRepairResult>
  }
}

/** 单轮最多修几页:一次改 20 页等于整份重写,失去"只改问题页"的意义,也烧 token */
const MAX_PAGES_PER_ROUND = Number(process.env.NATIVE_REPAIR_MAX_PAGES || 6)

function toVisionProblems(review: DeckVisionReview): PageProblem[] {
  const problems: PageProblem[] = []
  for (const page of review.pages) {
    for (const problem of page.problems) {
      problems.push({
        page: page.page,
        code: problem.code,
        severity: problem.severity,
        detail: `${page.summary ? `${page.summary} ` : ''}${problem.detail}`.trim(),
        advice: problem.advice,
        source: 'vision',
      })
    }
    if (page.verdict === 'needs_work' && !page.problems.length) {
      problems.push({
        page: page.page,
        code: 'VISION_NEEDS_WORK',
        severity: 'warning',
        detail: page.summary || '视觉模型认为这一页需要重做(未给出具体条目)',
        source: 'vision',
      })
    }
  }
  return problems
}

interface ReviewPass {
  render: RenderResult
  pixels: PixelMetricsResult
  vision: DeckVisionReview
  problems: PageProblem[]
  actionableWarnings: number
}

export async function runQualityLoop(deps: QualityLoopDeps): Promise<QualityLoopReport> {
  const startedAt = Date.now()
  const maxRepairs = Math.max(0, deps.maxRepairs ?? 2)
  const enabled = deps.enabled !== false && maxRepairs > 0
  const renderDir = resolve(dirname(deps.outPath), 'render')

  let spec = deps.spec
  let built = deps.built
  const repairs: QualityLoopRepair[] = []
  let reviews = 0
  let visionRounds = 0
  let last: ReviewPass | undefined
  let stopped: QualityLoopStop = enabled ? 'repairs-exhausted' : 'disabled'
  let note = ''

  for (let repairRound = 0; repairRound <= maxRepairs; repairRound++) {
    // ── 检查当前这一份 ──────────────────────────────────────────────────
    reviews++
    await deps.emitStage(
      maxRepairs > 0 && enabled
        ? `正在渲染成品并做逐页检查(第 ${reviews} 次)…`
        : '正在渲染成品并做逐页检查…',
    )
    const renderDeckFn = deps.hooks?.render ?? renderDeck
    const render = await renderDeckFn(deps.outPath, renderDir)
    if (!render.ok) {
      // 渲染不出来不等于成品坏了:如实记录,视觉检查整块标为未执行
      const geometry = reviewGeometry(built.layout, spec, built.pageSize)
      note = `无法渲染成品,视觉检查未执行:${render.error || '未知原因'}。`
        + '几何检查与引擎校验仍然有效。'
      return finish('render-unavailable', {
        render, pixels: undefined, vision: undefined, problems: geometry, built, spec,
      })
    }
    const measureFn = deps.hooks?.measure ?? measureRenderedPages
    const pixels = await measureFn(render.dir || renderDir)
    const geometry = reviewGeometry(built.layout, spec, built.pageSize)
    const templates = spec.slides.map((slide) => String(slide.template || 'content'))
    const pixelProblems = pixels.ok
      ? reviewPixels(pixels.pages, { templates, renderer: render.renderer })
      : []

    // 视觉模型按轮计费:第一次看全貌,最后一轮看结果;中途不为中间态花钱
    const runVision = (deps.hooks?.vision ? true : visionConfigured()) && (visionRounds === 0 || repairRound === maxRepairs)
    let vision: DeckVisionReview | undefined
    if (runVision) {
      visionRounds++
      await deps.emitStage(`正在用视觉模型检查版面(第 ${reviews} 次)…`)
      const visionFn = deps.hooks?.vision ?? reviewDeckVisually
      vision = await visionFn(render.pages.map((page) => ({ page: page.page, file: page.file })))
    }
    const visionIssues = vision ? toVisionProblems(vision) : []
    const problems = [...geometry, ...pixelProblems, ...visionIssues]
    const actionable = problems.filter((problem) => problem.severity === 'warning')
    last = {
      render, pixels, vision: vision || {
        enabled: false, provider: 'none', pages: [], note: '未配置视觉模型:审美检查未执行',
      },
      problems, actionableWarnings: actionable.length,
    }

    if (!actionable.length) {
      stopped = 'clean'
      note = `检查通过:${problems.length} 条 info,无 warning`
      break
    }
    if (!enabled) {
      stopped = 'disabled'
      note = '质量闭环已关闭(NATIVE_VISUAL_REPAIR=0):只报告问题,不做修复'
      break
    }
    if (repairRound === maxRepairs) {
      stopped = 'repairs-exhausted'
      note = `已用满 ${maxRepairs} 轮修复,仍有 ${actionable.length} 条 warning 未解决(见 problems)`
      break
    }

    // ── 只修问题页 ─────────────────────────────────────────────────────
    const grouped = groupByPage(actionable).slice(0, MAX_PAGES_PER_ROUND)
    const targets = grouped.map((group) => ({ page: group.page, lines: group.lines }))
    await deps.emitStage(`第 ${targets.map((target) => target.page).join('、')} 页需要修改,正在按页重写…`)
    const beforeFingerprint = fingerprintPages(built.layout)
    let repair
    try {
      const repairFn = deps.hooks?.repair ?? repairSpecPages
      repair = await repairFn(deps.input, deps.taskId, deps.plan, spec, targets, deps.research)
    } catch (error) {
      repairs.push({
        round: repairRound + 1, pages: targets.map((t) => t.page), changedPages: [],
        rolledBack: false, missedPages: [], error: (error as Error).message,
      })
      stopped = 'error'
      note = `按页修复失败,保留上一份成品:${(error as Error).message}`
      break
    }
    if (!repair.repairedPages.length) {
      repairs.push({
        round: repairRound + 1, pages: targets.map((t) => t.page), changedPages: [],
        rolledBack: false, missedPages: repair.missedPages,
      })
      stopped = 'no-repair-applied'
      note = '模型没有返回任何可用的页级修改,保留原成品'
      break
    }

    const rebuilt = await deps.rebuild(repair.spec)
    if (!rebuilt.ok) {
      // 重建失败:磁盘上可能已被覆盖,立刻用上一份 spec 重建回来
      const restored = await deps.rebuild(spec)
      repairs.push({
        round: repairRound + 1, pages: repair.repairedPages, changedPages: [],
        rolledBack: true, missedPages: repair.missedPages, error: rebuilt.error || '重建失败',
      })
      stopped = 'error'
      note = `修复后的规格重建失败,已回滚:${rebuilt.error || '未知原因'}`
        + (restored.ok ? '' : `;回滚重建也失败(${restored.error || '未知原因'})`)
      break
    }

    const changed = changedPages(beforeFingerprint, fingerprintPages(rebuilt.layout))
    const unexpected = changed.filter((page) => !repair.repairedPages.includes(page))
    if (unexpected.length) {
      // 非目标页被改动 → 这一轮作废。视觉修复不能以"顺手改坏别的页"为代价。
      const restored = await deps.rebuild(spec)
      repairs.push({
        round: repairRound + 1, pages: repair.repairedPages, changedPages: changed,
        rolledBack: true, missedPages: repair.missedPages,
        error: `非目标页被改动:第 ${unexpected.join('、')} 页`,
      })
      stopped = 'regression'
      note = `修复轮改动了未授权的页(第 ${unexpected.join('、')} 页),已回滚`
        + (restored.ok ? '' : `;回滚重建失败:${restored.error || '未知原因'}`)
      break
    }

    repairs.push({
      round: repairRound + 1, pages: repair.repairedPages, changedPages: changed,
      rolledBack: false, missedPages: repair.missedPages,
    })
    spec = repair.spec
    built = rebuilt
  }

  return finish(stopped, {
    render: last?.render,
    pixels: last?.pixels,
    vision: last?.vision,
    problems: last?.problems || [],
    built,
    spec,
    reviews,
    visionRounds,
  })

  function finish(
    stop: QualityLoopStop,
    ctx: {
      render?: RenderResult
      pixels?: PixelMetricsResult
      vision?: DeckVisionReview
      problems: PageProblem[]
      built: NativeBuildResult
      spec: DeckSpecJson
      reviews?: number
      visionRounds?: number
    },
  ): QualityLoopReport {
    const report: QualityLoopReport = {
      enabled,
      reviews: ctx.reviews ?? reviews,
      repairs,
      stopped: stop,
      problems: ctx.problems,
      spec: ctx.spec,
      built: ctx.built,
      ms: Date.now() - startedAt,
      note,
    }
    if (ctx.render) {
      report.render = {
        ok: ctx.render.ok,
        renderer: ctx.render.renderer,
        pages: ctx.render.pages.length,
        ms: ctx.render.ms,
        error: ctx.render.error,
        notes: ctx.render.notes,
      }
    }
    if (ctx.pixels) {
      report.pixels = {
        ok: ctx.pixels.ok,
        pages: ctx.pixels.pages.length,
        averages: ctx.pixels.averages,
        error: ctx.pixels.error,
      }
    }
    if (ctx.vision) {
      report.vision = {
        enabled: ctx.vision.enabled,
        provider: ctx.vision.provider,
        model: ctx.vision.model,
        note: ctx.vision.note,
        pages: ctx.vision.pages.length,
        rounds: ctx.visionRounds ?? visionRounds,
      }
    }
    if (!report.note) {
      report.note = report.problems.some((problem) => problem.severity === 'warning')
        ? '仍有未解决的质量问题(见 problems)'
        : '检查完成'
    }
    return report
  }
}
