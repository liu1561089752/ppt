/**
 * design.test.ts — 交稿前的确定性设计兜底
 *
 * 这一层的每个分支都来自一次真机事故,所以每条都有一个最小复现:
 *   - 背景被模型自造 → 锁回主题色板;
 *   - 字号 12pt → 抬到 PPT 尺度;
 *   - 卡片只写 fill 不写 background → 引擎不画底(整页只剩散字);
 *   - 模型选错/重复用图 → 按页面绑定纠正 + 跨页去重;
 *   - 一句话页面塌在顶上 → 按真实几何居中。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { enforceDeckDesign, balancePageGeometry, sparsePages } from './design'
import type { DeckSpecJson, PreviewSlide } from './types'

const colors = {
  background: 'E6EFE8', surface: 'FBFDFB', foreground: '1E2B24', muted: '4F6659',
  primary: '1F4438', accent: 'C0653A', border: 'CFDED4',
}

function deck(slides: Array<Record<string, unknown>>): DeckSpecJson {
  return {
    title: 'd',
    theme: { colors: { ...colors }, fonts: { heading: 'x', body: 'x' } },
    slides: slides as unknown as DeckSpecJson['slides'],
  }
}

test('a card that only declares fill gets its surface switched on', () => {
  const spec = deck([{ template: 'content', elements: [
    { type: 'container', fill: colors.surface, radius: 0.12, padding: 0.2, children: [
      { type: 'text', text: '卡片里的字', fontSize: 14 },
    ] },
  ] }])
  const report = enforceDeckDesign(spec)
  assert.equal(report.surfacesEnabled, 1)
  const container = spec.slides[0].elements[0] as Record<string, unknown>
  assert.equal(container.background, true)
  // 嵌套容器也要被处理到
  assert.equal((container.children as Array<Record<string, unknown>>).length, 1)
})

test('a plain layout container without fill or radius is left alone', () => {
  const spec = deck([{ template: 'content', elements: [
    { type: 'container', columns: 2, gap: 0.2, children: [{ type: 'text', text: 'a', fontSize: 14 }] },
  ] }])
  const report = enforceDeckDesign(spec)
  assert.equal(report.surfacesEnabled, 0)
  assert.equal((spec.slides[0].elements[0] as Record<string, unknown>).background, undefined)
})

test('an explicit background:false is respected, not overridden', () => {
  const spec = deck([{ template: 'content', elements: [
    { type: 'container', background: false, fill: colors.surface, children: [{ type: 'text', text: 'a' }] },
  ] }])
  const report = enforceDeckDesign(spec)
  assert.equal(report.surfacesEnabled, 0)
  assert.equal((spec.slides[0].elements[0] as Record<string, unknown>).background, false)
})

test('a background the model invented is locked back to the theme palette', () => {
  const spec = deck([
    { template: 'content', background: '12202B', elements: [{ type: 'text', text: 'a' }] },
    { template: 'section', background: '12202B', elements: [{ type: 'text', text: 'b' }] },
  ])
  const report = enforceDeckDesign(spec)
  assert.equal(report.backgroundsLocked, 2)
  assert.equal(spec.slides[0].background, colors.background)
  assert.equal(spec.slides[1].background, colors.primary, 'section pages take the primary field')
})

test('a background already inside the palette is kept', () => {
  const spec = deck([{ template: 'section', background: colors.primary, elements: [{ type: 'text', text: 'a' }] }])
  const report = enforceDeckDesign(spec)
  assert.equal(report.backgroundsLocked, 0)
})

test('body text below the presentation scale is lifted, never shrunk', () => {
  const spec = deck([{ template: 'content', elements: [
    { type: 'text', text: '12pt', fontSize: 12 },
    { type: 'text', text: '40pt', fontSize: 40 },
  ] }])
  const report = enforceDeckDesign(spec)
  assert.equal(report.fontSizesRaised, 1)
  const [small, big] = spec.slides[0].elements as Array<Record<string, unknown>>
  assert.equal(small.fontSize, 18, '12pt 直接抬到 18pt:16pt 会被下一档再抬一次,不幂等')
  assert.equal(big.fontSize, 40, 'a large display size must not be rewritten')
})

test('an image page with no image takes the page-bound photo, credit included', () => {
  const spec = deck([{ template: 'image', elements: [{ type: 'text', text: '标题' }] }])
  const report = enforceDeckDesign(spec, [
    { id: 'ph1', path: '/tmp/a.jpg', caption: '茶山', author: '张三', licence: 'Unsplash License' },
  ], [{ imageId: 'ph1' }])
  assert.equal(report.imagesInjected, 1)
  const image = spec.slides[0].elements[0] as Record<string, unknown>
  assert.equal(image.type, 'image')
  assert.equal(image.path, '/tmp/a.jpg')
  assert.deepEqual(image.credit, { subject: '茶山', author: '张三', licence: 'Unsplash License' })
})

test('an image page with no photo at all is downgraded instead of shipping a fake image page', () => {
  const spec = deck([{ template: 'image', elements: [{ type: 'text', text: '标题' }] }])
  const report = enforceDeckDesign(spec, [])
  assert.equal(report.templatesDowngraded, 1)
  assert.equal(spec.slides[0].template, 'content')
})

test('a page that picked the wrong photo is corrected to its bound one', () => {
  const spec = deck([{ template: 'image', elements: [
    { type: 'image', path: '/tmp/wrong.jpg', credit: { subject: 'x', author: 'y', licence: 'z' } },
  ] }])
  const report = enforceDeckDesign(spec, [
    { id: 'ph1', path: '/tmp/right.jpg', caption: '对的那张', author: '李四', licence: 'Unsplash License' },
  ], [{ imageId: 'ph1' }])
  assert.equal(report.imagesRebound, 1)
  const image = spec.slides[0].elements[0] as Record<string, unknown>
  assert.equal(image.path, '/tmp/right.jpg')
  assert.equal((image.credit as Record<string, string>).author, '李四')
})

test('the same photo is never used twice: the second page is re-pointed or emptied', () => {
  const pool = [{ path: '/tmp/a.jpg', caption: 'A' }, { path: '/tmp/b.jpg', caption: 'B' }]
  const spec = deck([
    { template: 'image', elements: [{ type: 'image', path: '/tmp/a.jpg' }] },
    { template: 'image', elements: [{ type: 'image', path: '/tmp/a.jpg' }] },
  ])
  const report = enforceDeckDesign(spec, pool)
  assert.equal(report.imagesDeduped, 1)
  assert.equal((spec.slides[0].elements[0] as Record<string, unknown>).path, '/tmp/a.jpg')
  assert.equal((spec.slides[1].elements[0] as Record<string, unknown>).path, '/tmp/b.jpg')

  // 池里没有第二张时,宁可摘掉也不重复
  const only = deck([
    { template: 'image', elements: [{ type: 'image', path: '/tmp/a.jpg' }] },
    { template: 'image', elements: [{ type: 'image', path: '/tmp/a.jpg' }] },
  ])
  const deduped = enforceDeckDesign(only, [{ path: '/tmp/a.jpg', caption: 'A' }])
  assert.equal(deduped.imagesDeduped, 1)
  assert.equal(only.slides[1].elements.some((element) => element.type === 'image'), false)
})

test('a one-line page that collapsed to the top is centred from its measured geometry', () => {
  const spec = deck([{ template: 'cover', elements: [{ type: 'text', text: '标题' }] }])
  const layout: PreviewSlide[] = [{ elements: [
    { type: 'text', x: 0.8, y: 0.5, w: 11, h: 0.6 } as never,
    { type: 'text', x: 0.8, y: 1.2, w: 11, h: 0.3 } as never,
  ] }]
  const moved = balancePageGeometry(spec, layout, { width: 13.333, height: 7.5 })
  assert.equal(moved, 1)
  // 内容高 1.0in,目标顶边 = (7.5 - 1.0) / 2 = 3.25;原顶边 0.5 → startY 平移 2.75
  assert.ok(Math.abs(Number(spec.slides[0].startY) - 3.25) < 0.001)
})

test('content pages are not centred: reading starts at the top', () => {
  const spec = deck([{ template: 'content', elements: [{ type: 'text', text: '正文' }] }])
  const layout: PreviewSlide[] = [{ elements: [{ type: 'text', x: 0.8, y: 0.5, w: 11, h: 0.6 } as never] }]
  const moved = balancePageGeometry(spec, layout, { width: 13.333, height: 7.5 })
  assert.equal(moved, 0)
  assert.equal(spec.slides[0].startY, undefined)
})

test('a page that already fills the field is not nudged', () => {
  const spec = deck([{ template: 'quote', elements: [{ type: 'text', text: '引语' }] }])
  const layout: PreviewSlide[] = [{ elements: [{ type: 'text', x: 1, y: 5.9, w: 11, h: 1.2 } as never] }]
  const moved = balancePageGeometry(spec, layout, { width: 13.333, height: 7.5 })
  assert.equal(moved, 0)
})

test('sparse page detection skips the archetypes that are sparse by design', () => {
  const spec = deck([
    { template: 'content', elements: [] },
    { template: 'cover', elements: [] },
  ])
  const layout: PreviewSlide[] = [
    { elements: [{ type: 'text', x: 0.8, y: 0.5, w: 11, h: 0.6 } as never] },
    { elements: [{ type: 'text', x: 0.8, y: 0.5, w: 11, h: 0.6 } as never] },
  ]
  const sparse = sparsePages(layout, spec)
  assert.deepEqual(sparse.map((page) => page.page), [1])
})

// ── 幂等性:修复轮会把同一套兜底再跑一遍 ──────────────────────────────────

test('the design fallback is idempotent: running it twice changes nothing the second time', () => {
  const sizes = [12, 14, 16, 18, 22, 26]
  const subject = deck([{
    template: 'content',
    elements: sizes.map((size) => ({ type: 'text', text: `${size}pt 正文`, fontSize: size })),
  }])
  const once = JSON.stringify(subject.slides)
  enforceDeckDesign(subject, [], [])
  const afterFirst = JSON.stringify(subject.slides)
  const reportSecond = enforceDeckDesign(subject, [], [])
  const afterSecond = JSON.stringify(subject.slides)

  assert.notEqual(once, afterFirst, '第一次应当抬字号')
  assert.equal(afterSecond, afterFirst, '第二次不许再改:否则修复轮会"顺手改到别的页"')
  assert.equal(reportSecond.fontSizesRaised, 0, '第二次不应再报告字号改动')
})

test('every lifted size is a fixed point of the ladder', () => {
  // 直接验判据本身:任何输入抬一次之后再抬,必须不动
  for (const size of [8, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 26, 28, 32, 40]) {
    const probe = deck([{ template: 'content', elements: [{ type: 'text', text: `t${size}`, fontSize: size }] }])
    enforceDeckDesign(probe, [], [])
    const first = (probe.slides[0].elements[0] as unknown as { fontSize: number }).fontSize
    const report = enforceDeckDesign(probe, [], [])
    const second = (probe.slides[0].elements[0] as unknown as { fontSize: number }).fontSize
    assert.equal(second, first, `${size}pt 抬到 ${first}pt 之后又变了`)
    assert.equal(report.fontSizesRaised, 0, `${size}pt 第二次仍被算作"抬字号"`)
  }
})
