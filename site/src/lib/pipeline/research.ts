/**
 * Stage 2: research with traceable web evidence and locally available image assets.
 * Two image passes:
 *   1) topic-level candidates, so the planner knows what imagery exists at all;
 *   2) after the outline, `enrichResearchForPlan` searches each *page's* English scene
 *      keyword and binds a concrete photo to that page.
 * Candidate images are downloaded here, but Unsplash download tracking is triggered
 * only after a page brief actually selects an image.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { extname, join, resolve } from 'path'
import { PATHS } from '@/lib/config'
import { setProgress, emitEvent } from './events'
import type { GenerateInput, OutlinePlan } from './types'
import { isMockLLM, mockResearch } from './mock'
import { webSearchDetailed, hasBochaKey, type SearchSource } from '@/lib/search-client'
import { hasLLMKey } from '@/lib/kimi-client'
import { hasUnsplashKey, searchPhotos, triggerDownload, type UnsplashPhoto } from '@/lib/unsplash-client'
import { buildSearchQueries } from '@/lib/pptx-prompts'

export interface ResearchImage extends UnsplashPhoto {
  localPath?: string
  licence: string
  searchQuery: string
  /** 这一张图是为第几页(1-based)检索来的;undefined = 主题级候选池 */
  page?: number
  /** 检索来源:topic = 主题级候选,page = 页面级检索 */
  origin?: 'topic' | 'page'
}
export interface ResearchResult {
  facts: string
  sources: SearchSource[]
  images: ResearchImage[]
  researchQueries: string[]
}

/** 页面级检索的硬上限:Unsplash demo 配额 50/h,25 页稿不能每页都搜。 */
const MAX_PAGE_IMAGE_SEARCHES = 6
/** 单页候选数(逐个试下载,失败就换下一张) */
const CANDIDATES_PER_PAGE = 6
/** 幻灯片是 13.33×7.5 英寸的横版画布:太小的图放大会糊 */
const MIN_IMAGE_WIDTH = 1200
/** 横版可接受的长宽比区间;竖版另有一套(见 orientationFor) */
const LANDSCAPE_RATIO = { min: 1.25, max: 2.4 }
const PORTRAIT_RATIO = { min: 0.5, max: 0.85 }

function uniqueSources(sources: SearchSource[]): SearchSource[] {
  const seen = new Set<string>()
  return sources.filter((source) => {
    const key = source.url.trim().replace(/\/$/, '').toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
function toImageKeyword(topic: string): string {
  return topic.replace(/ppt|幻灯片|演示文稿/gi, '').trim() || topic
}

/** 下载单张图;失败返回 undefined(调用方换下一张候选) */
async function downloadOne(url: string, target: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000), cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1024) throw new Error(`图片体积异常：${buffer.length}B`)
    let extension = '.jpg'
    try {
      const rawExt = extname(new URL(url).pathname).toLowerCase()
      if (['.jpg', '.jpeg', '.png', '.webp'].includes(rawExt)) extension = rawExt
    } catch {
      /* URL 解析不出扩展名就用 jpg */
    }
    const file = target.replace(/\.[a-z0-9]+$/iu, '') + extension
    writeFileSync(file, buffer)
    return file
  } catch (error) {
    console.warn('[pipeline] 配图下载失败:', (error as Error).message)
    return undefined
  }
}

async function downloadImages(
  input: GenerateInput,
  taskId: string,
  photos: Array<UnsplashPhoto & { searchQuery: string }>,
): Promise<ResearchImage[]> {
  const images: ResearchImage[] = photos.map((photo) => ({
    ...photo,
    licence: 'Unsplash License',
    origin: 'topic',
  }))
  if (!images.length) return images
  const dir = resolve(PATHS.generated, input.userId, input.taskId, 'media')
  try { mkdirSync(dir, { recursive: true }) } catch (error) {
    console.warn('[pipeline] 配图目录创建失败:', (error as Error).message)
    return images
  }
  let failed = 0
  for (let index = 0; index < images.length; index++) {
    const image = images[index]
    const file = await downloadOne(image.url, join(dir, `image_${String(index + 1).padStart(2, '0')}.jpg`))
    if (file) image.localPath = file
    else failed++
  }
  if (failed) await emitEvent(taskId, 'status', {
    status: 'generating',
    stage: `配图下载完成 ${images.length - failed}/${images.length} 张（${failed} 张不可用）`,
  })
  return images
}

export async function stage2Research(input: GenerateInput, taskId: string): Promise<ResearchResult> {
  await setProgress(taskId, 'generating', 10, '调研资料与配图')
  if (isMockLLM()) {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '调研资料（mock fixture）…' })
    const fixture = mockResearch(input.topic)
    await setProgress(taskId, 'generating', 25, '资料就绪（0 张配图）')
    return { facts: fixture.facts, sources: [], images: [], researchQueries: [] }
  }

  // buildSearchQueries currently provides three complementary research angles.
  const researchQueries = buildSearchQueries(input.topic)
  const sources: SearchSource[] = []
  const sections: string[] = []
  if (hasBochaKey() || hasLLMKey()) {
    await emitEvent(taskId, 'status', {
      status: 'generating',
      stage: hasBochaKey() ? '正在通过博查研究资料…' : '正在通过 AI 搜索通道研究资料…',
    })
    for (const query of researchQueries) {
      try {
        await emitEvent(taskId, 'tool_call', { name: 'web_search', args: query })
        const result = await webSearchDetailed(query)
        if (result.text.trim()) {
          sections.push(`### 研究问题：${query}（通道：${result.provider}）\n${result.text.slice(0, 2800)}`)
          sources.push(...result.sources)
          await emitEvent(taskId, 'tool_response', {
            name: `web_search(${result.provider})`, status: 'completed', text: result.text.slice(0, 500),
          })
        }
      } catch (error) {
        console.warn('[pipeline] 搜索失败:', (error as Error).message)
      }
    }
  } else {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '未配置联网搜索，使用模型内置知识…' })
  }

  // 主题级候选只要横版、要够大:竖版图放进 13.33×7.5 的画布只能靠裁切,先不搜
  const photos: Array<UnsplashPhoto & { searchQuery: string }> = []
  if (hasUnsplashKey()) {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '正在搜索主题视觉素材…' })
    const queries = Array.from(new Set([input.topic, toImageKeyword(input.topic)])).filter(Boolean)
    for (const query of queries) {
      try {
        const found = await searchPhotos(query, 6, 'landscape')
        photos.push(...found.filter(isUsablePhoto).map((photo) => ({ ...photo, searchQuery: query })))
        if (photos.length >= 6) break
      } catch (error) {
        console.warn('[pipeline] 配图搜索失败:', (error as Error).message)
      }
    }
  }
  const seen = new Set<string>()
  const uniquePhotos = photos.filter((photo) => {
    if (seen.has(photo.id)) return false
    seen.add(photo.id)
    return true
  }).slice(0, 6)
  const images = await downloadImages(input, taskId, uniquePhotos)
  const unique = uniqueSources(sources)
  const validImages = images.filter((image) => image.localPath).length
  await setProgress(taskId, 'generating', 25, `资料就绪（${unique.length} 个来源，${validImages} 张配图）`)
  return { facts: sections.join('\n\n'), sources: unique, images, researchQueries }
}

/**
 * 候选图能不能用作幻灯片配图:要么够宽(放大不糊),要么比例适合横版构图。
 * Unsplash 的 orientation=landscape 本身已经筛过一遍,这里再兜一层尺寸。
 */
function isUsablePhoto(photo: UnsplashPhoto): boolean {
  const width = Number(photo.width)
  const height = Number(photo.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  if (width < MIN_IMAGE_WIDTH) return false
  const ratio = width / height
  return ratio >= LANDSCAPE_RATIO.min && ratio <= LANDSCAPE_RATIO.max
}

/** 页面级检索的版式偏好:视觉意图里明确要竖构图才搜竖版 */
function orientationFor(plan: { template?: string; visualIntent?: string }): 'landscape' | 'portrait' {
  const intent = String(plan.visualIntent || '')
  if (/竖向|竖版|竖构图|portrait|直幅/i.test(intent) || /\bportrait\b/i.test(plan.template || '')) return 'portrait'
  return 'landscape'
}

function ratioOk(photo: UnsplashPhoto, orientation: 'landscape' | 'portrait'): boolean {
  const width = Number(photo.width)
  const height = Number(photo.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  const ratio = width / height
  if (orientation === 'portrait') {
    return width >= 900 && height >= 1200 && ratio >= PORTRAIT_RATIO.min && ratio <= PORTRAIT_RATIO.max
  }
  return isUsablePhoto(photo)
}

export interface PageImageBinding {
  /** 1-based 页码 */
  page: number
  template: string
  query: string
  imageId?: string
  localPath?: string
  reason?: string
}

export interface EnrichReport {
  searched: number
  bound: number
  usedQuota: boolean
  bindings: PageImageBinding[]
  skipped: Array<{ page: number; reason: string }>
}

/**
 * Stage 3.5:页面级配图检索。
 *
 * 大纲决定"哪几页真的需要图"(image 原型页 / 给了 image_query 的页),这里只对这些页
 * 用**该页自己的英文场景词**去 Unsplash 检索,再把一张具体照片绑定到该页:
 *   - 尺寸与横竖比例筛选(横版 >= 1200px、比例 1.25–2.4;竖版 0.5–0.85)
 *   - 跨页去重(一张图只用一次,含主题级候选池里已占用的)
 *   - 逐张试下载:第一张下不下来就换下一张(图片失败替换机制)
 *   - 绑定写回 PageOutline.imageId,并把 image_id 追加进 brief(规格阶段据此选图,
 *     trackChosenImages 据此触发 Unsplash download 统计)
 *
 * 没有 Unsplash key / mock 模式下直接跳过,不影响大纲与后续规格。
 */
export async function enrichResearchForPlan(
  input: GenerateInput,
  taskId: string,
  plan: OutlinePlan,
  research: ResearchResult,
): Promise<EnrichReport> {
  const report: EnrichReport = { searched: 0, bound: 0, usedQuota: false, bindings: [], skipped: [] }
  const pages = Array.isArray(plan.pages) ? plan.pages : []
  if (isMockLLM()) {
    for (const page of pages) if (page.template === 'image') report.skipped.push({ page: pages.indexOf(page) + 1, reason: 'mock 模式不检索图库' })
    return report
  }
  if (!hasUnsplashKey()) {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '未配置 Unsplash，本次不检索页面级配图' })
    return report
  }

  // 候选页:image 原型页优先级最高,其次才是有 image_query 的页
  const wantsImage = (page: { template?: string; imageQuery?: string }): boolean =>
    page.template === 'image' || !!String(page.imageQuery || '').trim()
  const candidates = pages
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => wantsImage(page))
    .sort((a, b) => Number(b.page.template === 'image') - Number(a.page.template === 'image') || a.index - b.index)
  if (!candidates.length) {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '大纲未要求配图，跳过图库检索' })
    return report
  }

  const dir = resolve(PATHS.generated, input.userId, input.taskId, 'media')
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    console.warn('[pipeline] 页面级配图目录创建失败:', (error as Error).message)
    return report
  }

  const usedIds = new Set(research.images.map((image) => image.id).filter(Boolean))
  // 主题级可能已经把词搜过一遍(缓存命中不耗配额),这里按页继续花配额
  await emitEvent(taskId, 'status', {
    status: 'generating',
    stage: `正在为 ${Math.min(candidates.length, MAX_PAGE_IMAGE_SEARCHES)} 页检索匹配配图…`,
  })

  for (const { page, index } of candidates) {
    if (report.searched >= MAX_PAGE_IMAGE_SEARCHES) {
      report.usedQuota = true
      report.skipped.push({ page: index + 1, reason: `已用完 ${MAX_PAGE_IMAGE_SEARCHES} 次页面级检索配额` })
      continue
    }
    const query = (String(page.imageQuery || '').trim() || `${input.topic} ${page.template}`).slice(0, 120)
    const orientation = orientationFor(page)
    report.searched++
    let found: UnsplashPhoto[] = []
    try {
      found = await searchPhotos(query, CANDIDATES_PER_PAGE, orientation)
    } catch (error) {
      console.warn(`[pipeline] 第 ${index + 1} 页配图检索失败:`, (error as Error).message)
      report.skipped.push({ page: index + 1, reason: `检索失败:${(error as Error).message}` })
      continue
    }
    const usable = found.filter((photo) => !usedIds.has(photo.id) && ratioOk(photo, orientation))
    if (!usable.length) {
      report.skipped.push({
        page: index + 1,
        reason: found.length ? '候选图尺寸/比例不合适或已被其它页使用' : '图库无结果',
      })
      continue
    }
    let bound: ResearchImage | undefined
    for (const photo of usable.slice(0, 3)) {
      const file = await downloadOne(
        photo.url,
        join(dir, `page_${String(index + 1).padStart(2, '0')}_${photo.id.slice(0, 8)}.jpg`),
      )
      if (!file) continue
      bound = { ...photo, localPath: file, licence: 'Unsplash License', searchQuery: query, page: index + 1, origin: 'page' }
      break
    }
    if (!bound) {
      report.skipped.push({ page: index + 1, reason: '候选图全部下载失败' })
      continue
    }
    usedIds.add(bound.id)
    research.images.push(bound)
    page.imageId = bound.id
    // 只追加标记,不改写模型写的 brief 正文
    const marker = `image_id=${bound.id}`
    if (!page.brief.includes(marker)) page.brief = `${page.brief}\n[配图] ${marker} · 画面:${bound.description || query}`
    report.bindings.push({
      page: index + 1,
      template: page.template,
      query,
      imageId: bound.id,
      localPath: bound.localPath,
    })
    report.bound++
  }

  await emitEvent(taskId, 'status', {
    status: 'generating',
    stage: `页面级配图就绪:${report.bound}/${report.searched} 页(另有 ${report.skipped.length} 页无合适图)`,
  })
  return report
}

/**
 * Track only images actually referenced by a page brief or bound to a page.
 * Candidate discovery is not a download use, so it must not spend tracking calls.
 */
export function trackChosenImages(images: ResearchImage[], briefs: string[], boundIds: string[] = []): void {
  const bound = new Set(boundIds.filter(Boolean))
  for (const image of images) {
    if (!image.localPath) continue
    const referenced = bound.has(image.id)
      || briefs.some((brief) => brief.includes(image.url) || brief.includes(image.id))
    if (referenced) void triggerDownload(image)
  }
}
