/**
 * Stage 2: research with traceable web evidence and locally available image assets.
 * Candidate images are downloaded here, but Unsplash download tracking is triggered
 * only after a page brief actually selects an image.
 */
import { mkdirSync, writeFileSync } from 'fs'
import { extname, join, resolve } from 'path'
import { PATHS } from '@/lib/config'
import { setProgress, emitEvent } from './events'
import type { GenerateInput } from './types'
import { isMockLLM, mockResearch } from './mock'
import { webSearchDetailed, hasBochaKey, type SearchSource } from '@/lib/search-client'
import { hasLLMKey } from '@/lib/kimi-client'
import { hasUnsplashKey, searchPhotos, triggerDownload, type UnsplashPhoto } from '@/lib/unsplash-client'
import { buildSearchQueries } from '@/lib/pptx-prompts'

export interface ResearchImage extends UnsplashPhoto {
  localPath?: string
  licence: string
  searchQuery: string
}
export interface ResearchResult {
  facts: string
  sources: SearchSource[]
  images: ResearchImage[]
  researchQueries: string[]
}

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

async function downloadImages(
  input: GenerateInput,
  taskId: string,
  photos: Array<UnsplashPhoto & { searchQuery: string }>,
): Promise<ResearchImage[]> {
  const images: ResearchImage[] = photos.map((photo) => ({ ...photo, licence: 'Unsplash License' }))
  if (!images.length) return images
  const dir = resolve(PATHS.generated, input.userId, input.taskId, 'media')
  try { mkdirSync(dir, { recursive: true }) } catch (error) {
    console.warn('[pipeline] 配图目录创建失败:', (error as Error).message)
    return images
  }
  let failed = 0
  for (let index = 0; index < images.length; index++) {
    const image = images[index]
    try {
      const response = await fetch(image.url, { signal: AbortSignal.timeout(20_000), cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 1024) throw new Error(`图片体积异常：${buffer.length}B`)
      const rawExt = extname(new URL(image.url).pathname).toLowerCase()
      const extension = ['.jpg', '.jpeg', '.png', '.webp'].includes(rawExt) ? rawExt : '.jpg'
      const file = join(dir, `image_${String(index + 1).padStart(2, '0')}${extension}`)
      writeFileSync(file, buffer)
      image.localPath = file
    } catch (error) {
      failed++
      console.warn(`[pipeline] 配图下载失败(${image.id}):`, (error as Error).message)
    }
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

  const photos: Array<UnsplashPhoto & { searchQuery: string }> = []
  if (hasUnsplashKey()) {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '正在搜索主题视觉素材…' })
    const queries = Array.from(new Set([input.topic, toImageKeyword(input.topic)])).filter(Boolean)
    for (const query of queries) {
      try {
        const found = await searchPhotos(query, 4, 'landscape')
        photos.push(...found.map((photo) => ({ ...photo, searchQuery: query })))
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

/** Track only images referenced by page briefs; candidate discovery is not a download use. */
export function trackChosenImages(images: ResearchImage[], briefs: string[]): void {
  for (const image of images) {
    if (image.localPath && briefs.some((brief) => brief.includes(image.url) || brief.includes(image.id))) {
      void triggerDownload(image)
    }
  }
}
