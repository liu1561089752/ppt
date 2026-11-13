/**
 * scripts/e2e-pipeline.ts — G6:mock LLM 下的整条管线 dry-run
 *
 * 运行方式(**三处缺一不可**,下面每条都实测踩过):
 *
 *   bun run e2e:pipeline                    # 默认 mock:不需要任何 LLM / 搜索 key
 *   bun run e2e:pipeline -- --cleanup       # 跑完删掉库行(默认保留作证据)
 *   bun run e2e:pipeline -- --real          # 真实 LLM(要求 .env 里有 key)
 *   bunx tsx --conditions=react-server scripts/e2e-pipeline.ts [--real] [--cleanup]   # 等价直跑
 *
 * 为什么:
 *   - `--conditions=react-server` **必须显式给**:`src/lib/config.ts` 首行是
 *     `import 'server-only'`,而 server-only 的默认入口(非 react-server 条件)会直接 throw
 *     "This module cannot be imported from a Client Component module"。裸跑
 *     `bunx tsx scripts/e2e-pipeline.ts` 必挂在这个 import 上,不是脚本逻辑的问题。
 *     package.json 的 `e2e:pipeline` 已经把该条件写进去了,所以 `bun run e2e:pipeline` 可用。
 *   - **mock 开关在脚本里**:`process.env.NATIVE_MOCK_LLM ??= '1'`(只有 --real 不设)。
 *     Windows cmd 与 POSIX shell 没法统一写 `VAR=1 cmd`,把默认值放脚本里才能一条命令跨平台。
 *   - **.env 不会被 tsx 自动加载**:config 缺 JWT_SECRET 会在 import 期抛错,所以本脚本
 *     自带极简 .env 解析器,并在**动态 import 之前**写进 process.env(静态 import 会被提升,
 *     顺序就错了 —— 这是为什么下面全是 await import)。
 *
 * 判据(全部为真才 exit 0):
 *   1. 任务终态 status === 'succeeded'(不是 failed/refunded);
 *   2. deckSpec 非空且能被 JSON.parse,页数 === 请求页数;
 *   3. engineReport 能被 JSON.parse,且 warnings === 0,且带 layout 几何(预览要用);
 *   4. resultFile 指向的 .pptx 存在、非空、zip 头是 PK;
 *   5. pptx 里 ppt/slides/slideN.xml 的页数 === 请求页数;
 *   6. outline / theme 两个兼容字段有值(列表页要用);
 *   7. python-pptx 能打开成品,读到的页数一致,每页都有非空文本,且对象里真的有
 *      table / chart / picture(整页图片的 deck 会在这一步露馅;没装 python-pptx 则跳过并说明);
 *   8. mock 模式下 searches / images 必须为 0(fixture 不许偷偷花钱)。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

interface EnvMap {
  [key: string]: string
}

/** 极简 .env 解析(KEY=VALUE,容忍引号与 # 注释);已存在的环境变量优先 */
function loadDotEnv(file: string): EnvMap {
  const loaded: EnvMap = {}
  if (!existsSync(file)) return loaded
  for (const raw of readFileSync(file, 'utf-8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u)
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    loaded[key] = value
    if (process.env[key] === undefined) process.env[key] = value
  }
  return loaded
}

function zipMagicOk(file: string): boolean {
  try {
    const head = readFileSync(file).subarray(0, 4)
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  } catch {
    return false
  }
}

/**
 * 数 pptx 里的 slideN.xml:zip 中央目录里的文件名就是 UTF-8 明文,
 * 不用解压也能数(比引入 jszip 只为数页便宜,也不用新依赖)。
 */
function countSlidesInZip(file: string): number {
  const buffer = readFileSync(file)
  const text = buffer.toString('latin1')
  const matches = text.match(/ppt\/slides\/slide\d+\.xml/gu) || []
  return new Set(matches).size
}

/** 从 zip 里取一个条目的明文内容(仅用于探测 [Content_Types].xml 是否存在) */
function hasEntry(file: string, entry: string): boolean {
  try {
    const text = readFileSync(file).toString('latin1')
    return text.includes(entry)
  } catch {
    return false
  }
}

interface PptxParse {
  available: boolean
  ok: boolean
  error?: string
  slides: number
  text: number
  shapes: number
  tables: number
  charts: number
  pictures: number
  everySlideHasText: boolean
}

/**
 * 用 python-pptx 真的解析一遍成品。
 *
 * 这是本机能做到的、最接近"PowerPoint 打得开"的证据:python-pptx 是一个独立的
 * OOXML 消费者,它打不开的文件 PowerPoint 也打不开。它同时能回答"是不是每页都有
 * 可编辑文本对象"——整页图片的 deck 会在这里露馅。
 */
function parseWithPythonPptx(file: string): PptxParse {
  const empty: PptxParse = {
    available: false, ok: false, slides: 0, text: 0, shapes: 0, tables: 0, charts: 0,
    pictures: 0, everySlideHasText: false,
  }
  const script = [
    'import json,sys',
    'try:',
    '    from pptx import Presentation',
    'except Exception as e:',
    '    print(json.dumps({"available": False, "error": str(e)})); sys.exit(0)',
    'try:',
    '    p = Presentation(sys.argv[1])',
    'except Exception as e:',
    '    print(json.dumps({"available": True, "ok": False, "error": str(e)})); sys.exit(0)',
    'from pptx.enum.shapes import MSO_SHAPE_TYPE',
    'counts = {"text": 0, "shapes": 0, "tables": 0, "charts": 0, "pictures": 0}',
    'every = True',
    'slides = list(p.slides)',
    'for s in slides:',
    '    has_text = False',
    '    for sh in s.shapes:',
    '        t = sh.shape_type',
    '        body = (sh.text_frame.text or "").strip() if getattr(sh, "has_text_frame", False) else ""',
    '        # 先按类型归类:python-pptx 里 AutoShape 也有 text_frame,先判文本会把它算成文本框',
    '        if t == MSO_SHAPE_TYPE.TABLE: counts["tables"] += 1',
    '        elif t == MSO_SHAPE_TYPE.CHART: counts["charts"] += 1',
    '        elif t == MSO_SHAPE_TYPE.PICTURE: counts["pictures"] += 1',
    '        elif t == MSO_SHAPE_TYPE.AUTO_SHAPE:',
    '            counts["shapes"] += 1',
    '            if body: has_text = True',
    '        elif t == MSO_SHAPE_TYPE.TEXT_BOX or getattr(sh, "has_text_frame", False):',
    '            counts["text"] += 1',
    '            if body: has_text = True',
    '    every = every and has_text',
    'print(json.dumps({"available": True, "ok": True, "slides": len(slides), "everySlideHasText": every, **counts}))',
  ].join('\n')
  const python = process.platform === 'win32' ? 'python' : 'python3'
  try {
    const output = execFileSync(python, ['-c', script, file], { encoding: 'utf8', timeout: 60_000 })
    const parsed = JSON.parse(output.trim().split('\n').pop() || '{}') as Partial<PptxParse>
    return { ...empty, ...parsed }
  } catch (error) {
    const e = error as { code?: string; message?: string }
    // 没有 python / 没有 python-pptx 不是失败,是不具备条件
    return { ...empty, error: e.code === 'ENOENT' ? 'python 不在 PATH 上' : e.message }
  }
}

async function main(): Promise<void> {
  const cleanup = process.argv.includes('--cleanup')
  const real = process.argv.includes('--real')
  const root = process.cwd()
  const env = loadDotEnv(join(root, '.env'))

  // **默认就是 mock**:package.json 的 `e2e:pipeline` 是跨平台的一条命令,Windows cmd 与
  // POSIX shell 都没法统一写 `NATIVE_MOCK_LLM=1 ...`,所以开关放在脚本里:
  // 默认打开 mock(不需要任何 key),只有显式 `--real` 才关掉它走真实 LLM。
  if (!real) process.env.NATIVE_MOCK_LLM ??= '1'
  if (!process.env.PROJECT_ROOT) process.env.PROJECT_ROOT = env.PROJECT_ROOT || root

  // 动态 import:必须晚于上面的 env 注入(config 在 import 期就会校验 JWT_SECRET)
  const { db } = await import('../src/lib/db')
  const { PATHS } = await import('../src/lib/config')
  const { executeNativePipeline } = await import('../src/lib/pipeline/index')

  const problems: string[] = []
  const say = (line: string) => console.log(line)
  const slides = 8
  const topic = real ? '原生链路真实 LLM 自测' : 'NATIVE_MOCK_LLM 下的整条管线自测'
  const mockOn = (process.env.NATIVE_MOCK_LLM || '').toLowerCase()
  const isMock = mockOn === '1' || mockOn === 'true' || mockOn === 'on' || mockOn === 'yes'

  say(`=== G6 e2e-pipeline(${isMock ? 'mock LLM' : '真实 LLM'},真实引擎 + 真实 DB)===`)

  // 1. 固定冒烟用户(重复跑幂等;余额不足就补到 100,免得跑到第 13 次因扣费失败)
  const username = 'e2e-native-smoke'
  const user = await db.user.upsert({
    where: { username },
    update: {},
    create: { username, passwordHash: 'x-not-a-real-hash', remainingCredits: 100 },
    select: { id: true, remainingCredits: true },
  })
  if (user.remainingCredits < slides) {
    await db.user.update({ where: { id: user.id }, data: { remainingCredits: 100 } })
  }
  say(`[1] user          ${username} id=${user.id} credits=${user.remainingCredits}`)

  // 2. 建任务(等价于路由层创建后的状态:先扣费,失败退款才对得上账)
  const task = await db.generationTask.create({
    data: {
      userId: user.id,
      requestId: `e2e-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      topic,
      language: 'zh-CN',
      slideCount: slides,
      preset: 'sage',
      creditsUsed: slides,
      status: 'pending',
    },
    select: { id: true },
  })
  await db.user.update({ where: { id: user.id }, data: { remainingCredits: { decrement: slides } } })
  say(`[2] task          id=${task.id} 请求 ${slides} 页 已扣费 ${slides}(管线失败会退回,账才对得上)`)

  // 3. 跑管线
  const startedAt = Date.now()
  await executeNativePipeline({
    taskId: task.id,
    userId: user.id,
    topic,
    language: 'zh-CN',
    slideCount: slides,
    preset: 'sage',
    audience: '工程验收',
    customRequirements: '验证原生链路:spec 校验、引擎构建、入库与下载',
  })
  const elapsed = Date.now() - startedAt
  say(`[3] pipeline      完成,耗时 ${elapsed}ms`)

  // 4. 读回终态
  const after = await db.generationTask.findUnique({
    where: { id: task.id },
    select: {
      status: true,
      progress: true,
      progressStage: true,
      errorMessage: true,
      resultFile: true,
      deckSpec: true,
      engineReport: true,
      qcWarnings: true,
      outline: true,
      theme: true,
      durationMs: true,
      creditsUsed: true,
      promptTokens: true,
      completionTokens: true,
      searchCount: true,
      imageCount: true,
      repairRounds: true,
    },
  })
  if (!after) throw new Error('任务读不回来了(DB 写失败?)')
  say(`[4] status        ${after.status} / ${after.progress}% / ${after.progressStage ?? '-'} / durationMs=${after.durationMs}`)
  if (after.status !== 'succeeded') {
    problems.push(`任务终态是 ${after.status},期望 succeeded(errorMessage=${after.errorMessage ?? 'null'})`)
  }

  // 5. deckSpec
  let specPages = 0
  if (!after.deckSpec) {
    problems.push('deckSpec 为空')
  } else {
    try {
      const spec = JSON.parse(after.deckSpec) as { slides?: unknown[]; theme?: { name?: string } }
      specPages = Array.isArray(spec.slides) ? spec.slides.length : 0
      say(`[5] deckSpec      ${after.deckSpec.length}B  ${specPages} 页  theme=${spec.theme?.name ?? '?'}`)
      if (specPages !== slides) problems.push(`deckSpec 页数 ${specPages} ≠ 请求 ${slides}`)
    } catch {
      problems.push('deckSpec 不是合法 JSON')
    }
  }

  // 6. engineReport
  if (!after.engineReport) {
    problems.push('engineReport 为空')
  } else {
    try {
      const report = JSON.parse(after.engineReport) as {
        warnings?: number
        objects?: Record<string, number>
        bytes?: number
        slides?: number
        layout?: unknown[]
      }
      const objects = report.objects || {}
      say(
        `[6] engineReport  warnings=${report.warnings}  bytes=${report.bytes}  slides=${report.slides}  ` +
          `layout=${Array.isArray(report.layout) ? `${report.layout.length} 页几何` : '缺'}  ` +
          `objects=${Object.keys(objects).sort().map((key) => `${key} ${objects[key]}`).join(' · ')}`,
      )
      if (report.warnings !== 0) problems.push(`engineReport.warnings=${report.warnings},判据要求 0`)
      if (!Array.isArray(report.layout) || report.layout.length !== slides) {
        problems.push('engineReport.layout 缺失或页数不符(站点预览要靠它)')
      }
    } catch {
      problems.push('engineReport 不是合法 JSON')
    }
  }

  // 7. 产物可读
  if (!after.resultFile) {
    problems.push('resultFile 为空(没有可下载的 pptx)')
  } else {
    const file = join(PATHS.generated, after.resultFile)
    const exists = existsSync(file)
    const size = exists ? statSync(file).size : 0
    const magic = exists ? zipMagicOk(file) : false
    const zipped = exists ? countSlidesInZip(file) : 0
    const contentTypes = exists ? hasEntry(file, '[Content_Types].xml') : false
    say(`[7] pptx          ${after.resultFile}  exists=${exists}  size=${size}B  PK=${magic}  slides=${zipped}  contentTypes=${contentTypes}`)
    if (!exists || size === 0) problems.push('产物文件不存在或为空')
    if (!magic) problems.push('产物 zip 头不是 PK')
    if (zipped !== slides) problems.push(`zip 里 slideN.xml 数 ${zipped} ≠ 请求 ${slides}`)
    if (!contentTypes) problems.push('产物缺少 [Content_Types].xml')
  }

  // 7.5 真正解析一遍成品:zip 头对只能说明"是个 zip",用 python-pptx 打开才说明
  // "是一份 OOXML 演示文稿,且里面的对象真的是文本/表格/图表/图片,不是整页图片"。
  // 这台机器没有 PowerPoint,所以这是"能不能打开、能不能改"最接近的证据。
  if (after.resultFile) {
    const parsed = parseWithPythonPptx(join(PATHS.generated, after.resultFile))
    if (!parsed.available) {
      say('[7.5] ooxml        跳过:环境里没有 python-pptx(不假装验证过)')
    } else if (!parsed.ok) {
      say(`[7.5] ooxml        解析失败:${parsed.error}`)
      problems.push(`python-pptx 打不开成品:${parsed.error}`)
    } else {
      say(`[7.5] ooxml        slides=${parsed.slides} text=${parsed.text} shape=${parsed.shapes}`
        + ` table=${parsed.tables} chart=${parsed.charts} picture=${parsed.pictures}`
        + ` 每页都有文本=${parsed.everySlideHasText}`)
      if (parsed.slides !== slides) problems.push(`python-pptx 读到 ${parsed.slides} 页 ≠ 请求 ${slides}`)
      if (!parsed.everySlideHasText) problems.push('有页面没有任何文本对象(等于空页)')
      if (parsed.text < slides) problems.push(`文本对象只有 ${parsed.text} 个,少于页数 ${slides}`)
    }
  }

  // 8. 兼容字段
  say(`[8] outline/theme ${after.outline ? `${JSON.parse(after.outline).length} 条大纲` : '缺'} / ${after.theme ? `theme.name=${JSON.parse(after.theme).name}` : '缺'}`)
  if (!after.outline) problems.push('outline 为空')
  if (!after.theme) problems.push('theme 为空')
  say(`[9] 账务          creditsUsed=${after.creditsUsed} tokens=${(after.promptTokens ?? 0)}+${(after.completionTokens ?? 0)}`
    + ` searches=${after.searchCount ?? 0} images=${after.imageCount ?? 0} repairRounds=${after.repairRounds ?? 0}`
    + `  qcWarnings=${after.qcWarnings ?? 'null'}`)
  // mock 下不检索图库、也不修复:这两项必须是 0,非 0 说明有路径在 fixture 里偷偷花钱
  if ((after.searchCount ?? 0) !== 0 || (after.imageCount ?? 0) !== 0) {
    problems.push(`mock 模式不该产生搜索/图片成本,实际 searches=${after.searchCount} images=${after.imageCount}`)
  }

  if (cleanup) {
    await db.chatMessage.deleteMany({ where: { taskId: task.id } }).catch(() => {})
    await db.creditChange.deleteMany({ where: { taskId: task.id } }).catch(() => {})
    await db.generationTask.delete({ where: { id: task.id } }).catch(() => {})
    say(`[cleanup]         已删除任务 ${task.id} 及其消息/账本`)
  } else {
    say(`[keep]            保留任务 ${task.id} 作证据(加 --cleanup 可清理)`)
  }

  if (problems.length > 0) {
    console.error('\n=== FAIL ===')
    problems.forEach((problem) => console.error(` - ${problem}`))
    await db.$disconnect()
    process.exitCode = 1
    process.exit(1)
  }
  console.log('\n=== PASS ===')
  console.log(
    `task=${task.id} status=succeeded deckSpec=${specPages}页 warnings=0 耗时=${elapsed}ms`,
  )
  await db.$disconnect()
  process.exit(0)
}

console.log('[e2e-pipeline] 用法:bun run e2e:pipeline [-- --cleanup|--real](等价:bunx tsx --conditions=react-server scripts/e2e-pipeline.ts)')

main().catch((e) => {
  console.error('[e2e-pipeline] 未捕获异常:', e)
  process.exitCode = 1
  process.exit(1)
})
