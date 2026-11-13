/**
 * pipeline/spec.ts — Stage 4:Deck Spec(LLM 出内容,引擎定 schema)
 *
 * 一次 S4 = 一次 LLM 调用 + 一次引擎 `--check`。校验不过就把引擎的**逐条错误原文**
 * 喂回 buildSpecRepairPrompt 重写,最多 SPEC_MAX_REPAIRS 轮 —— 判据不是"我觉得对不对",
 * 而是 core/schema.js 说对不对。
 *
 * 服务端在这里注入四样东西,LLM 无权决定:
 *   1. theme(themeFor 从引擎预设解析):颜色/字体/字号只有一份真值;
 *   2. 每页的 template(来自 S3 大纲):预览用,引擎忽略;
 *   3. 图片路径与署名:只用 S2 已落盘的 localPath,credit 由这里补全(schema 拒空署名);
 *   4. pageSize / language / author。
 */
import { chat, parseJsonLoose } from '@/lib/kimi-client'
import { SPEC_SYSTEM, buildSpecPrompt, buildSpecRepairPrompt, buildPageRepairPrompt } from '@/lib/pptx-prompts'
import { setProgress, emitEvent, addUsage } from './events'
import { checkSpec } from './native'
import { isMockLLM, mockDeckSpec } from './mock'
import { themeFor } from './theme'
import { fixSpecContrast } from './contrast'
import { reviewDeckSpec } from './quality'
import { enforceDeckDesign } from './design'
import {
  SPEC_MAX_REPAIRS,
  type DeckElement,
  type DeckSlide,
  type DeckSpecJson,
  type GenerateInput,
  type OutlinePlan,
} from './types'

/** S2 产物里 S4 需要的部分(图片必须带 localPath 才可用) */
export interface ResearchForSpec {
  facts: string
  images: Array<{
    id?: string
    url: string
    description: string
    author?: string
    pageUrl?: string
    localPath?: string
    licence?: string
  }>
}

export interface SpecArtifact {
  spec: DeckSpecJson
  pages: number
}

interface UsableImage {
  id?: string
  path: string
  caption: string
  author?: string
  licence?: string
  pageUrl?: string
}

const ELEMENT_TYPES = new Set(['text', 'shape', 'line', 'image', 'table', 'chart', 'container'])

/** 只有落盘成功的图可用:引擎只认本地文件,远程地址会让那页静默少一张图 */
function usableImages(research: ResearchForSpec): UsableImage[] {
  return research.images
    .filter((image) => typeof image.localPath === 'string' && image.localPath.length > 0)
    .map((image) => ({
      id: image.id,
      path: image.localPath as string,
      caption: image.description,
      author: image.author,
      licence: image.licence || 'Unsplash License',
      pageUrl: image.pageUrl,
    }))
}

/** 元素缺 type 时按字段推断(比让引擎报 20 条 schema 错再重写便宜) */
function inferElementType(element: Record<string, unknown>): string {
  const declared = typeof element.type === 'string' ? element.type.trim().toLowerCase() : ''
  if (ELEMENT_TYPES.has(declared)) return declared
  if (Array.isArray(element.children)) return 'container'
  if (Array.isArray(element.rows)) return 'table'
  // 图表与图片都用 data:数组是图表系列,data: URI 才是图片
  if (Array.isArray(element.data)) return 'chart'
  if (typeof element.path === 'string') return 'image'
  if (typeof element.data === 'string' && /^data:/iu.test(element.data)) return 'image'
  if (typeof element.src === 'string') return 'image'
  if (typeof element.text === 'string' || Array.isArray(element.text)) return 'text'
  if (typeof element.fill === 'string' || typeof element.gradient === 'object' || element.line === false) return 'shape'
  if (element.beginArrowType || element.endArrowType || element.dash) return 'line'
  return 'text'
}

/** 图片元素补署名:引擎要求 credit 的 subject / author / licence 三者非空 */
function withCredit(element: DeckElement, images: UsableImage[]): DeckElement {
  if (element.type !== 'image') return element
  if (typeof element.path !== 'string') return element
  const match = images.find((image) => image.path === element.path)
  if (!match) return element
  const existing = element.credit as { author?: unknown; licence?: unknown; subject?: unknown } | undefined
  const author = typeof existing?.author === 'string' && existing.author.trim()
    ? existing.author
    : match.author || '图库贡献者'
  const licence = typeof existing?.licence === 'string' && existing.licence.trim()
    ? existing.licence
    : match.licence || 'Unsplash License'
  const subject = typeof existing?.subject === 'string' && existing.subject.trim()
    ? existing.subject
    : match.caption || '配图'
  return { ...element, credit: { subject, author, licence } }
}

function normaliseElements(raw: unknown, images: UsableImage[]): DeckElement[] {
  if (!Array.isArray(raw)) return []
  const out: DeckElement[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const source = item as Record<string, unknown>
    const type = inferElementType(source)
    const element: DeckElement = { ...source, type }
    // LLM 习惯把图片地址写成 src;引擎只认 path / data(engine/image_fit.js:296)
    if (type === 'image' && typeof source.src === 'string' && !source.path && !source.data) {
      element.path = source.src
      delete element.src
    }
    // 没有本地文件的图片元素留着只会让那页少一张图,直接丢
    if (type === 'image' && typeof element.path === 'string' && images.length > 0
      && !images.some((image) => image.path === element.path)) {
      delete element.path
    }
    if (type === 'container') {
      element.children = normaliseElements(source.children, images)
    }
    out.push(withCredit(element, images))
  }
  return out
}

/** 把 LLM 输出收敛成"一定能被引擎理解"的 Deck Spec(主题/模板/底色由这里定) */
function normaliseSpec(
  parsed: DeckSpecJson | null,
  input: GenerateInput,
  plan: OutlinePlan,
  images: UsableImage[],
): DeckSpecJson {
  const theme = themeFor(plan.preset, input.language)
  const rawSlides = Array.isArray(parsed?.slides) ? parsed!.slides : []
  const slides: DeckSlide[] = rawSlides.slice(0, input.slideCount).map((slide, index) => {
    const outline = plan.pages[index]
    const asRecord = (slide || {}) as { elements?: unknown; template?: string; background?: string; notes?: string }
    return {
      template: outline?.template || asRecord.template || 'content',
      background: asRecord.background || theme.colors.background,
      notes: asRecord.notes || outline?.brief || undefined,
      elements: normaliseElements(asRecord.elements, images),
    }
  })
  // 页数不足按大纲补齐(不猜内容,只把大纲里已有的 brief 落成文字)
  while (slides.length < Math.min(input.slideCount, plan.pages.length)) {
    const outline = plan.pages[slides.length]
    slides.push({
      template: outline.template || 'content',
      background: theme.colors.background,
      notes: outline.brief,
      elements: [
        { type: 'text', role: 'title', text: outline.title, fontSize: 28, bold: true, color: theme.colors.foreground },
        { type: 'text', text: outline.brief || outline.title, fontSize: theme.sizes?.body ?? 14, color: theme.colors.muted },
      ],
    })
  }
  const spec: DeckSpecJson = {
    title: (parsed?.title || plan.title || input.topic).toString().slice(0, 200),
    author: (parsed as { author?: string })?.author || 'chatppt native engine',
    language: input.language,
    pageSize: 'wide',
    theme,
    slides,
  }
  // 设计兜底:背景锁回主题色板、字号抬到 PPT 尺度、卡片开背景、图片按页面绑定落地(见 design.ts)
  const design = enforceDeckDesign(spec, images, plan.pages)
  if (design.backgroundsLocked || design.fontSizesRaised || design.imagesInjected
    || design.templatesDowngraded || design.imagesRebound || design.imagesDeduped
    || design.surfacesEnabled) {
    console.log(
      `[pipeline] 设计兜底:背景 ${design.backgroundsLocked} 页 / 字号 ${design.fontSizesRaised} 处`
        + ` / 卡片开底 ${design.surfacesEnabled} 张 / 补图 ${design.imagesInjected} 张`
        + ` / 纠偏 ${design.imagesRebound} 张 / 去重 ${design.imagesDeduped} 张`
        + ` / 降级 ${design.templatesDowngraded} 页`,
    )
  }
  // 对比度兜底:模型常在深底页照抄主题的深色正文,交出前统一翻成可读色(见 contrast.ts)
  const fixed = fixSpecContrast(spec)
  if (fixed > 0) console.log(`[pipeline] 对比度兜底:修正 ${fixed} 处深/浅底不可读文字`)
  return spec
}

interface AttemptOutcome {
  spec?: DeckSpecJson
  errors: string[]
  /** 本轮模型原始输出:修复提示词要拿它当底稿(引擎错的是它,不是我们收敛后的样子) */
  raw: string
}

/** 一次"生成/修复 + 校验"的完整尝试 */
async function attemptSpec(
  input: GenerateInput,
  taskId: string,
  plan: OutlinePlan,
  images: UsableImage[],
  context: { basePrompt?: string; previousOutput?: string; errors?: string[] },
): Promise<AttemptOutcome> {
  const prompt = context.previousOutput && context.errors?.length
    ? buildSpecRepairPrompt(context.previousOutput, context.errors, plan)
    : (context.basePrompt || '')
  const res = await chat({
    messages: [
      { role: 'system', content: SPEC_SYSTEM },
      { role: 'user', content: prompt },
    ],
    // 一份 8-25 页的 spec 是长 JSON;推理模型的思考也计入预算
    maxTokens: 48000,
  })
  await addUsage(taskId, res.usage?.promptTokens ?? 0, res.usage?.completionTokens ?? 0)
  const raw = res.content || ''
  const parsed = parseJsonLoose<DeckSpecJson>(raw)
  if (!parsed || typeof parsed !== 'object') {
    return { errors: ['LLM 输出不是合法 JSON(没有可解析的对象)'], raw }
  }
  const spec = normaliseSpec(parsed, input, plan, images)
  if (spec.slides.length === 0) {
    return { errors: ['deck.slides must be a non-empty array'], raw }
  }
  const check = await checkSpec(spec)
  if (check.ok) return { spec, errors: [], raw }
  return { errors: check.errors, raw }
}

export async function stage4Spec(
  input: GenerateInput,
  taskId: string,
  plan: OutlinePlan,
  research: ResearchForSpec,
): Promise<SpecArtifact> {
  await setProgress(taskId, 'generating', 55, '生成原生规格')
  await emitEvent(taskId, 'status', { status: 'generating', stage: '正在生成 Deck Spec(原生规格)…' })

  // 无密钥自测:确定性 fixture(≥8 页、chart/table/image 各一)
  if (isMockLLM()) {
    const spec = mockDeckSpec(input, plan)
    const check = await checkSpec(spec)
    if (!check.ok) throw new Error(`mock spec 未通过引擎校验:${check.errors.join(' | ')}`)
    await setProgress(taskId, 'generating', 70, `规格就绪(${spec.slides.length} 页)`)
    return { spec, pages: spec.slides.length }
  }

  const images = usableImages(research)
  const theme = themeFor(plan.preset, input.language)
  // 提示词 API 由 @/lib/pptx-prompts 持有(core-lib):buildSpecPrompt(plan, input, theme?)
  const basePrompt = buildSpecPrompt(
    plan,
    {
      topic: input.topic,
      audience: input.audience || undefined,
      tone: input.tone || undefined,
      preset: plan.preset || input.preset || undefined,
      customStyle: input.customStyle || undefined,
      customRequirements: input.customRequirements || undefined,
      language: input.language,
      slideCount: input.slideCount,
      facts: research.facts,
      // 给 LLM 的是已落盘的 path;url 只作说明,写进 deck 会被引擎判为读不到
      images: images.map((image) => ({
        id: image.id,
        url: image.path,
        path: image.path,
        caption: image.caption,
        author: image.author,
        licence: image.licence,
        pageUrl: image.pageUrl,
      })),
    },
    { name: theme.name, colors: theme.colors },
  )

  let lastErrors: string[] = []
  let lastRaw = ''
  for (let attempt = 0; attempt <= SPEC_MAX_REPAIRS; attempt++) {
    try {
      const outcome = await attemptSpec(input, taskId, plan, images, attempt === 0 || !lastRaw
        ? { basePrompt }
        : { previousOutput: lastRaw, errors: lastErrors })
      if (outcome.spec) {
        const quality = reviewDeckSpec(outcome.spec, input.slideCount)
        if (quality.issues.length) {
          console.warn('[pipeline] Deck Spec 质量检查:', quality.issues.map((issue) => issue.code).join(', '))
          await emitEvent(taskId, 'status', { status: 'generating', stage: `页面结构质量检查 ${quality.score}/100（${quality.issues.filter((issue) => issue.severity === 'warning').length} 项需关注）` })
        }
        await setProgress(taskId, 'generating', 70, `规格就绪(${outcome.spec.slides.length} 页)`)
        await emitEvent(taskId, 'tool_response', {
          name: 'deck_spec',
          status: 'completed',
          text: `${outcome.spec.slides.length} 页规格通过引擎 schema 校验(第 ${attempt + 1} 次尝试)`,
        })
        return { spec: outcome.spec, pages: outcome.spec.slides.length }
      }
      lastErrors = outcome.errors
      lastRaw = outcome.raw
      console.warn(`[pipeline] 规格第 ${attempt + 1} 次未通过校验:`, outcome.errors.slice(0, 5).join(' | '))
      await emitEvent(taskId, 'status', {
        status: 'generating',
        stage: `规格未通过引擎校验,按引擎错误重写(${attempt + 1}/${SPEC_MAX_REPAIRS + 1})`,
      })
    } catch (e) {
      lastErrors = [(e as Error).message]
      console.warn(`[pipeline] 规格第 ${attempt + 1} 次调用失败:`, (e as Error).message)
      if (attempt >= SPEC_MAX_REPAIRS) break
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)))
    }
  }
  throw new Error(`规格未通过引擎校验(尝试 ${SPEC_MAX_REPAIRS + 1} 次):${lastErrors.slice(0, 3).join(' | ')}`)
}

/**
 * 构建期 warnings 触发的修复:把引擎 --strict 的布局警告原文喂回去重写该 spec。
 * 供 index.ts 在"成品已落盘但有布局警告"时用(照常交付,只是尽量把警告清掉)。
 */
export async function repairSpecWithWarnings(
  input: GenerateInput,
  taskId: string,
  plan: OutlinePlan,
  spec: DeckSpecJson,
  warnings: string[],
  research?: ResearchForSpec,
): Promise<DeckSpecJson> {
  if (isMockLLM()) return spec // fixture 是确定性的,重写没有意义
  // 修复轮也必须带真实图片池:否则 image 页会被降级成纯文字页(实测过一次)
  const images = usableImages(research || { facts: '', images: [] })
  const outcome = await attemptSpec(input, taskId, plan, images, {
    previousOutput: JSON.stringify(spec),
    errors: warnings,
  })
  if (outcome.spec) return outcome.spec
  throw new Error(`规格修复未通过校验:${outcome.errors.slice(0, 3).join(' | ')}`)
}

// ── 阶段 5:只修问题页 ──────────────────────────────────────────────────────

export interface PageRepairResult {
  spec: DeckSpecJson
  /** 真的被替换掉内容的页(1-based) */
  repairedPages: number[]
  /** 模型没给 / 给了空元素 / 编号越界的页 */
  missedPages: number[]
}

interface RawPagePatch {
  index?: unknown
  template?: unknown
  background?: unknown
  notes?: unknown
  elements?: unknown
}

/**
 * 按页修复:只把问题页交给模型重写,合并时非目标页保持原对象不变。
 *
 * 与 `repairSpecWithWarnings`(整份重写)的差别不只是成本:整份重写会顺手改动
 * 本来没问题的页,而视觉修复的验收标准是"只改了该改的"。合并 + 指纹比对
 * (见 review.ts 的 changedPages)一起构成这条验收。
 */
export async function repairSpecPages(
  input: GenerateInput,
  taskId: string,
  plan: OutlinePlan,
  spec: DeckSpecJson,
  targets: Array<{ page: number; lines: string[] }>,
  research?: ResearchForSpec,
): Promise<PageRepairResult> {
  const valid = targets
    .filter((target) => Number.isInteger(target.page) && target.page >= 1 && target.page <= spec.slides.length)
    .map((target) => ({ ...target, lines: target.lines.slice(0, 8) }))
  if (!valid.length) return { spec, repairedPages: [], missedPages: [] }
  // fixture 是确定性的,重写没有意义;修复轮也不该在 mock 下花钱
  if (isMockLLM()) return { spec, repairedPages: [], missedPages: valid.map((target) => target.page) }

  const images = usableImages(research || { facts: '', images: [] })
  const prompt = buildPageRepairPrompt(plan, spec, valid)
  const missed: number[] = []
  let lastErrors: string[] = []

  for (let attempt = 0; attempt < 2; attempt++) {
    const userContent = attempt === 0
      ? prompt
      : `${prompt}\n\n## 你上一次的输出被引擎拒绝了,逐条修掉这些错误后重新只输出 JSON\n`
        + lastErrors.slice(0, 12).map((error) => `- ${error}`).join('\n')
    const res = await chat({
      messages: [
        { role: 'system', content: SPEC_SYSTEM },
        { role: 'user', content: userContent },
      ],
      // 3-8 页的元素体量,留足推理空间
      maxTokens: 20000,
    })
    await addUsage(taskId, res.usage?.promptTokens ?? 0, res.usage?.completionTokens ?? 0)
    const parsed = parseJsonLoose<{ slides?: RawPagePatch[] }>(res.content || '')
    const patches = Array.isArray(parsed?.slides) ? parsed!.slides! : []
    if (!patches.length) {
      lastErrors = ['输出里没有 slides 数组,或者 slides 为空']
      continue
    }

    const mergedResult = mergePagePatches(spec, patches, plan, images, valid.map((target) => target.page))
    const merged = mergedResult.spec
    const repairedPages = mergedResult.repairedPages
    for (const target of valid) if (!repairedPages.includes(target.page)) missed.push(target.page)
    if (!repairedPages.length) {
      lastErrors = ['没有一页拿到有效元素(merged 为空)']
      continue
    }

    // 合并后仍要过一遍同一套确定性兜底与引擎校验
    enforceDeckDesign(merged, images, plan.pages)
    const fixed = fixSpecContrast(merged)
    if (fixed > 0) console.log(`[pipeline] 修复页对比度兜底:修正 ${fixed} 处`)
    const check = await checkSpec(merged)
    if (check.ok) return { spec: merged, repairedPages, missedPages: [...new Set(missed)] }
    lastErrors = check.errors
    console.warn(`[pipeline] 按页修复第 ${attempt + 1} 次未通过引擎校验:`, check.errors.slice(0, 5).join(' | '))
  }

  throw new Error(`按页修复未通过引擎校验:${lastErrors.slice(0, 3).join(' | ')}`)
}

/**
 * 页级补丁的合并规则(纯函数,可单测):
 *   - 只接受 `targets` 里的页码 —— 模型顺手改的非目标页一律丢弃;
 *   - 元素为空的补丁视为没改(index 越界同理);
 *   - 原型以**大纲**为准(模型改原型会连带改掉这一页的构图契约);
 *   - 背景/讲稿沿用模型给的值,没给就保留原来的。
 * 非目标页的对象是浅拷贝后原样保留,内容与键序都不动。
 */
export function mergePagePatches(
  spec: DeckSpecJson,
  patches: RawPagePatch[],
  plan: OutlinePlan,
  images: UsableImage[],
  targets: number[],
): { spec: DeckSpecJson; repairedPages: number[] } {
  const merged: DeckSpecJson = { ...spec, slides: spec.slides.map((slide) => ({ ...slide })) }
  const repairedPages: number[] = []
  for (const patch of patches) {
    const index = Number(patch.index)
    if (!Number.isInteger(index) || index < 1 || index > merged.slides.length) continue
    if (!targets.includes(index)) continue
    const elements = normaliseElements(patch.elements, images)
    if (!elements.length) continue
    const existing = merged.slides[index - 1]
    merged.slides[index - 1] = {
      template: plan.pages[index - 1]?.template || (typeof patch.template === 'string' ? patch.template : existing.template),
      background: typeof patch.background === 'string' && patch.background ? patch.background : existing.background,
      notes: typeof patch.notes === 'string' ? patch.notes : existing.notes,
      elements,
    }
    repairedPages.push(index)
  }
  return { spec: merged, repairedPages }
}
