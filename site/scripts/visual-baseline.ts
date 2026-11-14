/**
 * scripts/visual-baseline.ts — 确定性视觉回归(不需要 Office,也不需要模型)
 *
 * 引擎里已有 visual_golden.py,但它依赖 LibreOffice 才能出图。这条脚本走的是
 * **不依赖 Office** 的那条渲染路径(引擎自带的 Pillow 预览器),把每页的像素度量
 * (墨量 / 内容底边 / 颜色数)与一份人工确认过的基线比对:
 *
 *   npx tsx scripts/visual-baseline.ts --update     # 人工确认后写基线
 *   npx tsx scripts/visual-baseline.ts --check      # 默认:比基线,漂移就红
 *
 * 它守的是"版式有没有被无意改坏":比如卡片背景的开关丢了(墨量骤降)、配图没落地
 * (墨量骤降)、标题被挤成两行(内容底边下移)。它不判"好不好看",也不替代人看。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { measureRenderedPages, renderDeck } from '../src/lib/pipeline/render'
import { engineRoot } from '../src/lib/pipeline/native'

interface BaselinePage {
  page: number
  ink_ratio: number
  content_bottom_ratio: number
  distinct_colours: number
  /** 字体无关的几何指纹:叶子元素个数与内容总高度(英寸) */
  elements?: number
  height?: number
}
interface Baseline {
  /** 基线是怎么来的:哪份 deck、哪个渲染器、什么时候、什么平台 */
  deck: string
  renderer: string
  platform: string
  updatedAt: string
  pages: BaselinePage[]
}

/**
 * 允许的漂移。
 *
 * 像素度量与**字体**有关:同一份 OOXML 在 Windows(微软雅黑)和 CI(Noto Sans CJK)
 * 上墨量本来就不一样。所以像素只在**同一平台**上按紧容差比对,换平台只做"没画白页"
 * 的底线检查;精确的版式回归始终由字体无关的几何指纹(元素个数 / 内容总高度)承担。
 */
const TOLERANCE = {
  inkRatio: 0.03,
  contentBottom: 0.05,
  distinctColours: 0.2,
  /** 几何:元素个数必须一致,内容高度允许 1/50 英寸的浮点差 */
  heightIn: 0.02,
  /** 换平台时的底线:低于这个墨量就是"整页没画出来" */
  sanityInkRatio: 0.01,
  sanityColours: 6,
}

const ROOT = resolve(import.meta.dirname, '../..')
const DECK_SPEC = join(ROOT, 'work/design-baselines/probe.js')
const WORK_DIR = join(ROOT, 'site/.work/visual-baseline')
const BASELINE_FILE = join(ROOT, 'work/design-baselines/baseline-visual.json')

function buildDeck(outPath: string, layoutPath: string): void {
  const cli = join(engineRoot(), 'cli.js')
  execFileSync(
    process.execPath,
    [cli, DECK_SPEC, outPath, '--strict', '--json', '--layout-out', layoutPath],
    { cwd: engineRoot(), stdio: 'pipe' },
  )
}

interface LayoutPage {
  elements?: Array<{ y?: number; h?: number }>
}

/**
 * 字体无关的版面指纹:叶子元素个数 + 内容总高度 + 内容底边。
 * 坐标由引擎算,所以这三个数在换字体/换机器时应当完全一致 —— 一旦变了,
 * 就是版式真的被改了,或者是布局算法退化。
 */
function geometryFingerprint(layoutPath: string): Map<number, { elements: number; height: number }> {
  const out = new Map<number, { elements: number; height: number }>()
  if (!existsSync(layoutPath)) return out
  const raw = JSON.parse(readFileSync(layoutPath, 'utf8')) as { slides?: LayoutPage[] }
  const slides = Array.isArray(raw.slides) ? raw.slides : []
  slides.forEach((slide, index) => {
    const elements = Array.isArray(slide.elements) ? slide.elements : []
    let top = Number.POSITIVE_INFINITY
    let bottom = 0
    for (const element of elements) {
      const y = Number(element?.y)
      const h = Number(element?.h)
      if (!Number.isFinite(y)) continue
      top = Math.min(top, y)
      bottom = Math.max(bottom, y + (Number.isFinite(h) ? h : 0))
    }
    out.set(index + 1, {
      elements: elements.length,
      height: Number.isFinite(top) && bottom > top ? bottom - top : 0,
    })
  })
  return out
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : 'n/a'
}

async function main(): Promise<void> {
  const update = process.argv.includes('--update')
  if (!existsSync(DECK_SPEC)) {
    console.error(`[visual-baseline] 找不到基准 deck:${DECK_SPEC}`)
    process.exitCode = 1
    return
  }
  try {
    engineRoot()
  } catch (error) {
    console.log(`[visual-baseline] SKIP 引擎不可用:${(error as Error).message}`)
    return
  }

  mkdirSync(WORK_DIR, { recursive: true })
  const pptx = join(WORK_DIR, 'probe.pptx')
  const layoutPath = join(WORK_DIR, 'layout.json')
  buildDeck(pptx, layoutPath)
  const geometry = geometryFingerprint(layoutPath)

  const render = await renderDeck(pptx, join(WORK_DIR, 'render'), { renderer: 'preview' })
  if (!render.ok) {
    console.error(`[visual-baseline] 渲染失败:${render.error || '未知原因'}`)
    process.exitCode = 1
    return
  }
  const metrics = await measureRenderedPages(render.dir || join(WORK_DIR, 'render'))
  if (!metrics.ok) {
    console.error(`[visual-baseline] 度量失败:${metrics.error || metrics.notes.join('; ')}`)
    process.exitCode = 1
    return
  }

  const current: Baseline = {
    deck: 'work/design-baselines/probe.js',
    renderer: render.renderer,
    platform: process.platform,
    updatedAt: new Date().toISOString(),
    pages: metrics.pages.map((page) => ({
      page: page.page,
      ink_ratio: Number(page.ink_ratio ?? 0),
      content_bottom_ratio: Number(page.content_bottom_ratio ?? 0),
      distinct_colours: Number(page.distinct_colours ?? 0),
      elements: geometry.get(page.page)?.elements,
      height: geometry.get(page.page)?.height,
    })),
  }

  if (update) {
    writeFileSync(BASELINE_FILE, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    console.log(`[visual-baseline] 已写入基线 ${current.pages.length} 页:${BASELINE_FILE}`)
    return
  }

  if (!existsSync(BASELINE_FILE)) {
    console.error(`[visual-baseline] 基线不存在,先跑一次 --update:${BASELINE_FILE}`)
    process.exitCode = 1
    return
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline
  if (baseline.pages.length !== current.pages.length) {
    console.error(
      `[visual-baseline] FAIL 页数变了:基线 ${baseline.pages.length} 页,现在 ${current.pages.length} 页`
        + '(版式基准 deck 被增删页时必须显式 --update 并人工看图)',
    )
    process.exitCode = 1
    return
  }

  const drift: string[] = []
  const pixelStrict = baseline.platform === process.platform
  if (!pixelStrict) {
    console.log(
      `[visual-baseline] 基线是在 ${baseline.platform} 上生成的,当前是 ${process.platform}:`
        + '像素只做底线检查,几何与元素数照常严格比对',
    )
  }
  baseline.pages.forEach((expected, index) => {
    const actual = current.pages[index]
    const page = expected.page
    if (pixelStrict) {
      const inkDelta = Math.abs(actual.ink_ratio - expected.ink_ratio)
      const bottomDelta = Math.abs(actual.content_bottom_ratio - expected.content_bottom_ratio)
      const colourDelta = expected.distinct_colours > 0
        ? Math.abs(actual.distinct_colours - expected.distinct_colours) / expected.distinct_colours
        : 0
      if (inkDelta > TOLERANCE.inkRatio) {
        drift.push(`p${page} 墨量 ${fmt(expected.ink_ratio)} → ${fmt(actual.ink_ratio)}(差 ${fmt(inkDelta)})`)
      }
      if (bottomDelta > TOLERANCE.contentBottom) {
        drift.push(`p${page} 内容底边 ${fmt(expected.content_bottom_ratio)} → ${fmt(actual.content_bottom_ratio)}(差 ${fmt(bottomDelta)})`)
      }
      if (colourDelta > TOLERANCE.distinctColours) {
        drift.push(`p${page} 颜色数 ${expected.distinct_colours} → ${actual.distinct_colours}`)
      }
    } else {
      if (actual.ink_ratio < TOLERANCE.sanityInkRatio) {
        drift.push(`p${page} 渲染后几乎没有内容(墨量 ${fmt(actual.ink_ratio)})`)
      }
      if (actual.distinct_colours < TOLERANCE.sanityColours) {
        drift.push(`p${page} 渲染后只有 ${actual.distinct_colours} 种颜色`)
      }
    }
    // 几何指纹:字体无关,所以必须精确 —— 元素多/少一个、内容高度变了,都是版式真的变了
    if (expected.elements !== undefined && actual.elements !== undefined
      && expected.elements !== actual.elements) {
      drift.push(`p${page} 元素数 ${expected.elements} → ${actual.elements}`)
    }
    if (expected.height !== undefined && actual.height !== undefined
      && Math.abs(expected.height - actual.height) > TOLERANCE.heightIn) {
      drift.push(`p${page} 内容高度 ${expected.height.toFixed(2)}in → ${actual.height.toFixed(2)}in`)
    }
  })

  if (drift.length) {
    console.error(`[visual-baseline] FAIL ${drift.length} 处版式漂移:`)
    for (const line of drift) console.error(`    - ${line}`)
    console.error('    确实是有意的改动就 --update,然后人工看一眼 sheet.png 再提交。')
    process.exitCode = 1
    return
  }
  console.log(`[visual-baseline] OK ${current.pages.length} 页与基线一致(渲染器 ${render.renderer})`)
}

main().catch((error) => {
  console.error('[visual-baseline] 未捕获异常:', error)
  process.exitCode = 1
})

