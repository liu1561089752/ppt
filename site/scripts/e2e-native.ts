/**
 * scripts/e2e-native.ts — G5:Deck Spec → 原生 .pptx 的端到端判据(全程不经过 LLM)
 *
 *   bunx tsx scripts/e2e-native.ts [--out <file.pptx>] [--slides 10] [--no-python]
 *
 * 判据(全部为真才 exit 0):
 *   1. engineDoctor 通过(--help + 最小 spec 的 --check);
 *   2. buildPptx 成功:文件落盘、stdout.ok、且 **--strict 的 warnings 为 0**;
 *   3. 产物 zip 头是 PK、体积 > 0;
 *   4. 对象普查里 text / shape / chart / table / image 各至少一个(证明没有整页截图);
 *   5. 可选:引擎自带的 verify_native_ooxml.py 报 integrity_problems=0(没装 python 就跳过并说明)。
 *
 * 用法要点:spec 来自 pipeline/mock.ts 的确定性 fixture(≥8 页、≥4 种页面原型),
 * 所以这个判据与 LLM 无关,可以进 CI。
 */
import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { buildPptx, engineDoctor } from '../src/lib/pipeline/native'
import { mockDeckSpec, mockOutline } from '../src/lib/pipeline/mock'

interface Args {
  out: string
  slides: number
  python: boolean
}

function parseArgs(argv: string[]): Args {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const args: Args = { out: join(tmpdir(), `e2e-native-${stamp}.pptx`), slides: 10, python: true }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--out') args.out = resolve(argv[++index] || args.out)
    else if (arg === '--slides') args.slides = Math.max(2, Math.min(25, Number(argv[++index]) || 10))
    else if (arg === '--no-python') args.python = false
  }
  return args
}

/** zip 魔数:PK\x03\x04 */
function zipMagicOk(file: string): boolean {
  try {
    const head = readFileSync(file).subarray(0, 4)
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  } catch {
    return false
  }
}

/** 引擎自带的 OOXML 完整性探针(需要 python;没装就跳过) */
function runPythonVerifier(script: string, deck: string): Promise<{ ran: boolean; output: string; ok: boolean }> {
  return new Promise((done) => {
    const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']
    const tryNext = (index: number) => {
      if (index >= candidates.length) {
        done({ ran: false, output: '未找到 python,跳过 OOXML 深度校验', ok: false })
        return
      }
      const child = spawn(candidates[index], [script, deck], { stdio: 'pipe', windowsHide: true })
      let out = ''
      let err = ''
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
      child.on('error', () => tryNext(index + 1))
      child.on('close', (code) => {
        const text = `${out}${err}`.trim()
        if (code === 127 || /No such file|not recognized|不是内部或外部命令/u.test(text)) {
          tryNext(index + 1)
          return
        }
        const problems = Number((text.match(/integrity_problems["'\s:]+(\d+)/u) || [])[1] ?? NaN)
        done({ ran: true, output: text, ok: code === 0 && (Number.isNaN(problems) || problems === 0) })
      })
    }
    tryNext(0)
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const problems: string[] = []
  const say = (line: string) => console.log(line)

  say('=== G5 e2e-native:Deck Spec → 原生 pptx ===')

  // 1. 引擎就绪
  const doctor = await engineDoctor()
  say(`[1] engineDoctor  ok=${doctor.ok}  root=${doctor.root}  version=${doctor.version ?? 'n/a'}`)
  say(`    ${doctor.message}`)
  if (!doctor.ok) problems.push(`engineDoctor 失败:${doctor.message}`)

  // 2. 确定性 fixture(不依赖 LLM)
  const input = { topic: '原生 PPTX 引擎端到端自测', language: 'zh-CN', slideCount: args.slides }
  const plan = mockOutline(input)
  const spec = mockDeckSpec(input, plan)
  const archetypes = Array.from(new Set(spec.slides.map((slide) => slide.template || 'unknown')))
  say(`[2] fixture       ${spec.slides.length} 页 / ${archetypes.length} 种原型:${archetypes.join(', ')}`)

  // 3. 构建
  mkdirSync(dirname(args.out), { recursive: true })
  const startedAt = Date.now()
  const built = await buildPptx(spec, args.out)
  const elapsed = Date.now() - startedAt
  say(`[3] buildPptx     ok=${built.ok}  warnings=${built.warnings}  bytes=${built.bytes}  slides=${built.slides ?? '?'}  ${elapsed}ms`)
  say(`    objects: ${Object.keys(built.objects).sort().map((key) => `${key} ${built.objects[key]}`).join(' · ') || '(空)'}`)
  if (built.warningsByCode && Object.keys(built.warningsByCode).length > 0) {
    say(`    warningsByCode: ${JSON.stringify(built.warningsByCode)}`)
  }
  for (const warning of built.warningDetails || []) {
    say(`    [${warning.code}] ${warning.slide ? `slide ${warning.slide}` : 'deck'}: ${warning.message}`)
  }
  say(`    out: ${args.out}`)
  if (!built.ok) problems.push(`buildPptx 失败:${built.error || '未知原因'}`)
  if (built.warnings !== 0) problems.push(`--strict 仍有 ${built.warnings} 条布局警告(判据要求 0)`)

  // 4. 产物本身
  const exists = existsSync(args.out)
  const size = exists ? statSync(args.out).size : 0
  const magic = zipMagicOk(args.out)
  say(`[4] artifact      exists=${exists}  size=${size}B  zipMagic(PK)=${magic}`)
  if (!exists || size === 0) problems.push('产物不存在或为空')
  if (!magic) problems.push('产物不是合法 zip(PK 魔数校验失败)')

  // 5. 对象普查:五类原生对象都要在,证明不是整页图片
  const required = ['text', 'shape', 'chart', 'table', 'image']
  const missing = required.filter((type) => !(built.objects?.[type] > 0))
  say(`[5] census        ${missing.length === 0 ? '五类原生对象齐全' : `缺:${missing.join(', ')}`}`)
  if (missing.length > 0) problems.push(`对象普查缺:${missing.join(', ')}`)

  // 6. 可选:引擎自带的 OOXML 完整性校验
  if (args.python) {
    const engineBase = resolve(doctor.root, '..', '..', 'pptx')
    const candidates = [
      join(doctor.root, 'scripts', 'verify_native_ooxml.py'),
      join(engineBase, 'scripts', 'verify_native_ooxml.py'),
    ]
    const script = candidates.find((candidate) => existsSync(candidate))
    if (!script) {
      say('[6] ooxml        跳过:引擎里没找到 verify_native_ooxml.py')
    } else {
      const result = await runPythonVerifier(script, args.out)
      const firstLine = result.output.split('\n').filter(Boolean).slice(-4).join(' | ')
      say(`[6] ooxml        ran=${result.ran} ok=${result.ok}`)
      say(`    ${firstLine || '(无输出)'}`)
      if (result.ran && !result.ok) problems.push(`verify_native_ooxml.py 未通过:${firstLine}`)
    }
  }

  if (problems.length > 0) {
    console.error('\n=== FAIL ===')
    problems.forEach((problem) => console.error(` - ${problem}`))
    process.exitCode = 1
    return
  }
  console.log('\n=== PASS ===')
  console.log(
    `warnings=0 bytes=${size} slides=${built.slides ?? spec.slides.length} objects=` +
      `${Object.values(built.objects).reduce((sum, count) => sum + count, 0)} 耗时=${elapsed}ms`,
  )
}

main().catch((e) => {
  console.error('[e2e-native] 未捕获异常:', e)
  process.exitCode = 1
})
