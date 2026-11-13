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
  reviewGeometry, reviewPixels, groupByPage, fingerprintPages, changedPages,
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
  const problems = reviewGeometry(layout, spec('0F3D2E'))
  const low = problems.find((problem) => problem.code === 'LOW_CONTRAST_TEXT')
  assert.ok(low, 'LOW_CONTRAST_TEXT should fire')
  assert.match(low!.detail, /:1/)
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
