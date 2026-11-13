/**
 * pipeline/research.ts — Stage 2:调研(真实资料 + 配图)
 *
 * 联网搜索:博查主力 → Kimi Formula → 知识摘要(search-client 内部降级,永不抛错)
 * 配图:Unsplash 搜索 → **这里就下载落盘**。
 *
 * 为什么配图在 S2 落盘:原生引擎的 image 元素只认本地文件或 data: URI(engine/image_fit.js:296),
 * 不认远程热链;而 S3 大纲要按"有没有可用配图"决定要不要排 image 原型,所以路径必须在
 * S3 之前就存在。落盘位置:PATHS.generated/<userId>/<taskId>/media/。
 *
 * HTML 时代随链路一起删掉的东西:任务目录里的样式表与大纲副本、以及每页一个 HTML 文件。
 * 现在任务目录下只有 .pptx 与本模块落盘的 media/。
 */
import { mkdirSync, writeFileSync } from 'fs'
import { extname, join, resolve } from 'path'
import { PATHS } from '@/lib/config'
import { setProgress, emitEvent } from './events'
import type { GenerateInput } from './types'
import { isMockLLM, mockResearch } from './mock'
import { webSearch, hasBochaKey } from '@/lib/search-client'
import { hasLLMKey } from '@/lib/kimi-client'
import { hasUnsplashKey, searchPhotos, triggerDownload, type UnsplashPhoto } from '@/lib/unsplash-client'
import { buildSearchQueries } from '@/lib/pptx-prompts'

/** 一张可用配图:Unsplash 元数据 + 本地路径(S4 直接抄进 image.path) */
export interface ResearchImage extends UnsplashPhoto {
  /** 已落盘的绝对路径;下载失败的图没有这个字段,不得进 deck */
  localPath?: string
  /** 许可名(引擎 schema 要求 image.credit.licence 非空) */
  licence: string
}

export interface ResearchResult {
  facts: string
  images: ResearchImage[]
}

/** 中文主题转图库关键词(图库英文更友好) */
function toImageKeyword(topic: string): string {
  const cleaned = topic.replace(/ppt|PPT|幻灯片|演示文稿/g, '').trim()
  return cleaned || topic
}

/**
 * 下载到任务目录。单张失败只丢这一张(版面照常生成),但要在事件流里留痕 ——
 * 静默少一张图,后面就是"为什么这页没图"的排查成本。
 */
async function downloadImages(
  input: GenerateInput,
  taskId: string,
  photos: UnsplashPhoto[],
): Promise<ResearchImage[]> {
  const withLicence: ResearchImage[] = photos.map((photo) => ({ ...photo, licence: 'Unsplash License' }))
  if (!withLicence.length) return []
  // 绝对路径:引擎子进程的 cwd 是引擎根,相对路径会被它解析到别处(实测踩过)
  const dir = resolve(PATHS.generated, input.userId, input.taskId, 'media')
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    console.warn('[pipeline] 配图目录创建失败:', (e as Error).message)
    return withLicence
  }
  let failed = 0
  for (let index = 0; index < withLicence.length; index++) {
    const image = withLicence[index]
    try {
      const res = await fetch(image.url, { signal: AbortSignal.timeout(20_000), cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length < 1024) throw new Error(`体积异常 ${buffer.length}B`)
      const rawExt = extname(new URL(image.url).pathname).toLowerCase()
      const ext = ['.jpg', '.jpeg', '.png', '.webp'].includes(rawExt) ? rawExt : '.jpg'
      const file = join(dir, `image_${String(index + 1).padStart(2, '0')}${ext}`)
      writeFileSync(file, buffer)
      image.localPath = file
      // Unsplash 合规:图片一经使用即触发下载统计(这里就是"使用"的时刻)
      void triggerDownload(image)
    } catch (e) {
      failed++
      console.warn(`[pipeline] 配图下载失败(${image.id}):`, (e as Error).message)
    }
  }
  if (failed > 0) {
    await emitEvent(taskId, 'status', {
      status: 'generating',
      stage: `配图下载完成 ${withLicence.length - failed}/${withLicence.length} 张(${failed} 张不可用,不进版面)`,
    })
  }
  return withLicence
}

export async function stage2Research(input: GenerateInput, taskId: string): Promise<ResearchResult> {
  await setProgress(taskId, 'generating', 10, '调研资料与配图')

  // 无密钥自测:确定性事实文本,不联网、不花额度
  if (isMockLLM()) {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '调研资料(mock fixture)…' })
    const fixture = mockResearch(input.topic)
    await setProgress(taskId, 'generating', 25, '资料就绪(0 张配图)')
    return { facts: fixture.facts, images: [] }
  }

  // M-34:状态行按实际能力措辞 —— 有博查 key 才宣告"联网搜索";
  // 无博查但有 LLM key 时,search-client 的降级链(Kimi Formula → 知识摘要)仍真实可用;
  // 两者皆无则如实告知使用模型内置知识,不虚假宣告联网。
  const onlineSearchAvailable = hasBochaKey() || hasLLMKey()
  if (hasBochaKey()) {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '正在联网搜索资料…' })
  } else if (hasLLMKey()) {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '正在通过 AI 搜索通道检索资料…' })
  } else {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '未配置联网搜索,使用模型内置知识…' })
  }

  // 1. 联网搜索事实(2 条查询)。search-client 内部三级降级(博查→Kimi Formula→知识摘要),
  //    永不抛错;只要任一 key 存在就走,让"联网搜索"真实可用而非空转。
  let facts = ''
  if (onlineSearchAvailable) {
    const queries = buildSearchQueries(input.topic).slice(0, 2)
    const parts: string[] = []
    for (const q of queries) {
      try {
        await emitEvent(taskId, 'tool_call', { name: 'web_search', args: q })
        const { text: summary, provider } = await webSearch(q)
        if (summary) {
          parts.push(`### ${q}\n${summary.slice(0, 2000)}`)
          await emitEvent(taskId, 'tool_response', { name: `web_search(${provider})`, status: 'completed', text: summary.slice(0, 400) })
        }
      } catch (e) {
        console.warn('[pipeline] 搜索失败:', (e as Error).message)
      }
    }
    facts = parts.join('\n\n')
  }

  // 2. 搜配图(Unsplash)+ 落盘
  let photos: UnsplashPhoto[] = []
  if (hasUnsplashKey()) {
    await emitEvent(taskId, 'status', { status: 'generating', stage: '正在搜索配图…' })
    const queries = [input.topic, toImageKeyword(input.topic)]
    for (const q of queries) {
      try {
        const found = await searchPhotos(q, 4, 'landscape')
        if (found.length > 0) {
          photos.push(...found)
          if (photos.length >= 6) break
        }
      } catch (e) {
        console.warn('[pipeline] 配图搜索失败:', (e as Error).message)
      }
    }
    // 去重
    const seen = new Set<string>()
    photos = photos.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
  }
  const images = await downloadImages(input, taskId, photos)

  await setProgress(taskId, 'generating', 25, `资料就绪(${images.filter((i) => i.localPath).length} 张配图)`)
  return { facts, images }
}

/** Unsplash 合规:对实际进入方案的图片触发下载统计(brief 里出现该图 URL 时) */
export function trackChosenImages(images: ResearchImage[], briefs: string[]): void {
  for (const p of images) {
    if (briefs.some((b) => b.includes(p.url))) void triggerDownload(p)
  }
}
