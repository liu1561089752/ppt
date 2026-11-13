/**
 * pipeline/plan.ts — Stage 3:大纲(只在"讲什么"层面做决定)
 *
 * 产出:标题 + 风格名 + 引擎主题预设名 + 每页 { title, template, brief }。
 * 这里**不再**产出任何 CSS/排版/色值 —— 样式由 theme.ts 的预设决定,
 * 坐标由引擎的布局引擎算。LLM 在这一步唯一的自由度是"讲什么、按什么原型讲"。
 */
import { setProgress, emitEvent, addUsage } from './events'
import type { GenerateInput, OutlinePlan, PageOutline } from './types'
import { chat, parseJsonLoose } from '@/lib/kimi-client'
import { PAGE_ARCHETYPES, buildPlanPrompt, type SpecSourceImage } from '@/lib/pptx-prompts'
import { isMockLLM, mockOutline } from './mock'
import { normalizePreset } from './theme'

export interface ResearchForPlan {
  facts: string
  images: Array<{
    id?: string
    url: string
    description: string
    author?: string
    pageUrl?: string
    /** 已落盘路径;为空表示这张图不可用,不得进大纲 */
    localPath?: string
    licence?: string
  }>
}

export async function stage3Plan(
  input: GenerateInput,
  taskId: string,
  research: ResearchForPlan,
): Promise<OutlinePlan> {
  await setProgress(taskId, 'generating', 30, '规划大纲')
  await emitEvent(taskId, 'status', { status: 'generating', stage: '正在规划页面大纲…' })

  // 无密钥自测:确定性大纲(覆盖 ≥4 种模板)
  if (isMockLLM()) {
    const plan = mockOutline(input)
    await emitEvent(taskId, 'status', {
      status: 'generating',
      stage: `大纲就绪:${plan.pages.length} 页(mock fixture)`,
    })
    return plan
  }

  const images: SpecSourceImage[] = research.images.map((image) => ({
    id: image.id,
    url: image.url,
    path: image.localPath,
    caption: image.description,
    author: image.author,
    pageUrl: image.pageUrl,
    licence: image.licence,
  }))

  const prompt = buildPlanPrompt({
    topic: input.topic,
    audience: input.audience || undefined,
    tone: input.tone || undefined,
    preset: input.preset || undefined,
    customStyle: input.customStyle || undefined,
    // M-33:用户的额外要求必须透传进规划提示词,否则表单收集等于白收集
    customRequirements: input.customRequirements || undefined,
    language: input.language,
    slideCount: input.slideCount,
    facts: research.facts,
    images,
  })

  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await chat({
        messages: [
          { role: 'system', content: PLAN_SYSTEM },
          { role: 'user', content: prompt },
        ],
        // 推理模型的思考过程计入 max_tokens,预算不足会被截断成空正文
        maxTokens: 16000,
      })
      await addUsage(taskId, res.usage?.promptTokens ?? 0, res.usage?.completionTokens ?? 0)
      const plan = parsePlan(res.content, input)
      await emitEvent(taskId, 'status', {
        status: 'generating',
        stage: `大纲就绪:${plan.pages.length} 页(${plan.styleName} / ${plan.preset})`,
      })
      return plan
    } catch (e) {
      lastErr = e as Error
      console.warn(`[pipeline] 大纲第 ${attempt + 1} 次失败:`, (e as Error).message)
      if (attempt < 2) await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)))
    }
  }
  throw new Error(`大纲阶段失败: ${lastErr?.message}`)
}

/** 系统侧只留一句身份约束:S3 的字段/格式契约写在 buildPlanPrompt 里(单一真源) */
const PLAN_SYSTEM = '你是一位资深演示文稿策划。只决定"讲什么、按什么页面原型讲",不写任何样式、坐标或 CSS。'

interface RawPlanPage {
  title?: string
  template?: string
  brief?: string
  task_brief?: string
  summary?: string
}

interface RawPlan {
  title?: string
  style_name?: string
  styleName?: string
  preset?: string
  theme_preset?: string
  pages?: RawPlanPage[]
  slides?: RawPlanPage[]
}

/** 解析 + 收敛:模板名必须在原型白名单内,页数按 slideCount 补齐/截断 */
function parsePlan(content: string, input: GenerateInput): OutlinePlan {
  const raw = parseJsonLoose<RawPlan>(content)
  if (!raw || typeof raw !== 'object') throw new Error('大纲不是合法 JSON')
  const rawPages = Array.isArray(raw.pages) ? raw.pages : Array.isArray(raw.slides) ? raw.slides : []
  if (rawPages.length === 0) throw new Error('大纲缺少 pages[]')

  const pages: PageOutline[] = rawPages.slice(0, input.slideCount).map((page, index) => ({
    title: (page.title || `第 ${index + 1} 页`).trim(),
    template: normaliseTemplate(page.template, index),
    brief: (page.brief || page.task_brief || page.summary || '').trim(),
  }))
  // 补齐不足的页数:用 content 原型 + 主题相关的兜底要点,不留空洞
  while (pages.length < input.slideCount) {
    const index = pages.length
    pages.push({
      title: `补充要点 ${index + 1}`,
      template: index === input.slideCount - 1 ? 'section' : 'content',
      brief: `围绕"${input.topic}"补充一条独立要点,3-4 句说明。`,
    })
  }
  return {
    title: (raw.title || input.topic).trim(),
    styleName: (raw.style_name || raw.styleName || '现代简约').trim(),
    preset: normalizePreset(raw.preset || raw.theme_preset || input.preset),
    pages,
  }
}

/** 原型白名单与别名收敛(白名单 = pptx-prompts 的 PAGE_ARCHETYPES,单一真源) */
function normaliseTemplate(candidate: string | undefined, index: number): string {
  const key = (candidate || '').trim().toLowerCase()
  const allowed = PAGE_ARCHETYPES as readonly string[]
  // chart / image 是白名单里的合法原型,必须原样保留 —— 预览卡按它显示页面类型,
  // 收敛成 hero 会让"图表页"在预览里显示成错的原型名。
  if (allowed.includes(key)) return key
  const alias: Record<string, string> = {
    title: 'cover',
    intro: 'cover',
    agenda: 'content',
    bullets: 'content',
    bullet: 'content',
    text: 'content',
    list: 'content',
    stats: 'kpi',
    numbers: 'kpi',
    metrics: 'kpi',
    compare: 'comparison',
    contrast: 'comparison',
    data: 'chart',
    chart: 'chart',
    image: 'image',
    photo: 'image',
    picture: 'image',
    closing: 'section',
    end: 'section',
    thanks: 'section',
    summary: 'section',
  }
  if (alias[key]) return alias[key]
  // 未知标签:首页按封面,其余按内容页
  return index === 0 ? 'cover' : 'content'
}
