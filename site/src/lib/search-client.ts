/**
 * search-client.ts — 联网搜索(独立于 LLM 供应商)
 *
 * 策略:博查 Web Search API(主力,毫秒级返回结构化结果)
 *      → Kimi Formula(兜底,博查未配置/失败时)
 *      → 知识摘要(两者都失败时,chat 调用)
 *
 * 搜索与 LLM 解耦:换 LLM 供应商不影响搜索链路。
 */

import { chat, getKimiModel, hasLLMKey } from './kimi-client'

export interface SearchFacts {
  /** 拼装好的资料文本(喂给规划阶段) */
  text: string
  /** 使用的搜索通道 */
  provider: 'bocha' | 'kimi-formula' | 'knowledge'
}

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'

function getBochaKey(): string {
  return (process.env.BOCHA_API_KEY || '').trim()
}

export function hasBochaKey(): boolean {
  return getBochaKey().length > 10
}

/** 当前年份(资料新鲜度锚点) */
function currentYear(): number {
  return new Date().getFullYear()
}

interface BochaPage {
  name?: string
  url?: string
  snippet?: string
  summary?: string
  siteName?: string
  datePublished?: string
}

/**
 * 博查搜索:返回拼装好的资料文本;失败抛错由上层兜底。
 * 时间窗口:优先 oneMonth(最新);不足 3 条时放宽 oneYear 补足。
 * 查询词补当前年份锚,抑制旧报告权重。
 */
async function bochaSearch(query: string): Promise<string> {
  const year = currentYear()
  const anchoredQuery = /20\d\d/.test(query) ? query : `${query} ${year}年`

  async function call(freshness: 'oneMonth' | 'oneYear'): Promise<BochaPage[]> {
    const res = await fetch(BOCHA_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getBochaKey()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: anchoredQuery,
        freshness,
        summary: true,
        count: 8,
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`博查搜索 HTTP ${res.status}`)
    const j = (await res.json()) as { data?: { webPages?: { value?: BochaPage[] } } }
    return j.data?.webPages?.value || []
  }

  let pages: BochaPage[] = []
  try {
    pages = await call('oneMonth')
  } catch {
    /* 失败时走放宽路径 */
  }
  // 一个月内结果不足(冷门主题)则放宽到一年补足
  if (pages.length < 3) {
    try {
      const wider = await call('oneYear')
      const seen = new Set(pages.map((p) => p.url))
      for (const p of wider) {
        if (!seen.has(p.url)) pages.push(p)
      }
    } catch {
      /* ignore */
    }
  }
  if (pages.length === 0) throw new Error('博查搜索无结果')
  return pages
    .slice(0, 5)
    .map((p) => {
      const date = p.datePublished?.slice(0, 10) || ''
      const body = p.summary || p.snippet || ''
      // 来源行刻意弱化:仅供模型核实信息新旧,避免被当成页面文案照搬
      return `《${p.name || ''}》${p.siteName || ''} ${date}(此行仅供核实,勿写入页面)\n${body.slice(0, 400)}`
    })
    .join('\n\n')
}

/**
 * 联网搜索入口:博查 → Kimi Formula → 知识摘要。
 * 永不抛错(最后兜底返回 ''),管线不必处理搜索失败。
 */
export async function webSearch(
  query: string,
  opts: { model?: string } = {},
): Promise<{ text: string; provider: SearchFacts['provider'] }> {
  // 1. 博查主力
  if (hasBochaKey()) {
    try {
      const text = await bochaSearch(query)
      if (text.trim()) return { text, provider: 'bocha' }
    } catch (e) {
      console.warn('[search] 博查失败,降级:', (e as Error).message)
    }
  }

  // 2. Kimi Formula 兜底(需任一 LLM key 可用;内部已含知识摘要降级)
  if (hasLLMKey()) {
    try {
      const { formulaSearch } = await import('./kimi-client')
      const text = await formulaSearch(query, opts.model)
      if (text.trim()) return { text, provider: 'kimi-formula' }
    } catch (e) {
      console.warn('[search] Kimi Formula 失败,降级知识摘要:', (e as Error).message)
    }
  }

  // 3. 知识摘要(chat 调用走当前主力 LLM)
  try {
    const r = await chat({
      model: opts.model || getKimiModel(),
      messages: [
        { role: 'system', content: '你是资料研究员。基于你的知识,就用户给出的话题提供准确、具体的事实要点(数据、时间、案例)。若不确定则明确说明,不要编造。' },
        { role: 'user', content: query },
      ],
      maxTokens: 6000,
    })
    return { text: r.content || '', provider: 'knowledge' }
  } catch {
    return { text: '', provider: 'knowledge' }
  }
}
