/**
 * quality-loop.test.ts — 视觉闭环的控制流
 *
 * 这条循环最贵的两个错误都不是"判据不准",而是**控制流**:
 *   - 修完不复检就宣布通过(报告描述的不是交付的那一份);
 *   - 修复轮顺手改了别的页,却被当成成功写入。
 * 两个都不需要 LLM 就能测:渲染、度量、视觉、页级修复都通过 hooks 注入桩。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runQualityLoop, type QualityLoopDeps } from './quality-loop'
import type { DeckSpecJson, NativeBuildResult, OutlinePlan, PreviewSlide } from './types'
import type { RenderResult } from './render'
import type { PixelMetricsResult } from './render'
import type { DeckVisionReview } from './vision'
import type { PageRepairResult } from './spec'

const plan: OutlinePlan = {
  title: 'deck',
  styleName: '雾绿',
  preset: 'sage',
  pages: [
    { title: '封面', template: 'cover', brief: 'b1' },
    { title: '正文', template: 'content', brief: 'b2' },
    { title: '收束', template: 'section', brief: 'b3' },
  ],
}

function spec(): DeckSpecJson {
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
      { template: 'cover', background: 'EEF3F6', elements: [{ type: 'text', text: '封面' }] },
      // 正文页必须有两段正文,否则会触发构图审查(SHAPE_THIN_PAGE)——
      // 这里刻意做成"合格的一页",好让被测的是循环而不是内容
      { template: 'content', background: 'EEF3F6', elements: [
        { type: 'text', role: 'title', text: '正文', fontSize: 26 },
        { type: 'text', text: '第一段正文,给出判断。', fontSize: 14 },
        { type: 'text', text: '第二段正文,给出依据。', fontSize: 14 },
      ] },
      { template: 'section', background: 'EEF3F6', elements: [{ type: 'text', text: '收束' }] },
    ],
  }
}

/** 一页只在给定 y 上放一个文字盒:layout 就是它的指纹 */
function layout(...ys: number[]): PreviewSlide[] {
  return ys.map((y) => ({
    elements: [{ type: 'text', x: 0.8, y, w: 6, h: 0.6, fontSize: 16, color: '12202B' } as never],
  })) as PreviewSlide[]
}

function builtAt(layoutPages: PreviewSlide[]): NativeBuildResult {
  return {
    ok: true,
    warnings: 0,
    bytes: 1000,
    objects: {},
    report: '{}',
    slides: layoutPages.length,
    layout: layoutPages,
    pageSize: { width: 13.333, height: 7.5 },
  }
}

const goodRender: RenderResult = {
  ok: true,
  renderer: 'preview',
  pages: [
    { page: 1, file: '/tmp/slide-01.png', bytes: 100 },
    { page: 2, file: '/tmp/slide-02.png', bytes: 100 },
    { page: 3, file: '/tmp/slide-03.png', bytes: 100 },
  ],
  dir: '/tmp/render',
  ms: 10,
  notes: ['test'],
}

/** 三页都"整页有内容、排到页底"的健康度量 */
const healthyPixels: PixelMetricsResult = {
  ok: true,
  notes: [],
  pages: [
    { page: 1, ink_ratio: 0.3, content_bottom_ratio: 0.9, distinct_colours: 100 },
    { page: 2, ink_ratio: 0.3, content_bottom_ratio: 0.9, distinct_colours: 100 },
    { page: 3, ink_ratio: 0.3, content_bottom_ratio: 0.9, distinct_colours: 100 },
  ],
}

/** 第 2 页塌在上三分之一:唯一的 warning 来源 */
const sparsePixels: PixelMetricsResult = {
  ok: true,
  notes: [],
  pages: [
    { page: 1, ink_ratio: 0.3, content_bottom_ratio: 0.9, distinct_colours: 100 },
    { page: 2, ink_ratio: 0.2, content_bottom_ratio: 0.4, distinct_colours: 100 },
    { page: 3, ink_ratio: 0.3, content_bottom_ratio: 0.9, distinct_colours: 100 },
  ],
}

const noVision: DeckVisionReview = {
  enabled: false, provider: 'none', pages: [], note: '未配置视觉模型',
}

function deps(overrides: Partial<QualityLoopDeps> & { hooks: QualityLoopDeps['hooks'] }): QualityLoopDeps {
  const base: QualityLoopDeps = {
    input: {
      taskId: 't1', userId: 'u1', topic: 'topic', language: 'zh-CN', slideCount: 3,
    },
    taskId: 't1',
    plan,
    research: { facts: '', images: [] },
    spec: spec(),
    built: builtAt(layout(0.6, 0.6, 0.6)),
    outPath: '/tmp/deck.pptx',
    rebuild: async () => builtAt(layout(0.6, 0.6, 0.6)),
    emitStage: async () => {},
    enabled: true,
    maxRepairs: 2,
    ...overrides,
  }
  // 兜底桩:任何测试都不可能误触真实的 LLM / 渲染 / 度量
  base.hooks = {
    render: async () => goodRender,
    measure: async () => healthyPixels,
    vision: async () => noVision,
    repair: async (_input, _taskId, _plan, deck): Promise<PageRepairResult> => ({
      spec: deck, repairedPages: [], missedPages: [],
    }),
    ...(overrides.hooks || {}),
  }
  return base
}

test('a clean deck stops after one review and writes nothing', async () => {
  let rebuilds = 0
  const report = await runQualityLoop(deps({
    rebuild: async () => { rebuilds++; return builtAt(layout(0.6, 0.6, 0.6)) },
    hooks: {
      render: async () => goodRender,
      measure: async () => healthyPixels,
      vision: async () => noVision,
    },
  }))
  assert.equal(report.stopped, 'clean')
  assert.equal(report.reviews, 1)
  assert.equal(report.repairs.length, 0)
  assert.equal(rebuilds, 0)
  assert.deepEqual(report.problems, [])
})

test('a sparse page is repaired, then re-reviewed before the loop can claim success', async () => {
  let reviews = 0
  let rebuilds = 0
  const report = await runQualityLoop(deps({
    rebuild: async () => { rebuilds++; return builtAt(layout(0.6, 0.6, 0.6)) },
    hooks: {
      render: async () => goodRender,
      // 第一次稀疏,修完之后健康 —— 用来证明"复检"真的发生了
      measure: async () => { reviews++; return reviews === 1 ? sparsePixels : healthyPixels },
      vision: async () => noVision,
      repair: async (_input, _taskId, _plan, deck): Promise<PageRepairResult> => ({
        spec: deck, repairedPages: [2], missedPages: [],
      }),
    },
  }))
  assert.equal(report.stopped, 'clean')
  assert.equal(report.reviews, 2, '修复之后必须再检查一次')
  assert.equal(rebuilds, 1)
  assert.equal(report.repairs.length, 1)
  assert.deepEqual(report.repairs[0].pages, [2])
  assert.deepEqual(report.problems, [])
})

test('a repair that also moves an untouched page is rolled back, not accepted', async () => {
  const builds: Array<number[]> = []
  const report = await runQualityLoop(deps({
    rebuild: async () => {
      // 第一次重建(修复稿):第 1、3 页的盒子被顺手挪了;第二次重建(回滚):回到原样
      const ys = builds.length === 0 ? [1.2, 0.6, 1.2] : [0.6, 0.6, 0.6]
      builds.push(ys)
      return builtAt(layout(...ys))
    },
    hooks: {
      render: async () => goodRender,
      measure: async () => sparsePixels,
      vision: async () => noVision,
      repair: async (_input, _taskId, _plan, deck): Promise<PageRepairResult> => ({
        spec: deck, repairedPages: [2], missedPages: [],
      }),
    },
  }))
  assert.equal(report.stopped, 'regression')
  assert.equal(report.repairs.length, 1)
  assert.equal(report.repairs[0].rolledBack, true)
  assert.match(report.repairs[0].error || '', /非目标页/)
  assert.equal(builds.length, 2, '回滚必须真的把上一份 spec 重建回去')
  assert.deepEqual(builds[1], [0.6, 0.6, 0.6])
})

test('when repairs run out the report keeps the remaining warnings instead of claiming success', async () => {
  const report = await runQualityLoop(deps({
    maxRepairs: 1,
    hooks: {
      render: async () => goodRender,
      measure: async () => sparsePixels, // 一直稀疏:修复没解决问题
      vision: async () => noVision,
      repair: async (_input, _taskId, _plan, deck): Promise<PageRepairResult> => ({
        spec: deck, repairedPages: [2], missedPages: [],
      }),
    },
  }))
  assert.equal(report.stopped, 'repairs-exhausted')
  assert.equal(report.repairs.length, 1)
  assert.ok(report.problems.some((problem) => problem.page === 2 && problem.severity === 'warning'))
  assert.match(report.note, /仍有/)
})

test('a model that returns nothing usable stops the loop without touching the deck', async () => {
  let rebuilds = 0
  const report = await runQualityLoop(deps({
    rebuild: async () => { rebuilds++; return builtAt(layout(0.6, 0.6, 0.6)) },
    hooks: {
      render: async () => goodRender,
      measure: async () => sparsePixels,
      vision: async () => noVision,
      repair: async (_input, _taskId, _plan, deck): Promise<PageRepairResult> => ({
        spec: deck, repairedPages: [], missedPages: [2],
      }),
    },
  }))
  assert.equal(report.stopped, 'no-repair-applied')
  assert.equal(rebuilds, 0)
  assert.deepEqual(report.repairs[0].missedPages, [2])
})

test('if the rebuild fails the previous deck is restored and the failure is reported', async () => {
  let calls = 0
  const report = await runQualityLoop(deps({
    rebuild: async () => {
      calls++
      // 第一次(修复稿)构建失败,第二次(回滚)成功
      return calls === 1
        ? { ...builtAt([]), ok: false, error: '引擎拒绝了这份 spec' }
        : builtAt(layout(0.6, 0.6, 0.6))
    },
    hooks: {
      render: async () => goodRender,
      measure: async () => sparsePixels,
      vision: async () => noVision,
      repair: async (_input, _taskId, _plan, deck): Promise<PageRepairResult> => ({
        spec: deck, repairedPages: [2], missedPages: [],
      }),
    },
  }))
  assert.equal(report.stopped, 'error')
  assert.equal(report.repairs[0].rolledBack, true)
  assert.equal(calls, 2)
  assert.match(report.note, /已回滚/)
})

test('a deck that cannot be rendered is reported as "visual checks not run", not as passing', async () => {
  const report = await runQualityLoop(deps({
    hooks: {
      render: async () => ({
        ok: false, renderer: 'none', pages: [], ms: 1, notes: [],
        error: '既没有 LibreOffice,也没有可用的 python',
      }),
      measure: async () => healthyPixels,
      vision: async () => noVision,
    },
  }))
  assert.equal(report.stopped, 'render-unavailable')
  assert.equal(report.render?.ok, false)
  assert.match(report.note, /视觉检查未执行/)
  assert.equal(report.repairs.length, 0)
})

test('with repairs disabled the loop still reviews and reports, but never rebuilds', async () => {
  let rebuilds = 0
  const report = await runQualityLoop(deps({
    enabled: false,
    rebuild: async () => { rebuilds++; return builtAt(layout(0.6, 0.6, 0.6)) },
    hooks: {
      render: async () => goodRender,
      measure: async () => sparsePixels,
      vision: async () => noVision,
    },
  }))
  assert.equal(report.enabled, false)
  assert.equal(report.stopped, 'disabled')
  assert.equal(rebuilds, 0)
  assert.ok(report.problems.some((problem) => problem.page === 2))
})

test('vision problems are attributed to the vision channel, never merged into geometry', async () => {
  const visionWithIssue: DeckVisionReview = {
    enabled: true,
    provider: 'openai',
    model: 'test',
    note: 'ok',
    pages: [
      { page: 1, verdict: 'good', problems: [] },
      { page: 2, verdict: 'needs_work', summary: '像后台报表', problems: [
        { code: 'GENERIC_CARDS', severity: 'warning', detail: '三个等宽卡片没有任何视觉差异' },
      ] },
      { page: 3, verdict: 'good', problems: [] },
    ],
  }
  const report = await runQualityLoop(deps({
    maxRepairs: 0,
    hooks: {
      render: async () => goodRender,
      measure: async () => healthyPixels,
      vision: async () => visionWithIssue,
    },
  }))
  const visionProblems = report.problems.filter((problem) => problem.source === 'vision')
  assert.equal(visionProblems.length, 1)
  assert.equal(visionProblems[0].page, 2)
  assert.equal(report.problems.filter((problem) => problem.source === 'geometry').length, 0)
})
