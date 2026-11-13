/**
 * pipeline/native.ts — 原生引擎桥(Deck Spec JSON → .pptx)
 *
 * 全部走 child_process.spawn + stdio:'pipe',不经 shell(Windows 下没有引号拼接的坑)。
 * 引擎契约(实测,见 .work/LOG-pipeline.md「引擎契约实测」):
 *
 *   node <root>/cli.js <spec.json> --check --json          # 只校验,exit 0 / exit 1
 *   node <root>/cli.js <spec.json> <out.pptx> --strict --json --report <r.json> --layout-out <l.json>
 *
 *   - 校验失败:stdout 空,stderr 形如
 *       spec rejected (1 error(s)): C:\…\spec.json
 *         - deck.slides must be a non-empty array
 *     错误逐条按 `^  - ` 提取。
 *   - 构建成功但 `--strict` 命中布局警告:stdout 仍是一行 JSON(ok:true)且
 *     **.pptx 已经落盘**,只是 exit 1。所以判定成功 = 文件存在 + stdout.ok===true,
 *     绝不能把 exit 1 一律当失败(那会把所有带警告的成品丢掉)。
 *   - 引擎 stderr 原文一律带进错误信息/report,不吞(排障时那是唯一现场)。
 */
import { spawn } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import {
  ENGINE_BUILD_TIMEOUT_MS,
  ENGINE_CHECK_TIMEOUT_MS,
  type EngineDoctorResult,
  type NativeBuildResult,
  type PreviewElement,
  type PreviewSlide,
  type SpecCheckResult,
} from './types'

/** 单次子进程输出上限(防止病态 spec 把 stderr 灌爆内存) */
const MAX_CAPTURE = 200 * 1024

interface RunOutput {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
}

/** 引擎根:env NATIVE_ENGINE_DIR 优先,否则相对 cwd 的 ../pptx/native */
function resolveRoot(): string {
  const configured = (process.env.NATIVE_ENGINE_DIR || '').trim()
  return resolve(process.cwd(), configured || join('..', 'pptx', 'native'))
}

function cliPath(root: string): string {
  return join(root, 'cli.js')
}

/** 引擎根(不存在就抛出带路径的清晰错误,调用方不需要再猜) */
export function engineRoot(): string {
  const root = resolveRoot()
  const cli = cliPath(root)
  if (!existsSync(root)) {
    throw new Error(`原生引擎目录不存在:${root}(用 NATIVE_ENGINE_DIR 指向 pptx/native)`)
  }
  if (!existsSync(cli)) {
    throw new Error(`原生引擎缺少 cli.js:${cli}(NATIVE_ENGINE_DIR 指到了错误的目录?)`)
  }
  return root
}

function appendCapture(current: string, chunk: string): string {
  if (current.length >= MAX_CAPTURE) return current
  const next = current + chunk
  return next.length > MAX_CAPTURE ? next.slice(0, MAX_CAPTURE) + '\n…(输出已截断)' : next
}

/** spawn 一次 cli.js:cwd 固定为引擎根(引擎按 root 解析自己的 node_modules) */
/**
 * 引擎子进程并发闸。
 *
 * 每次构建都是一个吃满单核的 node 进程;不限并发时,3 个任务同时进来就是 3 个进程
 * 抢 2 个核 —— 三个都变慢,还可能一起撞上构建超时,于是**全部**失败、全部退款。
 * 排队比并发正确:`NATIVE_BUILD_CONCURRENCY` 默认 1(2 核 2G 的生产机就是这个值)。
 *
 * 闸门只管引擎进程,不管别的事;拿不到闸门的调用方只是等待,不会被拒绝。
 */
export function engineConcurrency(): number {
  const raw = Number(process.env.NATIVE_BUILD_CONCURRENCY)
  if (!Number.isFinite(raw) || raw < 1) return 1
  return Math.min(8, Math.floor(raw))
}

let engineActive = 0
const engineQueue: Array<() => void> = []

function acquireEngineSlot(): Promise<() => void> {
  const limit = engineConcurrency()
  return new Promise<() => void>((resolveSlot) => {
    const grant = () => {
      engineActive++
      let released = false
      resolveSlot(() => {
        if (released) return
        released = true
        engineActive--
        const next = engineQueue.shift()
        if (next) next()
      })
    }
    if (engineActive < limit) grant()
    else engineQueue.push(grant)
  })
}

/** 当前排队/占用情况(诊断用:doctor 与日志会读它) */
export function engineConcurrencyState(): { active: number; waiting: number; limit: number } {
  return { active: engineActive, waiting: engineQueue.length, limit: engineConcurrency() }
}

function runCli(root: string, args: string[], timeoutMs: number): Promise<RunOutput> {
  return acquireEngineSlot().then((release) => runCliUnlocked(root, args, timeoutMs).finally(release))
}

function runCliUnlocked(root: string, args: string[], timeoutMs: number): Promise<RunOutput> {
  return new Promise<RunOutput>((done) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ code, stdout, stderr, timedOut, spawnError })
    }
    const child = spawn(process.execPath, [cliPath(root), ...args], {
      cwd: root,
      stdio: 'pipe',
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendCapture(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendCapture(stderr, chunk)
    })
    child.on('error', (e: Error) => finish(null, `${e.name}: ${e.message}`))
    // 超时后 kill 会以 null code + signal 收尾;统一在 close 里判断,避免双 resolve
    child.on('close', (code: number | null) => finish(code))
  })
}

/** stdout 是一行 JSON;容忍前后噪音,取最后一条能解析的 */
function parseJsonLine(text: string): Record<string, unknown> | null {
  const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      /* 继续找上一行 */
    }
  }
  return null
}

/**
 * 从 stderr 提取错误数组。引擎首行是 `spec rejected (N error(s)): <path>`,
 * 其后每条以 `  - ` 开头;若一条都没匹配上,就把 stderr 原文整段当错误返回 —— 不吞。
 */
function extractErrors(run: RunOutput): string[] {
  const stderr = (run.stderr || '').trim()
  if (run.spawnError) return [`引擎子进程启动失败:${run.spawnError}`]
  if (run.timedOut) return [`引擎超时被终止(${Math.round(ENGINE_CHECK_TIMEOUT_MS / 1000)}s):${stderr || '无输出'}`]
  const errors = stderr
    .split('\n')
    .map((line) => line.match(/^\s*-\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => m[1].trim())
  if (errors.length) return errors
  if (stderr) return [stderr]
  return [`引擎退出码 ${run.code},且没有任何输出`]
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function writeSpecFile(dir: string, spec: unknown): string {
  const file = join(dir, 'spec.json')
  writeFileSync(file, JSON.stringify(spec), 'utf-8')
  return file
}

/** 每次调用独占一个临时目录(名字带 pid+时间戳,并发任务不互踩),结束即删 */
function withTempDir(sync: (dir: string) => Promise<unknown>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `deck-${process.pid}-${Date.now()}-`))
  return Promise.resolve()
    .then(() => sync(dir))
    .then(() => undefined)
    .finally(() => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 临时目录清不掉不阻断交付 */
      }
    })
}

/** 把引擎 `--layout-out` 的叶子元素裁到预览白名单(容器已由引擎展开) */
function toPreviewElements(raw: unknown): PreviewElement[] {
  if (!Array.isArray(raw)) return []
  const out: PreviewElement[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const type = typeof e.type === 'string' ? e.type : ''
    // container 在 layoutSlide 之后不该存在;真出现就跳过,免得预览画出空盒子
    if (!type || type === 'container') continue
    const num = (v: unknown, fallback = 0): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback
    const el: PreviewElement = {
      type,
      x: num(e.x),
      y: num(e.y),
      w: num(e.w),
      h: num(e.h),
    }
    if (typeof e._renderText === 'string') el.text = e._renderText
    else if (typeof e.text === 'string') el.text = e.text
    if (typeof e.fontSize === 'number') el.fontSize = e.fontSize
    if (typeof e.fontFace === 'string') el.fontFace = e.fontFace
    if (e.bold === true) el.bold = true
    if (e.italic === true) el.italic = true
    if (typeof e.color === 'string') el.color = e.color
    if (typeof e.align === 'string') el.align = e.align
    if (typeof e.valign === 'string') el.valign = e.valign
    if (typeof e.fill === 'string') el.fill = e.fill
    else if (e.fill === false) el.fill = null
    if (typeof e.lineColor === 'string') el.lineColor = e.lineColor
    if (typeof e.lineWidth === 'number') el.lineWidth = e.lineWidth
    if (typeof e.radius === 'number') el.radius = e.radius
    if (typeof e.rotate === 'number') el.rotate = e.rotate
    if (e.gradient && typeof e.gradient === 'object') {
      const g = e.gradient as { angle?: number; stops?: Array<{ color?: unknown; position?: unknown }> }
      el.gradient = {
        angle: typeof g.angle === 'number' ? g.angle : undefined,
        stops: (g.stops || [])
          .map((s) => ({ color: String(s?.color ?? ''), position: Number(s?.position ?? 0) }))
          .filter((s) => !!s.color),
      }
    }
    if (type === 'table' && Array.isArray(e.rows)) {
      el.rows = (e.rows as unknown[][]).map((row) =>
        (Array.isArray(row) ? row : []).map((cell) => {
          if (typeof cell === 'string') return cell
          if (cell && typeof cell === 'object' && typeof (cell as { text?: unknown }).text === 'string') {
            return (cell as { text: string }).text
          }
          return ''
        }),
      )
    }
    if (type === 'chart') {
      if (typeof e.chartType === 'string') el.chartType = e.chartType
      if (Array.isArray(e.data)) {
        el.data = (e.data as Array<Record<string, unknown>>).map((series) => ({
          name: typeof series?.name === 'string' ? series.name : undefined,
          labels: Array.isArray(series?.labels) ? series.labels : [],
          values: Array.isArray(series?.values) ? (series.values as number[]) : [],
        }))
      }
      const options = e.options as { chartColors?: unknown } | undefined
      if (Array.isArray(options?.chartColors)) el.chartColors = options.chartColors.map(String)
    }
    // 图片路径是本机绝对路径,浏览器拿不到;只告诉预览"这里有一张图"
    if (type === 'image') el.hasImage = true
    out.push(el)
  }
  return out
}

function toPreviewLayout(raw: Record<string, unknown> | null): PreviewSlide[] | undefined {
  if (!raw || !Array.isArray(raw.slides)) return undefined
  return (raw.slides as Array<Record<string, unknown>>).map((slide) => ({
    elements: toPreviewElements(slide?.elements),
  }))
}

/**
 * schema 校验(不落盘)。
 * ok=true ⇒ 引擎 schema 层接受;ok=false ⇒ errors 是引擎逐条错误原文。
 */
export async function checkSpec(spec: unknown): Promise<SpecCheckResult> {
  const root = engineRoot()
  let result: SpecCheckResult = { ok: false, errors: ['校验未执行'] }
  await withTempDir(async (dir) => {
    writeSpecFile(dir, spec)
    const run = await runCli(root, [join(dir, 'spec.json'), '--check', '--json'], ENGINE_CHECK_TIMEOUT_MS)
    const json = parseJsonLine(run.stdout)
    if (run.code === 0 && json && json.ok === true) {
      result = {
        ok: true,
        errors: [],
        slides: typeof json.slides === 'number' ? json.slides : undefined,
      }
      return
    }
    result = { ok: false, errors: extractErrors(run) }
  })
  return result
}

/**
 * 构建 .pptx。
 *
 * `ok` = 产物真的落盘了且引擎自报 ok(见文件头契约:--strict 有警告时仍会写文件)。
 * warnings / warningsByCode / warningDetails 原样带回,由调用方决定重写还是照常交付。
 */
export async function buildPptx(spec: unknown, outPath: string): Promise<NativeBuildResult> {
  const root = engineRoot()
  // 引擎子进程的 cwd 是引擎根,相对 outPath 会被它写到引擎目录下(实测:
  // ENOENT ...\pptx\native\data\generated\...)。所以这里一律先转绝对路径。
  const absoluteOut = resolve(outPath)
  let result: NativeBuildResult = {
    ok: false,
    warnings: 0,
    bytes: 0,
    objects: {},
    report: '{}',
    error: '构建未执行',
  }
  await withTempDir(async (dir) => {
    const specFile = writeSpecFile(dir, spec)
    const reportFile = join(dir, 'report.json')
    const layoutFile = join(dir, 'layout.json')
    const startedAt = Date.now()
    const run = await runCli(
      root,
      [specFile, absoluteOut, '--strict', '--json', '--report', reportFile, '--layout-out', layoutFile],
      ENGINE_BUILD_TIMEOUT_MS,
    )
    const ms = Date.now() - startedAt
    const json = parseJsonLine(run.stdout)
    const reportJson = readJsonFile(reportFile)
    const layoutJson = readJsonFile(layoutFile)
    const exists = existsSync(absoluteOut)
    const bytes = exists ? statSync(absoluteOut).size : 0
    const objects =
      json && json.objects && typeof json.objects === 'object'
        ? (json.objects as Record<string, number>)
        : ((reportJson?.objects as Record<string, number>) ?? {})
    const warningsByCode =
      json && json.warningsByCode && typeof json.warningsByCode === 'object'
        ? (json.warningsByCode as Record<string, number>)
        : {}
    const warningDetails = Array.isArray(reportJson?.warnings)
      ? (reportJson.warnings as Array<Record<string, unknown>>).map((w) => ({
          slide: typeof w.slide === 'number' ? w.slide : null,
          code: typeof w.code === 'string' ? w.code : 'OTHER',
          message: typeof w.message === 'string' ? w.message : String(w.message ?? ''),
        }))
      : []
    const warnings =
      typeof json?.warnings === 'number' ? json.warnings : warningDetails.length
    const pageSize = json?.pageSize as { width?: number; height?: number } | undefined
    const normalisedPageSize = pageSize && typeof pageSize.width === 'number' && typeof pageSize.height === 'number'
      ? { width: pageSize.width, height: pageSize.height }
      : undefined
    // Lead 实测契约:文件落盘 + stdout.ok===true ⇒ 交付成功(exit 1 可能只是 warnings)
    const delivered = exists && bytes > 0 && json?.ok === true
    let error: string | undefined
    if (!delivered) {
      if (run.timedOut) {
        error = `引擎构建超时(${Math.round(ENGINE_BUILD_TIMEOUT_MS / 1000)}s),已终止子进程;stderr:${(run.stderr || '').trim() || '无'}`
      } else if (!json) {
        error = `引擎未产出 JSON(stdout 为空;stderr 原文:${(run.stderr || '').trim() || '无'})`
      } else if (json.ok !== true) {
        error = `引擎拒绝了这份 spec:${extractErrors(run).join(' | ')}`
      } else {
        error = `引擎报告 ok 但没有落盘文件:${absoluteOut}(stderr:${(run.stderr || '').trim() || '无'})`
      }
    }
    const report = JSON.stringify({
      ok: delivered,
      exitCode: run.code,
      timedOut: run.timedOut,
      ms,
      engine: root,
      slides: typeof json?.slides === 'number' ? json.slides : undefined,
      pageSize: normalisedPageSize,
      objects,
      warnings,
      warningsByCode,
      warningDetails,
      fonts: json?.fonts ?? reportJson?.fonts ?? null,
      bytes,
      stdout: json,
      stderr: (run.stderr || '').trim(),
      spawnError: run.spawnError,
    })
    result = {
      ok: delivered,
      warnings,
      bytes,
      objects,
      report,
      slides: typeof json?.slides === 'number' ? json.slides : undefined,
      warningsByCode,
      warningDetails,
      layout: toPreviewLayout(layoutJson),
      pageSize: normalisedPageSize,
      ms,
      error,
    }
  })
  return result
}

/** 探针用的最小合法 deck:能过 schema 就说明 index/schema/依赖全部可加载 */
function minimalProbeDeck(): Record<string, unknown> {
  return {
    title: 'engine doctor probe',
    language: 'zh-CN',
    pageSize: 'wide',
    slides: [{ elements: [{ type: 'text', text: 'ok', x: 0.5, y: 0.5, w: 2, h: 0.4 }] }],
  }
}

/**
 * 引擎就绪探测:`--help`(CLI 能起来)+ 最小 spec 的 `--check`
 * (证明 index.js → schema.js → pptxgenjs/fontkit/image-size/jszip 依赖链可加载)
 * + README/package.json 里的版本号。
 */
export async function engineDoctor(): Promise<EngineDoctorResult> {
  const root = resolveRoot()
  const cli = cliPath(root)
  if (!existsSync(root)) {
    return { ok: false, root, message: `引擎目录不存在:${root}(设 NATIVE_ENGINE_DIR 指向 pptx/native)` }
  }
  if (!existsSync(cli)) {
    return { ok: false, root, message: `缺少 cli.js:${cli}` }
  }
  let version: string | undefined
  const pkg = readJsonFile(join(root, 'package.json'))
  if (pkg && typeof pkg.version === 'string') version = pkg.version

  const help = await runCli(root, ['--help'], 15_000)
  if (help.spawnError) {
    return { ok: false, root, version, message: `无法启动 node:${help.spawnError}` }
  }
  if (help.code !== 0 || !/native deck tool/i.test(help.stdout)) {
    return {
      ok: false,
      root,
      version,
      message: `cli.js --help 退出码 ${help.code}:${(help.stderr || help.stdout).trim().slice(0, 400)}`,
    }
  }

  const probe = await checkSpec(minimalProbeDeck())
  if (!probe.ok) {
    return {
      ok: false,
      root,
      version,
      message: `--check 探针失败(引擎或其依赖无法加载):${probe.errors.join(' | ')}`,
    }
  }
  return {
    ok: true,
    root,
    version,
    message: `引擎就绪:cli.js 可执行,--check 探针通过(${probe.slides ?? 1} 页最小 deck)`,
  }
}

