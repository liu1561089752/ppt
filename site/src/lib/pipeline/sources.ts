/**
 * pipeline/sources.ts — 来源的规范化、去重与分级
 *
 * 真机跑博查观察到的三件事,决定了这个文件存在:
 *   1. 同一篇文章会以桌面域和移动域各返回一次(`chinabgao.com` 与 `m.chinabgao.com`),
 *      按完整 URL 去重根本去不掉;
 *   2. 一条来源的标题常带站点后缀(`…_中研网`、`…- 澎湃新闻`),同名不同后缀的也得算重复;
 *   3. 排序完全没有价值观:研报代销站(`中国XX联合会研究服务平台`)排在最前,
 *      政府/媒体反而沉底。PPT 里引用的"证据"因此看起来像搜索引擎首页。
 *
 * 这里不做"真实性判断"(做不到,也不该假装),只做三件确定的事:**同一篇文章只留一条**、
 * **按来源类型排序**、**让排序原因可解释**。内容是否可信仍由人判断,但至少不会把
 * 研报代销站当成权威来源摆在第一页。
 */
import type { SearchSource } from '@/lib/search-client'

/** 明确的研报代销 / 内容农场:不是不能用,而是不该排在权威来源前面 */
const MILL_HOSTS = [
  'chinairn.com', 'chinabgao.com', 'chyxx.com', 'qianzhan.com', 'askci.com',
  'pcp.org.cn', 'ocn.com.cn', '51baogao.cn', 'report.baogaobaogao.com',
  'php.cn', 'tgb.cn', 'xueqiu.com', '36hjob.com', 'sohu.com/a',
]

/** 政府 / 官方机构 / 学术:证据优先级最高 */
const OFFICIAL_SUFFIXES = ['.gov.cn', '.gov', '.edu.cn', '.edu', '.ac.cn', '.mil.cn', '.org.cn']

/** 主流媒体与行业媒体:可信度中等,通常有署名与编辑流程 */
const MEDIA_HOSTS = [
  'xinhuanet.com', 'news.cn', 'people.com.cn', 'thepaper.cn', 'caixin.com',
  'yicai.com', 'jiemian.com', '21jingji.com', 'stcn.com', 'cls.cn',
  '36kr.com', 'huxiu.com', 'tmtpost.com', 'ithome.com', 'leiphone.com',
  'sciencenet.cn', 'cas.cn', 'cae.cn',
]

/** 去掉移动域/常见跟踪参数,让"同一篇文章"的两个链接变成同一个 key */
export function normalizeSourceUrl(raw: string): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value.toLowerCase().replace(/\/+$/u, '')
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|wap|mobile)\./u, '')
  // 只保留可能承载文章标识的参数:token/id/articleId 之类;utm_* 之类一律丢掉
  const keep = [...url.searchParams.entries()]
    .filter(([key]) => /^(id|aid|articleid|token|p|pageno|docid)$/iu.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
  const query = keep.length ? `?${keep.map(([key, val]) => `${key}=${val}`).join('&')}` : ''
  const path = url.pathname.replace(/\/+$/u, '')
  return `${host}${path}${query}`.toLowerCase()
}

/**
 * 标题归一:反复剥掉尾部的站点后缀,再去空白与标点,用来识别"同一篇换了标题壳"。
 *
 * 真实标题常常叠了两层站点名:`…产业链分析_中研普华_中研网`,只剥一层会留下
 * `_中研普华`,和 `…产业链分析 - 中研网` 归不到一起。所以循环剥,但保留剩余长度
 * 不少于 8 个字符,免得把标题榨空、把不同文章误判成同一篇。
 */
export function normalizeSourceTitle(raw: string): string {
  let value = String(raw || '').replace(/[\s\u3000]+/gu, '')
  for (let round = 0; round < 4; round++) {
    const next = value.replace(/[_\-—–·|][^_\-—–·|]{1,16}$/u, '')
    if (next !== value && next.length >= 8) value = next
    else break
  }
  return value
    .replace(/[()（）\[\]【】《》「」“”"'，。、,.!?！?…:：;；]/gu, '')
    .toLowerCase()
}

export type SourceTier = 0 | 1 | 2 | 3

/** 来源分级:0 官方/学术 · 1 主流媒体 · 2 一般站点 · 3 研报代销/内容农场 */
export function sourceTier(rawUrl: string): SourceTier {
  const host = (() => {
    try {
      return new URL(String(rawUrl || '')).hostname.toLowerCase()
    } catch {
      return String(rawUrl || '').toLowerCase()
    }
  })()
  if (!host) return 2
  if (MILL_HOSTS.some((mill) => host === mill || host.endsWith(`.${mill}`) || host.includes(mill))) return 3
  if (OFFICIAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 0
  if (MEDIA_HOSTS.some((media) => host === media || host.endsWith(`.${media}`))) return 1
  return 2
}

export function tierLabel(tier: SourceTier): string {
  return ['官方/学术', '主流媒体', '一般站点', '研报代销'][tier] || '一般站点'
}

/**
 * 去重 + 分级排序。
 *
 * 排序是稳定的:tier → 摘要长度(摘要长的通常是正文页,短的多是导航/目录页)。
 * 摘要长度相同时保持检索顺序,所以同样的输入永远得到同样的输出(便于回归)。
 */
export function rankSources(sources: SearchSource[]): SearchSource[] {
  const seenUrl = new Set<string>()
  const seenTitle = new Set<string>()
  const unique: SearchSource[] = []
  for (const source of Array.isArray(sources) ? sources : []) {
    const urlKey = normalizeSourceUrl(source.url)
    const titleKey = normalizeSourceTitle(source.title)
    if (!urlKey && !titleKey) continue
    if (urlKey && seenUrl.has(urlKey)) continue
    if (titleKey && titleKey.length >= 6 && seenTitle.has(titleKey)) continue
    if (urlKey) seenUrl.add(urlKey)
    if (titleKey) seenTitle.add(titleKey)
    unique.push(source)
  }
  const scored = unique.map((source, index) => ({
    source,
    index,
    tier: sourceTier(source.url),
    weight: String(source.snippet || '').length,
  }))
  scored.sort((a, b) => a.tier - b.tier || b.weight - a.weight || a.index - b.index)
  return scored.map((entry) => entry.source)
}

/** 给人看的一行统计:10 条来源里有 2 条官方、3 条媒体、5 条代销站 */
export function describeSourceMix(sources: SearchSource[]): string {
  const counts: Record<SourceTier, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }
  for (const source of sources) counts[sourceTier(source.url)] += 1
  return ([0, 1, 2, 3] as SourceTier[])
    .filter((tier) => counts[tier] > 0)
    .map((tier) => `${tierLabel(tier)} ${counts[tier]}`)
    .join(' · ')
}
