/**
 * scripts/generate-deck.ts — 真正生成一份交付用的 deck(不 mock,不做任何人工改写)
 *
 * 用途:拿真实主题跑一遍完整管线,产物、报告、质量闭环的结论全部由管线自己产出。
 * 这个脚本**只负责触发和打印**,不修改任何页面内容 —— 好与坏都是管线的真实表现。
 *
 *   npx tsx --conditions=react-server scripts/generate-deck.ts "中国新能源汽车出海" 25
 *
 * 参数:主题 [页数=25] [--preset=sage] [--audience=…]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u)
    if (!match) continue
    const [, key, raw] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = raw.trim().replace(/^["']|["']$/gu, '')
  }
}

const ROOT = resolve(import.meta.dirname, '..')
loadDotEnv(join(ROOT, '.env'))

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
const positional = argv.filter((arg) => !arg.startsWith('--'))
const topic = positional[0] || '中国新能源汽车出海'
const slideCount = Math.max(6, Math.min(40, Number(positional[1]) || 25))

async function main(): Promise<void> {
  const { db } = await import('../src/lib/db')
  const { executeNativePipeline } = await import('../src/lib/pipeline')

  const user = await db.user.create({
    data: {
      username: `deck-${Date.now()}`,
      passwordHash: 'not-a-real-account',
      remainingCredits: slideCount + 20,
    },
  })
  const task = await db.generationTask.create({
    data: {
      userId: user.id,
      requestId: `deck-${Date.now()}`,
      topic,
      language: 'zh-CN',
      slideCount,
      status: 'queued',
      // 与 API 入队时的扣费口径一致:入队即按页数记账(少页时管线按比例退)
      creditsUsed: slideCount,
    },
  })
  console.log(`主题「${topic}」 ${slideCount} 页  task=${task.id}`)
  const started = Date.now()
  await executeNativePipeline({
    taskId: task.id,
    userId: user.id,
    topic,
    language: 'zh-CN',
    slideCount,
    preset: flag('preset') || null,
    audience: flag('audience') || null,
  })
  const ms = Date.now() - started

  const after = await db.generationTask.findUnique({
    where: { id: task.id },
    select: {
      status: true, resultFile: true, engineReport: true, qcWarnings: true, outline: true,
      creditsUsed: true, promptTokens: true, completionTokens: true,
      searchCount: true, imageCount: true, repairRounds: true, errorMessage: true,
    },
  })
  const report = JSON.parse(after?.engineReport || '{}')
  const render = report.renderReport || {}
  const outline = JSON.parse(after?.outline || '[]')
  const warnings: Array<{ slide?: number; code: string; message: string }> = JSON.parse(after?.qcWarnings || '[]')

  console.log(`\n=== 结果 ===`)
  console.log(`状态        ${after?.status}${after?.errorMessage ? ` / ${after.errorMessage}` : ''}  耗时 ${Math.round(ms / 1000)}s`)
  console.log(`产物        ${after?.resultFile || '(无)'}`)
  console.log(`页数        ${report.slides ?? '?'}  引擎警告 ${report.warnings ?? '?'}`)
  console.log(`对象        ${JSON.stringify(report.objects || {})}`)
  console.log(`账务        credits=${after?.creditsUsed} tokens=${after?.promptTokens}+${after?.completionTokens} searches=${after?.searchCount} images=${after?.imageCount} repairRounds=${after?.repairRounds}`)
  console.log(`视觉闭环    ${render.reviews ?? 0} 次检查 / ${(render.repairs || []).length} 轮修复 / 停因 ${render.stopped || '-'}`)
  for (const repair of render.repairs || []) {
    console.log(`   第 ${repair.round} 轮 pages=[${repair.pages}] changed=[${repair.changedPages}] `
      + `${repair.rolledBack ? `回滚(${repair.error})` : '采纳'}`)
  }

  console.log(`\n=== 大纲(${outline.length} 页)===`)
  for (const [index, page] of outline.entries()) {
    console.log(` p${String(index + 1).padStart(2)} ${String(page.template).padEnd(11)} ${String(page.title).slice(0, 28)}`)
  }

  console.log(`\n=== 交付时仍未解决的问题(${warnings.length} 条)===`)
  for (const warning of warnings) {
    console.log(` p${warning.slide ?? '?'} [${warning.code}] ${String(warning.message).slice(0, 110)}`)
  }
  if (!warnings.length) console.log(' (无)')

  console.log(`\n清理:DELETE 用户 ${user.id} 即可(产物与任务保留作证据)`)
}

main().catch((error) => {
  console.error('[generate-deck] 失败:', error)
  process.exitCode = 1
})
