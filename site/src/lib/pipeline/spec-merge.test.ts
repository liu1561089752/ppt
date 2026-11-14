/**
 * spec-merge.test.ts — 页级修复补丁的合并规则
 *
 * 视觉修复的验收前提是"只改了该改的页"。合并函数是这条前提的唯一实现处,
 * 所以这里把三种越界情形都钉死:改了非目标页、编号越界、补丁元素为空。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergePagePatches } from './spec'
import type { DeckSpecJson, OutlinePlan } from './types'

const plan: OutlinePlan = {
  title: 'deck',
  styleName: '雾绿',
  preset: 'sage',
  pages: [
    { title: '封面', template: 'cover', brief: 'b1' },
    { title: '指标', template: 'kpi', brief: 'b2' },
    { title: '对比', template: 'comparison', brief: 'b3' },
  ],
}

function deck(): DeckSpecJson {
  return {
    title: 'deck',
    pageSize: 'wide',
    theme: {
      colors: {
        background: 'EEF3F6', surface: 'FFFFFF', foreground: '12202B', muted: '5B6B75',
        primary: '1F5C4D', accent: 'C2622F', border: 'D5DEE2',
      },
      fonts: { heading: 'x', body: 'x' },
    },
    slides: [
      { template: 'cover', background: 'EEF3F6', notes: 'n1', elements: [{ type: 'text', text: '封面旧' }] },
      { template: 'kpi', background: 'EEF3F6', notes: 'n2', elements: [{ type: 'text', text: '指标旧' }] },
      { template: 'comparison', background: 'EEF3F6', notes: 'n3', elements: [{ type: 'text', text: '对比旧' }] },
    ],
  }
}

/** 读某页第一个元素的文本(测试里只关心"内容有没有被换掉") */
function textOf(deck2: DeckSpecJson, index: number): string {
  const element = deck2.slides[index]?.elements?.[0]
  return String(element?.text ?? '')
}

test('only the targeted page is replaced, the rest keep their exact objects', () => {
  const original = deck()
  const untouched = original.slides[0]
  const { spec, repairedPages } = mergePagePatches(
    original,
    [{ index: 2, elements: [{ type: 'text', text: '指标新', fontSize: 14 }] }],
    plan,
    [],
    [2],
  )
  assert.deepEqual(repairedPages, [2])
  assert.equal(spec.slides[1].elements.length, 1)
  assert.equal(textOf(spec, 1), '指标新')
  // 非目标页内容不变(浅拷贝,但内容相等)
  assert.deepEqual(spec.slides[0], untouched)
  assert.equal(textOf(spec, 2), '对比旧')
})

test('a patch for a page that was not asked for is discarded', () => {
  const { spec, repairedPages } = mergePagePatches(
    deck(),
    [{ index: 3, elements: [{ type: 'text', text: '偷偷改了第三页' }] }],
    plan,
    [],
    [2],
  )
  assert.deepEqual(repairedPages, [])
  assert.equal(textOf(spec, 2), '对比旧')
})

test('patches with no usable elements or an out-of-range index change nothing', () => {
  const original = deck()
  const { spec, repairedPages } = mergePagePatches(
    original,
    [
      { index: 2, elements: [] },
      { index: 2, elements: 'not-an-array' },
      { index: 9, elements: [{ type: 'text', text: 'x' }] },
      { index: 0, elements: [{ type: 'text', text: 'x' }] },
    ],
    plan,
    [],
    [2],
  )
  assert.deepEqual(repairedPages, [])
  assert.deepEqual(spec.slides, original.slides)
})

test('the outline owns the archetype, so a model cannot switch the page type', () => {
  const { spec } = mergePagePatches(
    deck(),
    [{ index: 2, template: 'quote', elements: [{ type: 'text', text: '新内容' }] }],
    plan,
    [],
    [2],
  )
  assert.equal(spec.slides[1].template, 'kpi')
})

test('background and notes: model value wins when given, otherwise the old one stays', () => {
  const withBackground = mergePagePatches(
    deck(),
    [{ index: 2, background: '1F5C4D', notes: '新讲稿', elements: [{ type: 'text', text: 'x' }] }],
    plan, [], [2],
  ).spec
  assert.equal(withBackground.slides[1].background, '1F5C4D')
  assert.equal(withBackground.slides[1].notes, '新讲稿')

  const withoutBackground = mergePagePatches(
    deck(),
    [{ index: 2, elements: [{ type: 'text', text: 'x' }] }],
    plan, [], [2],
  ).spec
  assert.equal(withoutBackground.slides[1].background, 'EEF3F6')
  assert.equal(withoutBackground.slides[1].notes, 'n2')
})

test('the outer deck keeps its title, theme and page size', () => {
  const original = deck()
  const { spec } = mergePagePatches(
    original,
    [{ index: 1, elements: [{ type: 'text', text: 'x' }] }],
    plan, [], [1],
  )
  assert.equal(spec.title, original.title)
  assert.equal(spec.pageSize, original.pageSize)
  assert.deepEqual(spec.theme, original.theme)
})
