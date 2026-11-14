/**
 * contrast.test.ts — 底色对比兜底
 *
 * 真机上出现过的最刺眼的一类问题:深色底色页里放白色卡片,卡片里的文字也被写成
 * 近白色 —— 按"页底是深色"判当然合格,但它实际落在白卡片上,渲染出来是三张空白卡片,
 * 视觉模型的原话是"看起来像未完成的模板或渲染错误"。
 *
 * 所以判据必须按**元素真实的底色**算,而不是整页底色。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixSpecContrast, fixSlideContrast, contrastRatio } from './contrast'

const colors = {
  background: 'EEF3F6', surface: 'FBFDFB', foreground: '12202B', muted: '5B6B75',
  primary: '1F5C4D', accent: 'C2622F', border: 'D5DEE2',
}

function deck(slide: Record<string, unknown>): { theme: { colors: typeof colors }; slides: unknown[] } {
  return { theme: { colors }, slides: [slide] }
}

test('white text inside a white card on a dark page is re-coloured (it was invisible)', () => {
  const spec = deck({
    template: 'section',
    background: '1F5C4D',
    elements: [{
      type: 'container', columns: 3, children: [
        { type: 'container', background: true, fill: 'FBFDFB', children: [
          { type: 'text', text: '建议放行', fontSize: 18, bold: true, color: 'FBFDFB' },
          { type: 'text', text: '四步通过且四证齐全。', fontSize: 11, color: 'FBFDFB' },
        ] },
      ],
    }],
  })
  const fixed = fixSpecContrast(spec)
  assert.equal(fixed, 2, '两张卡片里的两段白字都要改')
  const card = (spec.slides[0] as { elements: Array<{ children: Array<{ children: Array<{ color?: string }> }> }> })
    .elements[0].children[0]
  for (const text of card.children) {
    assert.ok(contrastRatio(String(text.color), 'FBFDFB') >= 3, `仍然是 ${text.color},在 FBFDFB 卡片上读不清`)
  }
})

test('white text directly on a dark page is left alone', () => {
  const spec = deck({
    template: 'section',
    background: '1F5C4D',
    elements: [{ type: 'text', text: '章节标题', fontSize: 40, color: 'FFFFFF' }],
  })
  assert.equal(fixSpecContrast(spec), 0)
})

test('a transparent container keeps inheriting the page background', () => {
  // 没开 background 的容器不画底,里面的白字必须按页面深色底判 —— 不该被改
  const spec = deck({
    template: 'content',
    background: '1F5C4D',
    elements: [{
      type: 'container', columns: 2, children: [
        { type: 'text', text: '深色底上的白字', fontSize: 18, color: 'FFFFFF' },
      ],
    }],
  })
  assert.equal(fixSpecContrast(spec), 0)
})

test('a card with an explicit background object is judged by that object fill', () => {
  const spec = deck({
    template: 'content',
    background: 'EEF3F6',
    elements: [{
      type: 'container', background: { fill: '12202B', radius: 0.1 }, children: [
        { type: 'text', text: '深卡片上的浅字', fontSize: 18, color: 'FFFFFF' },
      ],
    }],
  })
  assert.equal(fixSpecContrast(spec), 0)
})

test('one slide at a time reports its own count', () => {
  const slide = {
    background: '1F5C4D',
    elements: [{
      type: 'container', background: true, fill: 'FBFDFB', children: [
        { type: 'text', text: '白字', fontSize: 18, color: 'FBFDFB' },
      ],
    }],
  }
  assert.equal(fixSlideContrast(slide, colors), 1)
  assert.equal(fixSlideContrast(slide, colors), 0, '修完之后再跑一次必须为 0:兜底要幂等')
})
