/**
 * scripts/live-check.ts — 真实外部依赖连通性自检(不写库、不动任务、不烧额度)
 *
 * 用途:在配好 key 之后、跑整条管线之前,先确认"外网这几家到底通不通、返回什么形状"。
 * 它只做各一次最小调用:
 *   1. 博查 web-search:1 次检索,报来源数、耗时、首条标题/域名;
 *   2. Unsplash search:1 次检索,报候选数、通过尺寸/比例筛选的张数;
 *   3. 图床下载:挑 1 张候选真下载,报字节数与像素尺寸;
 *   4. LLM:只检查 key 是否存在(不调用,避免在这里花钱)。
 *
 *   npx tsx --conditions=react-server scripts/live-check.ts "低空经济"
 *
 * 不打印任何密钥;缺 key 的项如实标 SKIP(不算通过)。
 */
import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** .env 不会被 tsx 自动加载;config 缺 JWT_SECRET 会在 import 期抛错,所以先自己解析 */
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

const topic = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '低空经济 产业政策'

async function main(): Promise<void> {
  const { webSearchDetailed, hasBochaKey } = await import('../src/lib/search-client')
  const { hasUnsplashKey, searchPhotos } = await import('../src/lib/unsplash-client')
  const { downloadOne, isUsablePhoto, orientationFor } = await import('../src/lib/pipeline/research')

  const failures: string[] = []

  // 1. 博查
  if (!hasBochaKey()) {
    console.log('[1] bocha        SKIP 未配置 BOCHA_API_KEY')
  } else {
    const started = Date.now()
    try {
      const result = await webSearchDetailed(topic)
      const ms = Date.now() - started
      const hosts = new Set(result.sources.map((source) => {
        try { return new URL(source.url).host } catch { return '?' }
      }))
      console.log(`[1] bocha        OK   provider=${result.provider} 文本=${result.text.length}字节`
        + ` 来源=${result.sources.length} 独立域名=${hosts.size} 耗时=${ms}ms`)
      result.sources.slice(0, 3).forEach((source, index) => {
        console.log(`      ${index + 1}. ${source.title.slice(0, 46)}  <${String(source.url).slice(0, 60)}>`)
      })
      if (result.text.trim().length < 200) failures.push(`博查返回正文过短(${result.text.length} 字节)`)
      if (!result.sources.length) failures.push('博查没有返回任何来源')
    } catch (error) {
      console.log(`[1] bocha        FAIL ${(error as Error).message}`)
      failures.push(`博查检索失败:${(error as Error).message}`)
    }
  }

  // 2. Unsplash 检索
  let photo: Awaited<ReturnType<typeof searchPhotos>>[number] | undefined
  if (!hasUnsplashKey()) {
    console.log('[2] unsplash     SKIP 未配置 UNSPLASH_ACCESS_KEY')
  } else {
    const started = Date.now()
    try {
      const found = await searchPhotos(topic.split(/\s+/u)[0], 6, orientationFor({ template: 'image' }))
      const ms = Date.now() - started
      const usable = found.filter(isUsablePhoto)
      console.log(`[2] unsplash     OK   候选=${found.length} 通过尺寸/比例筛选=${usable.length} 耗时=${ms}ms`)
      photo = usable[0] || found[0]
      if (photo) {
        console.log(`      首张: ${String(photo.description || '(无描述)').slice(0, 40)}`
          + ` / ${photo.author || '?'} / ${photo.width}x${photo.height}`)
      }
      if (!found.length) failures.push('Unsplash 没有返回候选图')
      if (found.length && !usable.length) failures.push('候选图全部没通过尺寸/比例筛选(会被成片降级)')
    } catch (error) {
      console.log(`[2] unsplash     FAIL ${(error as Error).message}`)
      failures.push(`Unsplash 检索失败:${(error as Error).message}`)
    }
  }

  // 3. 真下载一张
  if (photo?.url) {
    const dir = join(ROOT, '.work/live-check')
    mkdirSync(dir, { recursive: true })
    const started = Date.now()
    const file = await downloadOne(photo.url, join(dir, `sample-${Date.now()}.jpg`))
    const ms = Date.now() - started
    if (!file) {
      console.log('[3] download     FAIL 下载失败或文件为空')
      failures.push('图床下载失败')
    } else {
      const bytes = statSync(file).size
      // 尺寸用图库 API 声明的值(本站没有图像解码依赖,不为了报一个数字引库)
      console.log(`[3] download     OK   ${bytes}字节 API声明尺寸=${photo.width}x${photo.height} 耗时=${ms}ms`)
      if (bytes < 20_000) failures.push(`下载的图只有 ${bytes} 字节,疑似不是原图`)
    }
  } else {
    console.log('[3] download     SKIP 没有可下载的候选图')
  }

  // 4. LLM:只看有没有 key,不在这里调用
  const llmKeys = ['DEEPSEEK_API_KEY', 'KIMI_API_KEY'].filter((key) => (process.env[key] || '').length > 10)
  console.log(`[4] llm          ${llmKeys.length ? `已配置 ${llmKeys.join(' / ')}(本脚本不调用)` : 'SKIP 未配置任何 LLM key —— 阶段 3/4 无法走真实模型'}`)

  if (failures.length) {
    console.log(`\n=== FAIL ${failures.length} 项 ===`)
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('\n=== 外部依赖连通性 PASS ===')
}

main().catch((error) => {
  console.error('[live-check] 未捕获异常:', error)
  process.exitCode = 1
})
