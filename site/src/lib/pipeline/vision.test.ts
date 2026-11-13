/**
 * vision.test.ts — 审美检查的输出解析
 *
 * 视觉模型的输出不能信:它会包代码块、会在 JSON 前后写一段话、会把页码写错。
 * 解析层必须容忍格式,但**不能**容忍编号跑偏(把第 7 页的问题安到第 3 页,
 * 修复轮就会去改一页本来没问题的页)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVisionReview, visionConfigured } from './vision'

test('a fenced JSON block is parsed', () => {
  const pages = parseVisionReview('好的,我审完了:\n```json\n{"pages":[{"page":1,"verdict":"good","score":90,"problems":[]}]}\n```')
  assert.ok(pages)
  assert.equal(pages!.length, 1)
  assert.equal(pages![0].verdict, 'good')
  assert.equal(pages![0].score, 90)
})

test('bare JSON surrounded by prose is parsed', () => {
  const pages = parseVisionReview('结论如下 {"pages":[{"page":2,"verdict":"needs_work","problems":[{"code":"WEAK_FOCUS","severity":"warning","detail":"没有视觉焦点"}]}]} 以上。')
  assert.ok(pages)
  assert.equal(pages![0].page, 2)
  assert.equal(pages![0].problems[0].code, 'WEAK_FOCUS')
  assert.equal(pages![0].problems[0].severity, 'warning')
})

test('an unknown verdict degrades to "unknown" instead of inventing one', () => {
  const pages = parseVisionReview('{"pages":[{"page":3,"verdict":"meh","problems":[]}]}')
  assert.equal(pages![0].verdict, 'unknown')
})

test('a severity the model invented becomes warning, not a new channel', () => {
  const pages = parseVisionReview('{"pages":[{"page":1,"verdict":"needs_work","problems":[{"code":"X","severity":"blocker","detail":"d"}]}]}')
  assert.equal(pages![0].problems[0].severity, 'warning')
})

test('problems without detail are dropped instead of producing empty evidence', () => {
  const pages = parseVisionReview('{"pages":[{"page":1,"verdict":"needs_work","problems":[{"code":"X","severity":"warning"},{"code":"Y","severity":"warning","detail":"有据可查"}]}]}')
  assert.equal(pages![0].problems.length, 1)
  assert.equal(pages![0].problems[0].code, 'Y')
})

test('non-JSON and empty input return null rather than a fake clean review', () => {
  assert.equal(parseVisionReview('我看过了,挺好的。'), null)
  assert.equal(parseVisionReview(''), null)
  assert.equal(parseVisionReview('{"pages":[]}'), null)
})

test('numbers out of range are clamped, not trusted', () => {
  const pages = parseVisionReview('{"pages":[{"page":1,"verdict":"good","score":420,"problems":[]}]}')
  assert.equal(pages![0].score, 100)
})

test('vision is reported as unconfigured when no key/model is present', () => {
  const before = { ...process.env }
  delete process.env.VISION_PROVIDER
  delete process.env.VISION_API_KEY
  delete process.env.VISION_MODEL
  assert.equal(visionConfigured(), false)
  process.env.VISION_PROVIDER = 'openai'
  process.env.VISION_API_KEY = 'k'
  process.env.VISION_MODEL = 'm'
  assert.equal(visionConfigured(), true)
  process.env = before
})
