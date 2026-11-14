/**
 * sources.test.ts — 来源去重与分级
 *
 * 这些判据来自一次真实博查检索(低空经济):10 条来源里
 *   - 同一篇文章以桌面域 + 移动域各出现一次;
 *   - 研报代销站 4 条,政府/媒体只有 2 条,却全部排在后面;
 *   - 标题带站点后缀,肉眼才能看出是同一篇。
 * 这里把当时那批 URL 原样搬进测试,判据就不会随实现漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSourceUrl, normalizeSourceTitle, sourceTier, rankSources, describeSourceMix,
  type SourceTier,
} from './sources'
import type { SearchSource } from '@/lib/search-client'

function source(url: string, title: string, snippet = 'x'.repeat(50)): SearchSource {
  return { id: url, title, url, snippet, provider: 'bocha' }
}

test('the mobile and desktop URL of one article normalize to the same key', () => {
  const desktop = normalizeSourceUrl('https://www.chinabgao.com/finance/hk/351168.html')
  const mobile = normalizeSourceUrl('https://m.chinabgao.com/finance/hk/351168.html')
  assert.equal(desktop, mobile)
  assert.ok(!desktop.startsWith('www.'))
  assert.ok(!desktop.startsWith('m.'))
})

test('tracking parameters are dropped but article identifiers are kept', () => {
  const withTracking = normalizeSourceUrl(
    'https://example.com/a?id=42&utm_source=x&utm_medium=y&from=wx&spm=1.2.3',
  )
  assert.equal(withTracking, 'example.com/a?id=42')
})

test('an invalid URL still produces a stable key instead of throwing', () => {
  assert.equal(normalizeSourceUrl('not a url'), 'not a url')
  assert.equal(normalizeSourceUrl(''), '')
})

test('a site suffix on the title does not hide that it is the same article', () => {
  const a = normalizeSourceTitle('2026低空经济行业市场发展规模与产业链分析_中研普华_中研网')
  const b = normalizeSourceTitle('2026低空经济行业市场发展规模与产业链分析 - 中研网')
  assert.equal(a, b)
})

test('official and academic hosts outrank media, media outranks report mills', () => {
  const expected: Array<[string, SourceTier]> = [
    ['https://www.caac.gov.cn/XXGK/XXGK/TZTG/202601/t1.html', 0],
    ['https://jyt.jiangsu.gov.cn/art/2026/10/23/art_1.html', 0],
    ['https://www.tsinghua.edu.cn/info/1.html', 0],
    ['https://www.thepaper.cn/newsDetail_forward_34316400', 1],
    ['https://www.xinhuanet.com/fortune/1.html', 1],
    ['https://www.chinairn.com/scfx/20261110/1.shtml', 3],
    ['https://www.pcp.org.cn/report/detail.php?token=abc', 3],
    ['https://example.com/some/business/blog', 2],
  ]
  for (const [url, tier] of expected) assert.equal(sourceTier(url), tier, url)
})

test('a real result set is deduped and reordered: official first, mills last', () => {
  const raw: SearchSource[] = [
    source('https://www.pcp.org.cn/report/detail.php?token=b8c4', '2026年中国低空装备产业发展现状与趋势预测报告_中国石油和化学工业联合会', 'a'.repeat(415)),
    source('https://www.chinairn.com/scfx/20261110/175605264.shtml', '2026低空经济行业市场发展规模与产业链分析_中研普华_中研网', 'b'.repeat(500)),
    source('https://www.chinabgao.com/finance/hk/351168.html', '2026年低空经济规模预测与盘面数据概览_行业资讯', 'c'.repeat(500)),
    source('https://m.chinabgao.com/finance/hk/351168.html', '2026年低空经济规模预测与盘面数据概览_行业资讯', 'd'.repeat(500)),
    source('https://jyt.jiangsu.gov.cn/art/2026/10/23/art_93452_11846773.htm', '江苏教育 向低空要未来--低空经济产业趋势与无人机人才新机遇', 'e'.repeat(65)),
    source('https://www.thepaper.cn/newsDetail_forward_34316400', '低空经济就是走"先飞再管再飞"的路子', 'f'.repeat(500)),
  ]
  const ranked = rankSources(raw)
  // 移动域那条必须被去掉(与桌面域同 key)
  assert.equal(ranked.length, 5)
  assert.ok(!ranked.some((s) => s.url.includes('m.chinabgao.com')))
  // 官方在前,研报代销在后
  assert.equal(ranked[0].url, 'https://jyt.jiangsu.gov.cn/art/2026/10/23/art_93452_11846773.htm')
  assert.equal(ranked[1].url, 'https://www.thepaper.cn/newsDetail_forward_34316400')
  const lastTiers = ranked.slice(-2).map((s) => sourceTier(s.url))
  assert.deepEqual(lastTiers, [3, 3], '研报代销站不能排在官方/媒体前面')
})

test('ranking is stable for equal tier and equal snippet length', () => {
  const raw = [
    source('https://example.com/b', 'B 标题一', 'x'.repeat(100)),
    source('https://example.com/a', 'A 标题二', 'x'.repeat(100)),
  ]
  const once = rankSources(raw).map((s) => s.url)
  const twice = rankSources(raw).map((s) => s.url)
  assert.deepEqual(once, twice)
  assert.deepEqual(once, ['https://example.com/b', 'https://example.com/a'], '同等条件保持检索顺序')
})

test('the mix line tells a human where the evidence came from', () => {
  const mix = describeSourceMix([
    source('https://www.caac.gov.cn/a.html', '官方'),
    source('https://www.thepaper.cn/b', '媒体'),
    source('https://www.chinairn.com/c', '代销'),
    source('https://example.com/d', '一般'),
  ])
  assert.match(mix, /官方\/学术 1/u)
  assert.match(mix, /主流媒体 1/u)
  assert.match(mix, /研报代销 1/u)
})

test('empty input does not throw and yields no sources', () => {
  assert.deepEqual(rankSources([]), [])
  assert.equal(describeSourceMix([]), '')
})
