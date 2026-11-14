/**
 * fit.test.ts — 确定性收版
 *
 * 背景(25 页真机):内容量随页数增长,流程把文字排到 y=9.25in(画布 7.5in),交付时 40 条越界
 * 警告。交给模型整份重写被校验拒收,按页重写又把元素顶出画布被回滚。排不下是算术问题,
 * 这里钉住"确定性收版"的几条底线。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { expandPages, fitPages } from './fit'

function deck(slides: Array<Record<string, unknown>>): { slides: unknown[] } {
  return { slides }
}

test('body text steps down one rung, titles are left alone', () => {
  const spec = deck([{
    template: 'content',
    elements: [
      { type: 'text', role: 'title', text: '标题', fontSize: 28 },
      { type: 'text', text: '正文一段', fontSize: 18 },
      { type: 'text', text: '注解一行', fontSize: 13 },
    ],
  }])
  const result = fitPages(spec, [1])
  const [title, body, note] = (spec.slides[0] as { elements: Array<{ fontSize: number }> }).elements
  assert.equal(title.fontSize, 28, '标题不许缩:缩了就丢层级')
  assert.equal(body.fontSize, 16, '18 降到下一档 16')
  assert.equal(note.fontSize, 11, '13 降到 11')
  assert.equal(result.changed, 2)
  assert.deepEqual(result.pages, [1])
})

test('it never goes below the floor, and never invents sizes', () => {
  const spec = deck([{
    template: 'content',
    elements: [{ type: 'text', text: '已经最小', fontSize: 11 }],
  }])
  assert.equal(fitPages(spec, [1]).changed, 0, '11pt 已到底,再收就会糊到看不清')
  const elements = (spec.slides[0] as { elements: Array<{ fontSize: number }> }).elements
  assert.equal(elements.length, 1, '没有可删的注解时不许删正文')
})

test('only the named pages are touched', () => {
  const spec = deck([
    { template: 'content', elements: [{ type: 'text', text: 'A', fontSize: 18 }] },
    { template: 'content', elements: [{ type: 'text', text: 'B', fontSize: 18 }] },
  ])
  fitPages(spec, [2])
  const first = (spec.slides[0] as { elements: Array<{ fontSize: number }> }).elements[0]
  const second = (spec.slides[1] as { elements: Array<{ fontSize: number }> }).elements[0]
  assert.equal(first.fontSize, 18, '没点名的页不许动')
  assert.equal(second.fontSize, 16)
})

test('when nothing can shrink, the weakest note is dropped instead of the body', () => {
  const spec = deck([{
    template: 'content',
    elements: [
      { type: 'text', text: '正文主体', fontSize: 11 },
      { type: 'text', text: '注解甲', fontSize: 11 },
      { type: 'text', text: '注解乙', fontSize: 11 },
    ],
  }])
  const result = fitPages(spec, [1])
  const left = (spec.slides[0] as { elements: Array<{ text: string }> }).elements.map((e) => e.text)
  assert.equal(result.changed, 1)
  assert.deepEqual(left, ['正文主体', '注解甲'], '删最靠后的注解,正文留着')
  assert.match(result.actions.join(), /摘掉一段注解/u)
})

test('a page with nothing to give reports 0 so the caller stops looping', () => {
  const spec = deck([{ template: 'chart', elements: [{ type: 'chart', chartType: 'bar' }] }])
  assert.equal(fitPages(spec, [1]).changed, 0)
})

test('out-of-range page numbers are ignored instead of throwing', () => {
  const spec = deck([{ template: 'content', elements: [{ type: 'text', text: 'A', fontSize: 18 }] }])
  assert.equal(fitPages(spec, [0, 5, 99]).changed, 0)
})

test('fitting twice keeps shrinking (the caller rebuilds between passes)', () => {
  const spec = deck([{
    template: 'content',
    elements: [{ type: 'text', text: '正文', fontSize: 18 }],
  }])
  fitPages(spec, [1])
  fitPages(spec, [1])
  const body = (spec.slides[0] as { elements: Array<{ fontSize: number }> }).elements[0]
  assert.equal(body.fontSize, 13, '第二遍继续降档,直到引擎说放得下')
})

// ── 反方向:内容太少就撑开 ──────────────────────────────────────────────────

test('expanding steps body up one rung and leaves titles alone by default', () => {
  const spec = deck([{
    template: 'content',
    elements: [
      { type: 'text', role: 'title', text: '标题', fontSize: 28 },
      { type: 'text', text: '正文', fontSize: 16 },
    ],
  }])
  const result = expandPages(spec, [1])
  const [title, body] = (spec.slides[0] as { elements: Array<{ fontSize: number }> }).elements
  assert.equal(title.fontSize, 28, '默认不动标题')
  assert.equal(body.fontSize, 18)
  assert.equal(result.changed, 1)
})

test('expanding can also grow titles when asked, and both have ceilings', () => {
  const spec = deck([{
    template: 'content',
    elements: [
      { type: 'text', role: 'title', text: '标题', fontSize: 40 },
      { type: 'text', text: '正文', fontSize: 22 },
    ],
  }])
  assert.equal(expandPages(spec, [1], { growTitles: true }).changed, 0, '22pt 正文 / 40pt 标题都已到顶')
})

test('expanding twice would keep going, so the caller must rebuild between rounds', () => {
  const spec = deck([{ template: 'content', elements: [{ type: 'text', text: '正文', fontSize: 13 }] }])
  expandPages(spec, [1])
  const middle = (spec.slides[0] as { elements: Array<{ fontSize: number }> }).elements[0].fontSize
  expandPages(spec, [1])
  const after = (spec.slides[0] as { elements: Array<{ fontSize: number }> }).elements[0].fontSize
  assert.equal(middle, 16)
  assert.equal(after, 18)
})

test('expanding only touches the pages it is given', () => {
  const spec = deck([
    { template: 'content', elements: [{ type: 'text', text: 'A', fontSize: 13 }] },
    { template: 'content', elements: [{ type: 'text', text: 'B', fontSize: 13 }] },
  ])
  expandPages(spec, [1])
  assert.equal((spec.slides[1] as { elements: Array<{ fontSize: number }> }).elements[0].fontSize, 13)
})
