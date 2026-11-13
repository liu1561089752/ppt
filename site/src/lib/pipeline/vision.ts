/**
 * pipeline/vision.ts — 审美检查(视觉模型辅助,可插拔、可缺席)
 *
 * 分工的边界,代码里也要守住:
 *   - 几何与像素层面的问题由 review.ts 用确定性代码判定,**不经过模型**;
 *   - 这里只回答"好不好看":视觉焦点有没有、层级清不清楚、留白是否合理、
 *     图文关系是否成立、和整份 deck 的风格是否一致。
 *
 * 为什么默认缺席:审美检查需要多模态模型,而多模态 key 未必存在。缺席时**不能**
 * 假装检查过 —— 返回 enabled:false,管线把它记进报告,页面上不出现"审美已通过"。
 *
 * 配置(全部走环境变量,密钥不入库、不进浏览器、不写日志):
 *   VISION_PROVIDER = none | openai  (openai = 任何 OpenAI 兼容的 /chat/completions)
 *   VISION_BASE_URL = https://api.moonshot.cn/v1   (必须含 /v1)
 *   VISION_API_KEY  = ...
 *   VISION_MODEL    = moonshot-v1-8k-vision-preview / gpt-4o-mini / ...
 *   VISION_MAX_PAGES = 25   每份 deck 最多检查多少页(默认 25)
 *   VISION_PAGES_PER_CALL = 3  一次请求带几张图(控成本)
 */
import { readFileSync } from 'fs'

export interface VisionProblem {
  code: string
  severity: 'warning' | 'info'
  detail: string
  advice?: string
}

export interface PageVisionReview {
  page: number
  /** good = 可交付;needs_work = 需要改;unknown = 模型没给判断 */
  verdict: 'good' | 'needs_work' | 'unknown'
  /** 0-100,只用于问题页排序,不作为交付判据 */
  score?: number
  /** 一句话说这一页的视觉问题(模型原话,已截断) */
  summary?: string
  problems: VisionProblem[]
}

export interface DeckVisionReview {
  enabled: boolean
  provider: string
  model?: string
  pages: PageVisionReview[]
  /** 未执行/失败的原因,原样进报告(不许把缺席写成通过) */
  note: string
  error?: string
  ms?: number
  calls?: number
}

const DEFAULT_MAX_PAGES = 25
const DEFAULT_PAGES_PER_CALL = 3
const REQUEST_TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS || 120_000)

function provider(): string {
  return (process.env.VISION_PROVIDER || 'none').trim().toLowerCase()
}

function apiKey(): string {
  return (process.env.VISION_API_KEY || '').trim()
}

function modelName(): string {
  return (process.env.VISION_MODEL || '').trim()
}

function baseUrl(): string {
  const configured = (process.env.VISION_BASE_URL || '').trim()
  return (configured || 'https://api.moonshot.cn/v1').replace(/\/$/, '')
}

/** 是否具备执行审美检查的条件(缺任何一项都算未配置) */
export function visionConfigured(): boolean {
  const kind = provider()
  return (kind === 'openai' || kind === 'moonshot') && !!apiKey() && !!modelName()
}

function maxPages(): number {
  const raw = Number(process.env.VISION_MAX_PAGES)
  return Number.isFinite(raw) && raw > 0 ? Math.min(60, Math.floor(raw)) : DEFAULT_MAX_PAGES
}

function pagesPerCall(): number {
  const raw = Number(process.env.VISION_PAGES_PER_CALL)
  return Number.isFinite(raw) && raw > 0 ? Math.min(6, Math.floor(raw)) : DEFAULT_PAGES_PER_CALL
}

const SYSTEM_PROMPT = `你是演示文稿的视觉审稿人。你看到的是同一份 PPT 的若干页渲染图(从左到右按顺序)。
只判断"看起来好不好",不要判断内容对错,也不要评价数据真实性。

对每一页回答:
- 视觉焦点是否明确(观众第一眼该看什么);
- 层级是否清楚(标题/正文/注释是否一眼可分);
- 留白是否合理(过空 / 过挤 都要说);
- 图文关系是否成立(图片是否在承担叙事,还是只是装饰);
- 版面是否与"专业演示文稿"的预期相符(而不是后台报表、字典条目或简单列表)。

严格输出 JSON,不要代码块包裹:
{"pages":[{"page":<页码>,"verdict":"good|needs_work","score":<0-100>,
"summary":"一句话说这一页的视觉问题(没有就写空字符串)",
"problems":[{"code":"WEAK_FOCUS|NO_HIERARCHY|TOO_EMPTY|TOO_CROWDED|WEAK_IMAGE_RELATION|GENERIC_CARDS|INCONSISTENT_STYLE","severity":"warning|info","detail":"问题描述","advice":"这一页该怎么改(内容与结构层面,不要写坐标)"}]}]}
没有问题的页用一个 verdict:"good" 的对象表示,problems 为空数组。`

interface VisionRequestPage {
  page: number
  file: string
}

function toDataUrl(file: string): string | null {
  try {
    const buffer = readFileSync(file)
    if (!buffer.length) return null
    return `data:image/png;base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/** 从模型输出里挖出 JSON(容忍代码块与前后废话);导出以便单测 */
export function parseVisionReview(text: string): PageVisionReview[] | null {
  const trimmed = String(text || '').trim()
  const candidates: string[] = []
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1])
  candidates.push(trimmed)
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { pages?: unknown }
      if (!parsed || !Array.isArray(parsed.pages)) continue
      const pages: PageVisionReview[] = []
      for (const item of parsed.pages as Array<Record<string, unknown>>) {
        const page = Number(item.page)
        if (!Number.isFinite(page)) continue
        const problems: VisionProblem[] = Array.isArray(item.problems)
          ? (item.problems as Array<Record<string, unknown>>).map((problem): VisionProblem => ({
              code: String(problem.code || 'VISION_ISSUE'),
              severity: problem.severity === 'info' ? 'info' : 'warning',
              detail: String(problem.detail || '').slice(0, 300),
              advice: problem.advice ? String(problem.advice).slice(0, 300) : undefined,
            })).filter((problem) => problem.detail)
          : []
        const verdict = item.verdict === 'good' || item.verdict === 'needs_work' ? item.verdict : 'unknown'
        pages.push({
          page,
          verdict,
          score: Number.isFinite(Number(item.score)) ? Math.max(0, Math.min(100, Number(item.score))) : undefined,
          summary: item.summary ? String(item.summary).slice(0, 300) : undefined,
          problems,
        })
      }
      return pages.length ? pages : null
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

/**
 * 对渲染出来的若干页做审美检查。
 * - 未配置 → enabled:false + note 说明未执行(调用方必须如实记录);
 * - 单批失败不影响其它批,失败批的页记为 unknown,error 里留最后一次原因。
 */
export async function reviewDeckVisually(pages: VisionRequestPage[]): Promise<DeckVisionReview> {
  const startedAt = Date.now()
  if (!visionConfigured()) {
    return {
      enabled: false,
      provider: provider(),
      pages: [],
      note: '未配置视觉模型(VISION_PROVIDER / VISION_API_KEY / VISION_MODEL):审美检查未执行,'
        + '几何与像素检查不受影响',
    }
  }
  const targets = pages.slice(0, maxPages())
  if (!targets.length) {
    return { enabled: false, provider: provider(), pages: [], note: '没有可检查的渲染页(渲染未成功)' }
  }
  const batchSize = pagesPerCall()
  const reviewed: PageVisionReview[] = []
  let calls = 0
  let lastError: string | undefined

  for (let offset = 0; offset < targets.length; offset += batchSize) {
    const batch = targets.slice(offset, offset + batchSize)
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: `这是第 ${batch[0].page}–${batch[batch.length - 1].page} 页,共 ${batch.length} 张。` },
    ]
    for (const page of batch) {
      const data = toDataUrl(page.file)
      if (!data) continue
      content.push({ type: 'text', text: `第 ${page.page} 页:` })
      content.push({ type: 'image_url', image_url: { url: data } })
    }
    if (content.length <= 1) continue
    calls++
    try {
      const response = await fetch(`${baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify({
          model: modelName(),
          temperature: 0.2,
          max_tokens: 2000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content },
          ],
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`视觉模型 HTTP ${response.status}:${(await response.text()).slice(0, 200)}`)
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
      const text = payload.choices?.[0]?.message?.content || ''
      const parsed = parseVisionReview(text)
      if (!parsed) throw new Error(`视觉模型输出无法解析:${text.slice(0, 200)}`)
      // 只接受本批请求过的页码,模型编号跑偏时不要把问题安到别的页上
      const wanted = new Set(batch.map((page) => page.page))
      for (const page of parsed) if (wanted.has(page.page)) reviewed.push(page)
    } catch (error) {
      lastError = (error as Error).message
      console.warn('[vision] 审美检查失败:', lastError)
    }
  }

  const covered = new Set(reviewed.map((page) => page.page))
  for (const page of targets) {
    if (!covered.has(page.page)) reviewed.push({ page: page.page, verdict: 'unknown', problems: [] })
  }
  reviewed.sort((a, b) => a.page - b.page)
  return {
    enabled: true,
    provider: provider(),
    model: modelName(),
    pages: reviewed,
    note: lastError
      ? `审美检查部分失败(${reviewed.filter((p) => p.verdict === 'unknown').length} 页无结论):${lastError}`
      : `审美检查完成:${reviewed.length} 页,${calls} 次调用`,
    error: lastError,
    ms: Date.now() - startedAt,
    calls,
  }
}
