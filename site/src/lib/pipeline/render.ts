/**
 * pipeline/render.ts — 把成品 .pptx 变成可看的逐页 PNG
 *
 * 为什么要有这一步:几何检查看的是 JSON,审美与"这一页是不是空的"只有**看过**才知道。
 * 没有渲染就没有逐页视觉检查,也就没有真正的自动修复闭环(改了哪儿、好没好,无从判断)。
 *
 * 渲染器按可用性挑选(env NATIVE_RENDERER = auto | libreoffice | preview | none):
 *   - libreoffice:soffice --headless 转 PDF,pdftoppm 再出 PNG。最接近真实放映效果,
 *     但需要装 LibreOffice + poppler;字体不全时 CJK 会替换成可用字面。
 *   - preview:引擎自带的 scripts/preview_deck.py(python-pptx + Pillow)。不依赖 Office,
 *     画的是 PPTX 里真实的几何、填充、切图与换行,但**不**是放映级还原:
 *     图表画成占位框、字体只做近似字面、渐变/阴影/特效只近似。
 *   - none:不渲染(生产机两者都没有时的显式降级,后续视觉检查会被标记为未执行)。
 *
 * 每个渲染器都返回同一份结构,并把"这是近似渲染"写进 notes —— 报告里不能把
 * 预览图当成 Office 还原度来宣称。
 */
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { engineRoot } from './native'
import type { PagePixelMetrics } from './review'

export type RendererKind = 'libreoffice' | 'preview' | 'none'

export interface RenderedPage {
  page: number
  file: string
  bytes: number
}

export interface RenderResult {
  ok: boolean
  renderer: RendererKind
  pages: RenderedPage[]
  dir?: string
  ms: number
  /** 渲染器的能力边界与降级原因,原样进报告 */
  notes: string[]
  error?: string
}

/** 渲染超时:25 页 LibreOffice 首启 + 转换约 20-40s,预览渲染只要几秒 */
const RENDER_TIMEOUT_MS = Number(process.env.NATIVE_RENDER_TIMEOUT_MS || 180_000)

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = RENDER_TIMEOUT_MS): Promise<RunResult> {
  return new Promise<RunResult>((done) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    // spawn 的"找不到可执行文件"是**异步**的 'error' 事件,不是同步 throw,
    // 所以这里可以先起进程、再挂超时;finish 里统一收尾,避免双 resolve。
    const child = spawn(cmd, args, { cwd, stdio: 'pipe', windowsHide: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref?.()
    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ code, stdout, stderr, timedOut, spawnError })
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (e: Error) => finish(null, `${e.name}: ${e.message}`))
    child.on('close', (code: number | null) => finish(code))
  })
}

/** 可执行文件是否在 PATH 里(windows 用 where,posix 用 command -v) */
async function commandExists(cmd: string): Promise<boolean> {
  const probe = process.platform === 'win32'
    ? await run('where', [cmd], process.cwd(), 15_000)
    : await run('sh', ['-lc', `command -v ${cmd}`], process.cwd(), 15_000)
  return probe.code === 0 && !probe.spawnError
}

/** 找 python:Windows 上通常是 python,Linux/macOS 是 python3;env PYTHON 优先 */
function pythonCommand(): string {
  const configured = (process.env.PYTHON || '').trim()
  return configured || (process.platform === 'win32' ? 'python' : 'python3')
}

/** 找 soffice:LibreOffice 并不总在 PATH 里,Windows 默认装在这几个位置 */
function sofficeCandidates(): string[] {
  const configured = (process.env.LIBREOFFICE_SOFFICE || '').trim()
  if (configured) return [configured]
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ]
  }
  return ['/usr/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']
}

async function resolveRenderer(requested: RendererKind | 'auto'): Promise<{ kind: RendererKind; note: string }> {
  if (requested === 'none') return { kind: 'none', note: 'NATIVE_RENDERER=none:本次不渲染,视觉检查未执行' }
  if (requested === 'libreoffice' || requested === 'auto') {
    const local = sofficeCandidates().find((candidate) => existsSync(candidate))
    const inPath = local ? undefined : await commandExists('soffice')
    if (local || inPath) {
      if (await commandExists('pdftoppm')) return { kind: 'libreoffice', note: 'LibreOffice + poppler 渲染(PDF→PNG)' }
      return { kind: 'preview', note: '有 soffice 但没有 poppler 的 pdftoppm,降级为引擎预览渲染' }
    }
    if (requested === 'libreoffice') {
      return { kind: 'preview', note: '指定了 libreoffice 但没找到 soffice,降级为引擎预览渲染' }
    }
  }
  const python = pythonCommand()
  if (await commandExists(python)) {
    return {
      kind: 'preview',
      note: `引擎预览渲染(python-pptx + Pillow):几何/填充/切图/换行是真实的,`
        + '图表只画占位框,字形与特效为近似',
    }
  }
  return { kind: 'none', note: '既没有 LibreOffice,也没有可用的 python,本次不渲染' }
}

function listPngs(dir: string): RenderedPage[] {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir)
    .filter((name) => /^slide[-_]?\d+\.png$/i.test(name))
    .sort()
  return files.map((name, index) => {
    const file = join(dir, name)
    const matched = name.match(/(\d+)/)
    return {
      page: matched ? Number(matched[1]) : index + 1,
      file,
      bytes: (() => { try { return statSync(file).size } catch { return 0 } })(),
    }
  })
}

/** 渲染整份 deck 到 `outDir`,返回逐页 PNG(LibreOffice 与预览渲染同一份契约) */
export async function renderDeck(
  pptxPath: string,
  outDir: string,
  options: { renderer?: RendererKind | 'auto'; scale?: number } = {},
): Promise<RenderResult> {
  const startedAt = Date.now()
  const absolutePptx = resolve(pptxPath)
  const absoluteOut = resolve(outDir)
  const notes: string[] = []
  if (!existsSync(absolutePptx)) {
    return { ok: false, renderer: 'none', pages: [], ms: 0, notes, error: `要渲染的 pptx 不存在:${absolutePptx}` }
  }
  const requested = (options.renderer || (process.env.NATIVE_RENDERER || 'auto')).trim().toLowerCase() as RendererKind | 'auto'
  const resolved = await resolveRenderer(requested)
  notes.push(resolved.note)

  const finishNone = (error?: string): RenderResult => ({
    ok: false,
    renderer: 'none',
    pages: [],
    ms: Date.now() - startedAt,
    notes,
    error,
  })

  if (resolved.kind === 'none') return finishNone('没有可用的渲染器')

  try {
    // 目录准备由渲染器自己负责,但父目录要在这里建好(preview_deck.py 会 mkdir)
    mkdirSync(absoluteOut, { recursive: true })
    // 上一次的残页必须先清掉,否则少渲染一页时会读到旧图,报告就在撒谎
    for (const stale of readdirSync(absoluteOut)) {
      if (/^slide[-_]?\d+\.png$/i.test(stale)) rmSync(join(absoluteOut, stale), { force: true })
    }
  } catch (error) {
    return finishNone(`渲染目录准备失败:${(error as Error).message}`)
  }

  if (resolved.kind === 'libreoffice') {
    const soffice = sofficeCandidates().find((candidate) => existsSync(candidate)) || 'soffice'
    const converted = await run(soffice, [
      '--headless', '--norestore', '--invisible',
      '--convert-to', 'pdf', '--outdir', absoluteOut, absolutePptx,
    ], absoluteOut)
    if (converted.spawnError || converted.code !== 0) {
      notes.push(`soffice 转换失败(${converted.spawnError || `exit ${converted.code}`}):`
        + `${(converted.stderr || converted.stdout).trim().slice(0, 300)};改用引擎预览渲染`)
    } else {
      const pdf = join(absoluteOut, basename(absolutePptx).replace(/\.pptx$/i, '.pdf'))
      if (!existsSync(pdf)) {
        notes.push(`soffice 报告成功但没有产出 PDF(${pdf});改用引擎预览渲染`)
      } else {
        const raster = await run('pdftoppm', ['-png', '-r', '110', pdf, join(absoluteOut, 'slide')], absoluteOut)
        if (raster.spawnError || raster.code !== 0) {
          notes.push(`pdftoppm 失败:${(raster.stderr || '').trim().slice(0, 200)};改用引擎预览渲染`)
        } else {
          const pages = listPngs(absoluteOut).map((page, index) => ({ ...page, page: index + 1 }))
          if (pages.length) {
            return { ok: true, renderer: 'libreoffice', pages, dir: absoluteOut, ms: Date.now() - startedAt, notes }
          }
          notes.push('pdftoppm 没有产出任何 PNG;改用引擎预览渲染')
        }
      }
    }
  }

  // 引擎预览渲染(默认路径,或 libreoffice 失败后的兜底)
  const root = engineRoot()
  const script = join(root, 'scripts', 'preview_deck.py')
  if (!existsSync(script)) return finishNone(`缺少预览渲染脚本:${script}`)
  const args = [script, absolutePptx, '--output-dir', absoluteOut, '--sheet', join(absoluteOut, 'sheet.png'), '--quiet']
  if (options.scale) args.push('--scale', String(options.scale))
  const preview = await run(pythonCommand(), args, root)
  if (preview.spawnError) return finishNone(`无法启动 python:${preview.spawnError}`)
  if (preview.timedOut) return finishNone(`预览渲染超时(${Math.round(RENDER_TIMEOUT_MS / 1000)}s)`)
  const pages = listPngs(absoluteOut).map((page, index) => ({ ...page, page: index + 1 }))
  if (preview.code !== 0 || !pages.length) {
    return finishNone(`预览渲染失败(exit ${preview.code}):${(preview.stderr || preview.stdout).trim().slice(0, 400)}`)
  }
  if (!notes.some((note) => note.startsWith('引擎预览渲染'))) notes.push(resolved.note)
  return { ok: true, renderer: 'preview', pages, dir: absoluteOut, ms: Date.now() - startedAt, notes }
}

export interface PixelMetricsResult {
  ok: boolean
  pages: PagePixelMetrics[]
  averages?: Record<string, number>
  thresholds?: Record<string, number>
  error?: string
  notes: string[]
}

/**
 * 量渲染出来的图:整页有多少内容、内容排到页面多高、是不是一块纯色。
 *
 * 这一步刻意放在 Python 侧(Pillow 已经在渲染链路上):TS 里没有图像库,
 * 手写 PNG 解码只为算几个比例不值得。量不到就如实 ok:false,由调用方
 * 在报告里写成"像素检查未执行",不能当成通过。
 */
export async function measureRenderedPages(dir: string): Promise<PixelMetricsResult> {
  const absolute = resolve(dir)
  const notes: string[] = []
  if (!existsSync(absolute)) return { ok: false, pages: [], error: `渲染目录不存在:${absolute}`, notes }
  let root: string
  try {
    root = engineRoot()
  } catch (error) {
    return { ok: false, pages: [], error: (error as Error).message, notes }
  }
  const script = join(root, 'scripts', 'render_metrics.py')
  if (!existsSync(script)) {
    return { ok: false, pages: [], error: `缺少像素度量脚本:${script}`, notes }
  }
  const jsonOut = join(tmpdir(), `render-metrics-${process.pid}-${Date.now()}.json`)
  const result = await run(pythonCommand(), [script, absolute, '--json', jsonOut, '--quiet'], root, 120_000)
  if (result.spawnError) {
    return { ok: false, pages: [], error: `无法启动 python:${result.spawnError}`, notes }
  }
  if (result.timedOut) return { ok: false, pages: [], error: '像素度量超时', notes }
  try {
    if (!existsSync(jsonOut)) throw new Error(`没有产出度量文件(exit ${result.code}):${(result.stderr || '').trim().slice(0, 300)}`)
    const parsed = JSON.parse(readFileSync(jsonOut, 'utf-8')) as {
      ok?: boolean
      pages?: PagePixelMetrics[]
      averages?: Record<string, number>
      thresholds?: Record<string, number>
      error?: string
    }
    rmSync(jsonOut, { force: true })
    if (!parsed?.ok || !Array.isArray(parsed.pages)) {
      return { ok: false, pages: [], error: parsed?.error || '像素度量没有返回 pages', notes }
    }
    return { ok: true, pages: parsed.pages, averages: parsed.averages, thresholds: parsed.thresholds, notes }
  } catch (error) {
    return { ok: false, pages: [], error: (error as Error).message, notes }
  }
}
