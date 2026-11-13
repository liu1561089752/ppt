/**
 * scripts/live-research.ts — 用真 key 跑「检索 + 逐页配图」这两段,不碰 LLM
 *
 * 现在能真跑的是 S2(博查检索)与 S3.5(Unsplash 逐页配图 + 下载);
 * S3 大纲 / S4 规格必须走 LLM,没有 key 就跑不了,脚本会如实说明,不会假装成功。
 *
 * 做法:直接在库里建一个临时任务(真实 taskId,事件/记账都写进真表),调**生产代码**
 * stage2Research + enrichResearchForPlan,再把结果拼成一份最小 Deck Spec 交给引擎
 * `--check`,验证图片与署名能真的进规格。最后清理这个临时任务。
 *
 *   npx tsx --conditions=react-server scripts/live-research.ts "低空经济"
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
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

const topic = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || '低空经济 产业政策'

async function main(): Promise<void> {
  const { db } = await import('../src/lib/db')
  const { stage2Research, enrichResearchForPlan } = await import('../src/lib/pipeline/research')
  const { checkSpec } = await import('../src/lib/pipeline/native')
  const { engineRoot } = await import('../src/lib/pipeline/native')
  const { themeFor } = await import('../src/lib/pipeline/theme')

  const engineAvailable = (() => {
    try {
      engineRoot()
      return true
    } catch {
      return false
    }
  })()

  // 自建一个一次性用户:不依赖库里已有数据,也不碰任何真实账户
  const user = await db.user.create({
    data: {
      username: `live-check-${Date.now()}`,
      passwordHash: 'not-a-real-account',
      remainingCredits: 0,
    },
  })
  const task = await db.generationTask.create({
    data: {
      userId: user.id,
      requestId: `live-research-${Date.now()}`,
      topic,
      language: 'zh-CN',
      slideCount: 4,
      status: 'generating',
      startedAt: new Date(),
      creditsUsed: 0,
    },
  })
  console.log(`临时任务 ${task.id}(跑完会删)`)

  const input = {
    taskId: task.id, userId: user.id, topic, language: 'zh-CN', slideCount: 4,
  }
  const report: string[] = []
  const failures: string[] = []

  try {
    // ── S2:真实检索 ──────────────────────────────────────────────────────
    const research = await stage2Research(input as never, task.id)
    console.log(`\n[s2] 资料  正文=${research.facts.length}字节 来源=${research.sources.length}`
      + ` 主题配图=${research.images.length}`)
    const hosts = new Set(research.sources.map((source) => {
      try { return new URL(source.url).host } catch { return '?' }
    }))
    console.log(`[s2] 独立域名 ${hosts.size} 个`)
    if (!research.sources.length) failures.push('S2 没有拿到任何来源')
    if (research.facts.length < 500) failures.push(`S2 正文过短:${research.facts.length} 字节`)

    // 逐条来源的可追溯性:每条都要有 url + 标题
    const untraceable = research.sources.filter((source) => !source.url || !source.title)
    if (untraceable.length) failures.push(`${untraceable.length} 条来源缺 url 或标题`)

    // ── S3.5:真实逐页配图 ────────────────────────────────────────────────
    const plan: { title: string; styleName: string; preset: string; pages: Array<{ title: string; template: string; brief: string; imageQuery?: string; imageId?: string }> } = {
      title: topic,
      styleName: '雾绿',
      preset: 'sage' as const,
      pages: [
        { title: '封面', template: 'cover', brief: '封面:一句话主张' },
        { title: '产业现状', template: 'image', brief: '用一张实景图说明产业现状', imageQuery: `${topic} 产业` },
        { title: '政策脉络', template: 'content', brief: '三条政策脉络' },
        { title: '场景落地', template: 'image', brief: '用一张实景图说明落地场景', imageQuery: `${topic} 应用场景` },
      ],
    }
    const enrich = await enrichResearchForPlan(input as never, task.id, plan as never, research)
    console.log(`\n[s3.5] 逐页配图 检索=${enrich.searched} 页 绑定=${enrich.bound} 页`
      + ` 跳过=${enrich.skipped.length} 配额用尽=${enrich.usedQuota}`)
    for (const binding of enrich.bindings) {
      const file = binding.localPath || ''
      const bytes = file && existsSync(file) ? statSync(file).size : 0
      console.log(`       p${binding.page} ${binding.template} image_id=${binding.imageId}`
        + ` ${bytes}字节 query="${binding.query}"`)
      if (!bytes) failures.push(`p${binding.page} 绑定了图但文件不存在/为空`)
    }
    if (!enrich.bound) failures.push('S3.5 一页配图都没绑定成')

    // 大纲里的 image 页必须被真正绑定(否则成片会被降级成 content)
    for (const [index, page] of plan.pages.entries()) {
      if (page.template !== 'image') continue
      if (!page.imageId) failures.push(`p${index + 1} 是 image 页但没绑定到图`)
    }

    // ── 图片与署名能不能真的进规格并被引擎接受 ──────────────────────────
    const imagePages = plan.pages.filter((page) => page.imageId)
    const usable = imagePages
      .map((page) => research.images.find((image) => image.id === page.imageId))
      .filter((image): image is (typeof research.images)[number] => !!image && !!image.localPath)
    if (usable.length) {
      const theme = themeFor('sage', 'zh-CN')
      const spec = {
        title: topic,
        language: 'zh-CN',
        pageSize: 'wide',
        theme: {
          name: theme.name,
          colors: { ...theme.colors },
          fonts: { ...theme.fonts },
        },
        slides: [
          {
            template: 'image',
            background: theme.colors.background,
            elements: [
              { type: 'text', role: 'title', text: '配图页', fontSize: 26 },
              {
                type: 'image',
                path: usable[0].localPath,
                h: 4,
                fit: 'cover',
                altText: usable[0].description || '配图',
                credit: {
                  subject: usable[0].description || '配图',
                  author: usable[0].author,
                  licence: 'Unsplash License',
                },
              },
            ],
          },
        ],
      }
      if (!engineAvailable) {
        console.log('\n[engine] SKIP 引擎不可用,跳过规格校验')
      } else {
        const check = await checkSpec(spec)
        console.log(`\n[engine] 含真实图片与署名的规格 --check => ${check.ok ? 'OK' : 'FAIL'}`)
        if (!check.ok) failures.push(`真实图片进规格后引擎拒收:${check.errors.slice(0, 3).join(' | ')}`)
      }
    }

    // ── 记账是否落库 ─────────────────────────────────────────────────────
    const after = await db.generationTask.findUnique({
      where: { id: task.id },
      select: { searchCount: true, imageCount: true },
    })
    console.log(`\n[账务] searches=${after?.searchCount ?? 0} images=${after?.imageCount ?? 0}`)
    if (!(after?.searchCount ?? 0)) failures.push('检索次数没有落库(searchCount=0)')
    report.push(`searches=${after?.searchCount ?? 0}`)
  } finally {
    // 清理:事件 / 账本 / 任务;产物目录留着当证据
    await db.chatMessage.deleteMany({ where: { taskId: task.id } }).catch(() => {})
    await db.creditChange.deleteMany({ where: { taskId: task.id } }).catch(() => {})
    await db.generationTask.delete({ where: { id: task.id } }).catch(() => {})
    await db.user.delete({ where: { id: user.id } }).catch(() => {})
    console.log(`\n[cleanup] 已删除临时任务 ${task.id}(${report.join(' ')});产物在 site/data/generated/${user.id}/${task.id}/`)
  }

  if (failures.length) {
    console.log(`\n=== FAIL ${failures.length} 项 ===`)
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('\n=== 真实检索 + 逐页配图 PASS ===')
  console.log('注:S3 大纲与 S4 规格需要 LLM key,本脚本没有跑,也不代表它们已通。')
}

main().catch((error) => {
  console.error('[live-research] 未捕获异常:', error)
  process.exitCode = 1
})
