/**
 * unsplash-client.ts — Unsplash 图片搜索客户端
 *
 * 用途:为原生 deck 提供真实配图
 * 实测(2026-09):/search/photos 返回 images.unsplash.com 直链;原生引擎只认本地文件
 * 与 data: URI,所以这条直链由管线下载落盘后,以相对路径成为 image 元素的 path。
 *
 * 合规要求(Unsplash API Guidelines):
 * - 使用图片时触发 download 事件(GET links.download_location)
 * - 标注摄影师与 Unsplash:原生 deck 里体现为 image 元素的
 *   credit { subject, author, licence }——缺 credit 的图不进 deck
 *
 * 限速:Demo 应用 50 请求/小时,客户端内置计数与缓存
 */

const UNSPLASH_BASE = 'https://api.unsplash.com'

export interface UnsplashPhoto {
  id: string
  /** 竖版/横版(用于版式选择) */
  width: number
  height: number
  /** 图片直链(管线下载到本地后成为 image 元素的 path) */
  url: string
  /** 缩略图 URL */
  thumb: string
  /** 图片主色(可用于版面配色呼应) */
  color: string
  /** 摄影师署名(合规必需) */
  author: string
  /** 摄影师主页链接 */
  authorUrl: string
  /** 图片页面链接(合规必需) */
  pageUrl: string
  /** 触发下载统计的接口(合规必需,使用图片时调用) */
  downloadLocation: string
  /** 图片描述 */
  description: string
}

function getAccessKey(): string {
  const key = (process.env.UNSPLASH_ACCESS_KEY || '').trim()
  if (!key) throw new Error('UNSPLASH_KEY_MISSING: 未配置 UNSPLASH_ACCESS_KEY')
  return key
}

export function hasUnsplashKey(): boolean {
  return (process.env.UNSPLASH_ACCESS_KEY || '').trim().length > 10
}

// 简单内存缓存(避免重复搜索同一个 query)
const searchCache = new Map<string, { at: number; photos: UnsplashPhoto[] }>()
const CACHE_TTL_MS = 30 * 60 * 1000

// 请求计数(Demo 限 50/h,保守控制在 40)
let hourWindowStart = Date.now()
let hourCount = 0
const MAX_PER_HOUR = 40

function checkRateLimit(): void {
  if (Date.now() - hourWindowStart > 3600_000) {
    hourWindowStart = Date.now()
    hourCount = 0
  }
  if (hourCount >= MAX_PER_HOUR) {
    throw new Error(`Unsplash 小时配额已用尽(${MAX_PER_HOUR}/h),请稍后再试`)
  }
  hourCount++
}

/**
 * 搜索图片。
 * @param query 搜索词(英文效果更好,中文也可)
 * @param count 需要数量(建议 1-3)
 * @param orientation 横版/竖版(幻灯片多用 landscape)
 */
export async function searchPhotos(
  query: string,
  count = 3,
  orientation: 'landscape' | 'portrait' | 'squarish' = 'landscape',
): Promise<UnsplashPhoto[]> {
  const cacheKey = `${query}|${count}|${orientation}`
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.photos

  checkRateLimit()
  const q = new URLSearchParams({
    query,
    per_page: String(Math.max(1, Math.min(10, count))),
    orientation,
    // 相关性优先
    order_by: 'relevant',
  })
  // 只取有内容的图库
  q.set('content_filter', 'high')

  let res: Response
  try {
    res = await fetch(`${UNSPLASH_BASE}/search/photos?${q.toString()}`, {
      headers: { authorization: `Client-ID ${getAccessKey()}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    console.warn('[unsplash] 搜索请求失败:', (e as Error).message)
    return []
  }
  if (!res.ok) {
    console.warn(`[unsplash] 搜索 HTTP ${res.status}`)
    return []
  }
  const j = (await res.json()) as {
    results?: Array<{
      id: string
      width: number
      height: number
      color?: string
      description?: string
      alt_description?: string
      urls: { regular: string; small: string; raw: string }
      user: { name: string; links: { html: string } }
      links: { html: string; download_location: string }
    }>
  }

  const photos: UnsplashPhoto[] = (j.results || []).map((r) => ({
    id: r.id,
    width: r.width,
    height: r.height,
    // regular 宽度 1080,适合幻灯片;加质量参数控制体积
    url: `${r.urls.regular}&q=75&w=900&fm=jpg&fit=max`,
    thumb: r.urls.small,
    color: r.color || '#cccccc',
    author: r.user?.name || 'Unknown',
    authorUrl: r.user?.links?.html || '',
    pageUrl: r.links?.html || '',
    downloadLocation: r.links?.download_location || '',
    description: r.description || r.alt_description || '',
  }))

  searchCache.set(cacheKey, { at: Date.now(), photos })
  return photos
}

/**
 * 触发下载统计(合规要求:实际使用图片时调用)。
 * 失败不影响主流程。
 */
export async function triggerDownload(photo: UnsplashPhoto): Promise<void> {
  if (!photo.downloadLocation) return
  try {
    await fetch(photo.downloadLocation, {
      headers: { authorization: `Client-ID ${getAccessKey()}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    /* 静默失败 */
  }
}
