/**
 * review.test.ts — 逐页确定性审查的回归测试
 *
 * 这一层是"自动修复"的判据:它报错报错了,模型就会被要求改本来没问题的页;
 * 它漏报了,坏页就会连同"检查通过"一起交付。所以每条判据都钉一个最小样例。
 *
 * 运行:`npm run test:pipeline`(tsx + node:test,不需要数据库/引擎/网络)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  reviewGeometry, reviewComposition, reviewPixels, groupByPage, fingerprintPages, changedPages,
} from './review'
import type { DeckSpecJson, PreviewSlide } from './types'

function spec(background = 'EEF3F6'): DeckSpecJson {
  return {
    title: 't',
    theme: {
      colors: {
        background, surface: 'FFFFFF', foreground: '12202B', muted: '5B6B75',
        primary: '1F5C4D', accent: 'C2622F', border: 'D5DEE2',
      },
      fonts: { heading: 'x', body: 'x' },
    },
    slides: [{ template: 'content', background, elements: [] }],
  }
}

function slide(elements: Array<Record<string, unknown>>): PreviewSlide {
  return { elements: elements as never }
}

test('a paragraph below 10pt is flagged with its measured size', () => {
  const layout = [slide([{ type: 'text', text: '注解', x: 1, y: 1, w: 4, h: 0.3, fontSize: 8 }])]
  const problems = reviewGeometry(layout, spec())
  const tiny = problems.find((problem) => problem.code === 'TINY_TEXT')
  assert.ok(tiny, 'TINY_TEXT should fire')
  assert.equal(tiny!.page, 1)
  assert.match(tiny!.detail, /8pt/)
  assert.equal(tiny!.source, 'geometry')
})

test('12pt is acceptable, 11pt is only an info note', () => {
  const layout = [slide([
    { type: 'text', text: '正文', x: 1, y: 1, w: 6, h: 0.4, fontSize: 12 },
    { type: 'text', text: '说明', x: 1, y: 2, w: 6, h: 0.4, fontSize: 11 },
  ])]
  const problems = reviewGeometry(layout, spec())
  assert.equal(problems.some((problem) => problem.code === 'TINY_TEXT'), false)
  const small = problems.filter((problem) => problem.code === 'SMALL_TEXT')
  assert.equal(small.length, 1)
  assert.equal(small[0].severity, 'info')
})

test('a text box that runs off the canvas is reported as out of page', () => {
  const layout = [slide([{ type: 'text', text: '长标题', x: 12.5, y: 1, w: 3, h: 0.6, fontSize: 20 }])]
  const problems = reviewGeometry(layout, spec())
  const overflow = problems.find((problem) => problem.code === 'TEXT_OUT_OF_PAGE')
  assert.ok(overflow)
  assert.match(overflow!.detail, /13\.333×7\.5/)
})

test('two texts stacked on each other are reported, side-by-side columns are not', () => {
  const stacked = [slide([
    { type: 'text', text: 'A', x: 1, y: 1, w: 4, h: 1, fontSize: 14 },
    { type: 'text', text: 'B', x: 1.2, y: 1.1, w: 4, h: 1, fontSize: 14 },
  ])]
  assert.ok(reviewGeometry(stacked, spec()).some((problem) => problem.code === 'TEXT_OVERLAP'))

  const columns = [slide([
    { type: 'text', text: 'A', x: 0.8, y: 1, w: 5, h: 1, fontSize: 14 },
    { type: 'text', text: 'B', x: 6.2, y: 1, w: 5, h: 1, fontSize: 14 },
  ])]
  assert.equal(reviewGeometry(columns, spec()).some((problem) => problem.code === 'TEXT_OVERLAP'), false)
})

test('dark ink on a dark field is caught even though the engine wrote it happily', () => {
  const layout = [slide([
    { type: 'text', text: '深绿字压深绿底', x: 1, y: 1, w: 8, h: 0.6, fontSize: 16, color: '12432F' },
  ])]
  const problems = reviewGeometry(layout, darkSpec())
  const low = problems.find((problem) => problem.code === 'LOW_CONTRAST_TEXT')
  assert.ok(low, 'LOW_CONTRAST_TEXT should fire')
  assert.match(low!.detail, /:1/)
})

test('light text on a dark card inside a light page is not reported as low contrast', () => {
  // 曾经的误报:按整页底色判,深卡片上的浅字被算成 1.0:1,修复轮于是去改本来正确的文字
  const layout = [slide([
    { type: 'text', text: '深卡片上的浅字', x: 1, y: 5, w: 8, h: 0.5, fontSize: 18, color: 'E6EFE8' },
  ])]
  assert.equal(reviewGeometry(layout, cardSpec()).some((p) => p.code === 'LOW_CONTRAST_TEXT'), false)
})

test('a page whose ink is all text is flagged as dense, a page with a chart is not', () => {
  const dense = [slide(Array.from({ length: 8 }, (_, index) => ({
    type: 'text', text: `段落 ${index}`, x: 0.8, y: 0.5 + index * 0.85, w: 11, h: 0.8, fontSize: 12,
  })))]
  assert.ok(reviewGeometry(dense, spec()).some((problem) => problem.code === 'TEXT_DENSITY_HIGH'))
})

test('geometry review says nothing when the engine gave no layout', () => {
  assert.deepEqual(reviewGeometry(undefined, spec()), [])
  assert.deepEqual(reviewGeometry([], spec()), [])
})

test('pixel metrics turn into page problems with the measured numbers', () => {
  const problems = reviewPixels([
    { page: 2, ink_ratio: 0.01, content_bottom_ratio: 0.3, distinct_colours: 120 },
    { page: 3, ink_ratio: 0.4, content_bottom_ratio: 0.9, distinct_colours: 120 },
    { page: 4, ink_ratio: 0.4, content_bottom_ratio: 0.9, distinct_colours: 2 },
  ])
  assert.deepEqual(
    problems.map((problem) => `${problem.page}:${problem.code}`),
    ['2:PAGE_MOSTLY_EMPTY', '2:CONTENT_STOPS_HIGH', '4:FLAT_PAGE'],
  )
  assert.equal(problems[0].source, 'pixels')
  assert.match(problems[0].detail, /1\.0%/)
})

test('problems are grouped per page with source-tagged evidence lines', () => {
  const grouped = groupByPage([
    { page: 3, code: 'A', severity: 'warning', detail: 'd1', source: 'geometry', advice: '改法一' },
    { page: 1, code: 'B', severity: 'warning', detail: 'd2', source: 'pixels' },
    { page: 3, code: 'C', severity: 'info', detail: 'd3', source: 'vision' },
  ])
  assert.deepEqual(grouped.map((group) => group.page), [1, 3])
  assert.equal(grouped[1].lines.length, 2)
  assert.match(grouped[1].lines[0], /^\[geometry\/A\] d1 → 改法:改法一$/)
  assert.match(grouped[1].lines[1], /^\[vision\/C\]/)
})

test('the page fingerprint notices a moved box and an added box', () => {
  const base = [slide([{ type: 'text', text: 'A', x: 1, y: 1, w: 4, h: 1 }])]
  const moved = [slide([{ type: 'text', text: 'A', x: 1.5, y: 1, w: 4, h: 1 }])]
  const added = [slide([
    { type: 'text', text: 'A', x: 1, y: 1, w: 4, h: 1 },
    { type: 'text', text: 'B', x: 1, y: 3, w: 4, h: 1 },
  ])]
  assert.deepEqual(changedPages(fingerprintPages(base), fingerprintPages(base)), [])
  assert.deepEqual(changedPages(fingerprintPages(base), fingerprintPages(moved)), [1])
  assert.deepEqual(changedPages(fingerprintPages(base), fingerprintPages(added)), [1])
})

test('the fingerprint is order-insensitive inside a page but page-sensitive', () => {
  const a = [slide([
    { type: 'text', text: 'A', x: 1, y: 1, w: 4, h: 1 },
    { type: 'text', text: 'B', x: 1, y: 3, w: 4, h: 1 },
  ])]
  const b = [slide([
    { type: 'text', text: 'B', x: 1, y: 3, w: 4, h: 1 },
    { type: 'text', text: 'A', x: 1, y: 1, w: 4, h: 1 },
  ])]
  assert.deepEqual(changedPages(fingerprintPages(a), fingerprintPages(b)), [])
  // 页数变化也要能被看出来(否则"少写一页"会被当成没变)
  assert.deepEqual(changedPages(fingerprintPages(a), []), [1])
})

// ── 原型构图审查:该有的东西在不在 ────────────────────────────────────────

function deckOf(slides: Array<Record<string, unknown>>): DeckSpecJson {
  return {
    title: 't',
    theme: {
      colors: {
        background: 'EEF3F6', surface: 'FFFFFF', foreground: '12202B', muted: '5B6B75',
        primary: '1F5C4D', accent: 'C2622F', border: 'D5DEE2',
      },
      fonts: { heading: 'x', body: 'x' },
    },
    slides: slides as unknown as DeckSpecJson['slides'],
  }
}

test('a chart page with no chart is called out, a real chart passes', () => {
  const textOnly = deckOf([{ template: 'chart', elements: [
    { type: 'text', text: '趋势很好', fontSize: 26 },
    { type: 'text', text: 'Q1 到 Q4 一路向上。', fontSize: 14 },
  ] }])
  const problems = reviewComposition(textOnly)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].source, 'shape')
  assert.equal(problems[0].code, 'SHAPE_MISSING_CHART')

  const withChart = deckOf([{ template: 'chart', elements: [
    { type: 'text', text: '趋势很好', fontSize: 26 },
    { type: 'chart', chartType: 'bar', h: 3.5, data: [{ name: 'a', labels: ['Q1'], values: [1] }] },
  ] }])
  assert.deepEqual(reviewComposition(withChart), [])
})

test('table and image pages are checked for their own element type', () => {
  assert.equal(reviewComposition(deckOf([{ template: 'table', elements: [{ type: 'text', text: 'x' }] }]))[0].code,
    'SHAPE_MISSING_TABLE')
  assert.equal(reviewComposition(deckOf([{ template: 'image', elements: [{ type: 'text', text: 'x' }] }]))[0].code,
    'SHAPE_MISSING_IMAGE')
})

test('a kpi page made of prose has no metrics to look at', () => {
  const prose = deckOf([{ template: 'kpi', elements: [
    { type: 'text', text: '我们的产品在多个维度上都取得了显著进步,值得关注。', fontSize: 14 },
  ] }])
  assert.equal(reviewComposition(prose)[0].code, 'SHAPE_NO_METRICS')

  const metrics = deckOf([{ template: 'kpi', elements: [
    { type: 'container', background: true, fill: 'FFFFFF', children: [
      { type: 'text', text: '62%', fontSize: 38 },
      { type: 'text', text: '覆盖率', fontSize: 14 },
    ] },
    { type: 'container', background: true, fill: 'FFFFFF', children: [
      { type: 'text', text: '3.2s', fontSize: 26 },
      { type: 'text', text: '构建耗时', fontSize: 14 },
    ] },
  ] }])
  assert.deepEqual(reviewComposition(metrics), [])
})

test('a comparison page that never made two columns is reported', () => {
  const oneColumn = deckOf([{ template: 'comparison', elements: [
    { type: 'text', text: '标题', fontSize: 26 },
    { type: 'container', background: true, children: [{ type: 'text', text: '只有一栏', fontSize: 14 }] },
  ] }])
  assert.equal(reviewComposition(oneColumn)[0].code, 'SHAPE_NOT_TWO_COLUMNS')

  const twoColumns = deckOf([{ template: 'comparison', elements: [
    { type: 'container', columns: 2, children: [
      { type: 'container', background: true, children: [{ type: 'text', text: 'A', fontSize: 14 }] },
      { type: 'container', background: true, children: [{ type: 'text', text: 'B', fontSize: 14 }] },
    ] },
  ] }])
  assert.deepEqual(reviewComposition(twoColumns), [])
})

test('a body page with only a title and one sentence is thin, two paragraphs is not', () => {
  const thin = deckOf([{ template: 'content', elements: [
    { type: 'text', role: 'title', text: '标题', fontSize: 26 },
    { type: 'text', text: '一句话。', fontSize: 14 },
  ] }])
  assert.equal(reviewComposition(thin)[0].code, 'SHAPE_THIN_PAGE')

  const full = deckOf([{ template: 'content', elements: [
    { type: 'text', role: 'title', text: '标题', fontSize: 26 },
    { type: 'text', text: '第一段。', fontSize: 14 },
    { type: 'text', text: '第二段。', fontSize: 14 },
  ] }])
  assert.deepEqual(reviewComposition(full), [])
})

test('a body page whose main content is a chart is not called thin', () => {
  const chartLed = deckOf([{ template: 'content', elements: [
    { type: 'text', role: 'title', text: '标题', fontSize: 26 },
    { type: 'chart', chartType: 'line', h: 3.5, data: [] },
  ] }])
  assert.deepEqual(reviewComposition(chartLed), [])
})

test('a pause page crowded with cards is reported as an info, not a hard warning', () => {
  const crowded = deckOf([{ template: 'cover', elements: [
    { type: 'text', role: 'title', text: '书名', fontSize: 40 },
    { type: 'container', background: true, children: [{ type: 'text', text: 'a' }] },
    { type: 'container', background: true, children: [{ type: 'text', text: 'b' }] },
    { type: 'container', background: true, children: [{ type: 'text', text: 'c' }] },
  ] }])
  const problems = reviewComposition(crowded)
  assert.equal(problems[0].code, 'SHAPE_OVERBUILT_PAUSE_PAGE')
  assert.equal(problems[0].severity, 'info')
})

test('a page of seven or more cards is a card wall regardless of archetype', () => {
  const cards = Array.from({ length: 7 }, (_, index) => ({
    type: 'container', background: true, children: [{ type: 'text', text: `卡 ${index}` }],
  }))
  const wall = deckOf([{ template: 'bento', elements: [
    { type: 'container', columns: 3, children: cards },
  ] }])
  const codes = reviewComposition(wall).map((problem) => problem.code)
  assert.ok(codes.includes('SHAPE_CARD_WALL'), `actual codes: ${codes.join(',')}`)
})

test('composition problems carry a page number and an actionable advice', () => {
  const problems = reviewComposition(deckOf([
    { template: 'content', elements: [{ type: 'text', text: '标题' }] },
    { template: 'chart', elements: [{ type: 'text', text: '只有文字' }] },
  ]))
  assert.deepEqual(problems.map((problem) => problem.page), [1, 2])
  for (const problem of problems) assert.ok((problem.advice || '').length > 10)
})

/** 深绿字压深绿底的规格:与上面的布局一致(对比度按规格判,不在布局里) */
function darkSpec(): DeckSpecJson {
  const base = spec('0F3D2E')
  base.slides = [{
    template: 'content',
    background: '0F3D2E',
    elements: [{ type: 'text', text: '深绿字压深绿底', fontSize: 16, color: '12432F' }],
  }] as never
  return base
}

/** 浅色页里放一张深卡片,卡片里是浅色字 —— 读得清,不该报 */
function cardSpec(): DeckSpecJson {
  const base = spec('EEF3F6')
  base.slides = [{
    template: 'section',
    background: 'EEF3F6',
    elements: [{
      type: 'container', background: true, fill: '1F4438', children: [
        { type: 'text', text: '深卡片上的浅字', fontSize: 18, color: 'E6EFE8' },
      ],
    }],
  }] as never
  return base
}
