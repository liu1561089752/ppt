import { chat, getKimiModel, hasLLMKey } from './kimi-client'

export interface SearchSource {
  id: string
  title: string
  url: string
  snippet: string
  siteName?: string
  publishedAt?: string
  provider: 'bocha' | 'kimi-formula' | 'knowledge'
}
export interface SearchResult {
  text: string
  provider: SearchSource['provider']
  sources: SearchSource[]
}
export interface SearchFacts { text: string; provider: SearchSource['provider'] }

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const MAX_SOURCE_TEXT = 500
const TIMEOUT_MS = 20_000

function getBochaKey(): string { return (process.env.BOCHA_API_KEY || '').trim() }
export function hasBochaKey(): boolean { return getBochaKey().length > 10 }

interface BochaPage {
  name?: string; url?: string; snippet?: string; summary?: string
  siteName?: string; datePublished?: string
}

async function bochaSearch(query: string): Promise<BochaPage[]> {
  const year = new Date().getFullYear()
  const anchoredQuery = /20\d\d/.test(query) ? query : `${query} ${year}年`
  async function call(freshness: 'oneMonth' | 'oneYear'): Promise<BochaPage[]> {
    const response = await fetch(BOCHA_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${getBochaKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: anchoredQuery, freshness, summary: true, count: 8 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`博查搜索 HTTP ${response.status}`)
    const payload = await response.json() as { data?: { webPages?: { value?: BochaPage[] } } }
    return payload.data?.webPages?.value || []
  }
  let pages: BochaPage[] = []
  try { pages = await call('oneMonth') } catch { /* widen freshness below */ }
  if (pages.length < 3) {
    try {
      const wider = await call('oneYear')
      const seen = new Set(pages.map((page) => page.url).filter(Boolean))
      for (const page of wider) if (page.url && !seen.has(page.url)) pages.push(page)
    } catch { /* keep the first response */ }
  }
  if (!pages.length) throw new Error('博查搜索无结果')
  return pages.slice(0, 6)
}

function toSources(pages: BochaPage[]): SearchSource[] {
  return pages.filter((page) => page.url && /^https?:\/\//i.test(page.url)).map((page, index) => ({
    id: `bocha_${index + 1}_${Buffer.from(page.url || '').toString('base64url').slice(0, 16)}`,
    title: (page.name || page.siteName || '未命名来源').trim(),
    url: page.url!,
    snippet: (page.summary || page.snippet || '').trim().slice(0, MAX_SOURCE_TEXT),
    siteName: page.siteName,
    publishedAt: page.datePublished,
    provider: 'bocha' as const,
  }))
}
function formatSources(sources: SearchSource[]): string {
  return sources.map((source) => {
    const date = source.publishedAt ? ` | 发布日期：${source.publishedAt.slice(0, 10)}` : ''
    return `来源：${source.title}（${source.siteName || '网站'}）${date}\n链接：${source.url}\n摘要：${source.snippet}`
  }).join('\n\n')
}

/** Web evidence keeps canonical source URLs. Knowledge fallbacks have no citations. */
export async function webSearchDetailed(query: string, opts: { model?: string } = {}): Promise<SearchResult> {
  if (hasBochaKey()) {
    try {
      const sources = toSources(await bochaSearch(query))
      if (sources.length) return { text: formatSources(sources), provider: 'bocha', sources }
    } catch (error) {
      console.warn('[search] 博查失败，降级:', (error as Error).message)
    }
  }
  if (hasLLMKey()) {
    try {
      const { formulaSearch } = await import('./kimi-client')
      const text = await formulaSearch(query, opts.model)
      if (text.trim()) return { text, provider: 'kimi-formula', sources: [] }
    } catch (error) {
      console.warn('[search] Kimi Formula 失败，降级知识摘要:', (error as Error).message)
    }
  }
  try {
    const response = await chat({
      model: opts.model || getKimiModel(),
      messages: [
        { role: 'system', content: '你是资料研究员。提供准确、具体的事实要点；不确定时明确说明，不要编造，也不得伪造来源链接。' },
        { role: 'user', content: query },
      ],
      maxTokens: 6000,
    })
    return { text: response.content || '', provider: 'knowledge', sources: [] }
  } catch {
    return { text: '', provider: 'knowledge', sources: [] }
  }
}

/** Backwards-compatible text-only API. */
export async function webSearch(query: string, opts: { model?: string } = {}): Promise<SearchFacts> {
  const result = await webSearchDetailed(query, opts)
  return { text: result.text, provider: result.provider }
}
