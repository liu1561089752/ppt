/**
 * pipeline/index.ts — 生成管线编排(原生链路唯一入口)
 *
 * S2 调研 → S3 大纲 → S4 Deck Spec → S5 原生引擎构建 → 交付。
 * 整条链路限时、失败退款;终态守卫贯穿:超时/取消结算后,迟到的阶段写入与成功结果一律丢弃。
 *
 * 与 HTML 时代的差别只在 S4/S5:
 *   旧:S4 并行渲染 HTML 页 → 转换器子进程 → 成品几何修复
 *   新:S4 一份 Deck Spec(引擎 schema 校验,带错误重试)→ 引擎一次构建出可编辑 pptx
 * 账务/守卫/落盘路径全部沿用,没有因为换引擎而放宽任何一条。
 */
import { mkdirSync, readFileSync, rmSync } from 'fs'
import { dirname, resolve } from 'path'
import { db } from '@/lib/db'
import { CONFIG, PATHS } from '@/lib/config'
import { saveGenerated } from '@/lib/file-storage'
import { hasLLMKey, getKimiModel } from '@/lib/kimi-client'
import { emitEvent } from './events'
import { refundTask, settleTaskCredits, FINAL_STATUSES } from './credits'
import { stage2Research, enrichResearchForPlan, trackChosenImages } from './research'
import { stage3Plan } from './plan'
import { stage4Spec, repairSpecWithWarnings } from './spec'
import { sparsePages } from './design'
import { buildPptx, engineRoot } from './native'
import { isMockLLM } from './mock'
import { normalizePreset, themeFor } from './theme'
import {
  BUILD_MAX_REPAIRS,
  DENSITY_MAX_REPAIRS,
  isDensityRepairEnabled,
  type DeckSpecJson,
  type GenerateInput,
  type NativeBuildResult,
  type OutlinePlan,
} from './types'

// 兼容导出:路由层从这里取结算函数与终态列表
export { settleTaskCredits, refundTask }
export { FINAL_STATUSES }

/** 看门狗:整条管线限时执行,超时按失败退款(防止任务永久卡在 generating) */
export async function executeNativePipeline(input: GenerateInput): Promise<void> {
  const timeoutMs = CONFIG.GENERATE.taskTimeoutBaseMs + input.slideCount * CONFIG.GENERATE.taskTimeoutPerSlideMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('PIPELINE_TIMEOUT')), timeoutMs)
    timer.unref?.()
  })
  try {
    await Promise.race([runPipeline(input), timeoutPromise])
  } catch (e) {
    if ((e as Error).message === 'PIPELINE_TIMEOUT') {
      console.error(`[pipeline] 任务 ${input.taskId} 超时(${Math.round(timeoutMs / 1000)}s),强制退款`)
      await emitEvent(input.taskId, 'error', { message: '生成超时,已自动退款' })
      await refundTask(input.taskId, '任务超时,已自动退款')
      return
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runPipeline(input: GenerateInput): Promise<void> {
  const { taskId, userId } = input
  const startedAt = new Date()
  try {
    // 无密钥自测(NATIVE_MOCK_LLM=1)不需要 LLM key;真实模式必须有
    if (!isMockLLM() && !hasLLMKey()) {
      throw new Error('未配置 LLM API Key(DEEPSEEK_API_KEY / KIMI_API_KEY)')
    }
    // 引擎先探一次:引擎不在就早失败,别等到 S5 烧完 LLM 配额才发现
    engineRoot()

    // 状态推进守卫(M-12):任务已被取消/退款(终态)时 count===0,不得继续
    const started = await db.generationTask.updateMany({
      where: { id: taskId, status: { notIn: FINAL_STATUSES } },
      data: {
        status: 'generating',
        startedAt,
        progress: 0,
        progressStage: '开始生成',
        model: isMockLLM() ? 'native-mock-fixture' : getKimiModel(),
        mode: 'native',
      },
    })
    if (started.count === 0) {
      console.warn(`[pipeline] 任务 ${taskId} 已被结算(取消/退款),管线不启动`)
      return
    }

    // S2 调研
    const research = await stage2Research(input, taskId)

    // S3 大纲(只决定讲什么,不产任何样式)
    const plan = await stage3Plan(input, taskId, research)
    // The outline determines which pages truly need imagery; search those scenes individually.
    await enrichResearchForPlan(input, taskId, plan, research)

    // 计划落库守卫(M-12 同族):任务在调研/规划期间被结算则终止,后续规格/构建/落盘全部不再发生
    const planSaved = await db.generationTask.updateMany({
      where: { id: taskId, status: { notIn: FINAL_STATUSES } },
      data: { outline: JSON.stringify(outlineOf(plan)), progress: 35, progressStage: '大纲就绪' },
    })
    if (planSaved.count === 0) {
      console.warn(`[pipeline] 任务 ${taskId} 已被结算(取消/退款),丢弃大纲结果`)
      return
    }

    // Unsplash 合规:对实际进入方案(brief 引用了 URL)的图片触发下载统计
    trackChosenImages(research.images, plan.pages.map((p) => p.brief))

    await emitEvent(taskId, 'answer', {
      text: `大纲已就绪:**${plan.title}**(${plan.styleName},${plan.pages.length} 页)\n\n开始生成原生规格…`,
    })

    // S4 Deck Spec(引擎 schema 校验,带错误重试)+ S5 构建
    const artifact = await stage4Spec(input, taskId, plan, research)
    // 绝对路径:引擎子进程的 cwd 是引擎根,相对路径会被它解析到引擎目录下(实测踩过)
    const outPath = resolve(PATHS.generated, userId, taskId, `${taskId}.pptx`)
    mkdirSync(dirname(outPath), { recursive: true })

    await emitEvent(taskId, 'status', { status: 'generating', stage: '正在构建原生 PPTX…' })
    let built = await buildDeck(artifact.spec, outPath, taskId, 85)

    // 布局警告不阻断交付,但值得再修一次(交给 LLM 带警告原文重写 spec)。
    // 密度补写会改动版面,可能在补完之后又冒出新的越界警告,所以这段要能重复调用。
    const repairLayoutWarnings = async (maxAttempts: number): Promise<void> => {
      for (let attempt = 0; attempt < maxAttempts && built.warnings > 0 && !isMockLLM(); attempt++) {
      const warningLines = (built.warningDetails || []).map(
        (w) => `${w.slide ? `slide ${w.slide}` : 'deck'}: [${w.code}] ${w.message}`,
      )
      if (!warningLines.length) warningLines.push(`${built.warnings} 条布局警告(无明细)`)
      await emitEvent(taskId, 'status', {
        status: 'generating',
        stage: `引擎报 ${built.warnings} 条布局警告,正在按警告重写规格(${attempt + 1}/${BUILD_MAX_REPAIRS})`,
      })
      let repaired: DeckSpecJson
      try {
        repaired = await repairSpecWithWarnings(input, taskId, plan, artifact.spec, warningLines, research)
      } catch (e) {
        console.warn('[pipeline] 警告修复失败,沿用当前规格:', (e as Error).message)
        break
      }
      const rebuilt = await buildDeck(repaired, outPath, taskId, 90)
      if (!rebuilt.ok) {
        // 重建失败(例如重写后的 spec 被引擎拒绝):磁盘上仍是上一份好成品,
        // 不能因为"修复尝试失败"就把已经能交付的 deck 判死。
        console.warn('[pipeline] 警告修复后的重建失败,保留上一份成品:', rebuilt.error)
        break
      }
        artifact.spec = repaired
        // 引擎写的是最新一份文件,报告一律以它为准(旧报告的文件已被覆盖)
        built = rebuilt
        if (built.warnings === 0) break
      }
    }
    await repairLayoutWarnings(BUILD_MAX_REPAIRS)

    // 版面密度:内容塌在页面上半部分的页,再给模型一次"补内容"的机会(不阻断交付)
    const densityRounds = isDensityRepairEnabled() ? DENSITY_MAX_REPAIRS : 0
    for (let attempt = 0; attempt < densityRounds && !isMockLLM(); attempt++) {
      const sparse = sparsePages(built.layout, artifact.spec)
      if (!sparse.length) break
      const lines = sparse.map(
        (p) =>
          `slide ${p.page}: [SPARSE_LAYOUT] 这一页正文只占到页面 ${Math.round(p.fill * 100)}%,底部大片空白。` +
          `请在不改主题/模板体系的前提下把这一页补实:至少 3 个内容块,或把要点拆到 3 条以上,或补一组数据/对照;` +
          `不要用放大字号或加大间距来填满,也不要写坐标。`,
      )
      await emitEvent(taskId, 'status', {
        status: 'generating',
        stage: `${sparse.length} 页内容偏少,正在补写(${attempt + 1}/${DENSITY_MAX_REPAIRS})`,
      })
      let repaired: DeckSpecJson
      try {
        repaired = await repairSpecWithWarnings(input, taskId, plan, artifact.spec, lines, research)
      } catch (e) {
        console.warn('[pipeline] 密度补写失败,沿用当前规格:', (e as Error).message)
        break
      }
      const rebuilt = await buildDeck(repaired, outPath, taskId, 92)
      if (!rebuilt.ok) {
        console.warn('[pipeline] 密度补写后的重建失败,保留上一份成品:', rebuilt.error)
        break
      }
      artifact.spec = repaired
      built = rebuilt
      // 补内容后可能撑出边界:再走一轮警告修复(只给 1 次机会,不无限拉长)
      await repairLayoutWarnings(1)
    }
    if (!built.ok) throw new Error(built.error || 'BUILD_FAILED')

    // 页数不足(引擎确实少写页)时按比例退款:与旧链路"部分失败"同一套账务口径
    const delivered = built.slides ?? artifact.spec.slides.length
    const missing = Math.max(0, input.slideCount - delivered)
    let partialRefunded = 0
    if (missing > 0) {
      partialRefunded = Math.floor((input.slideCount * missing) / Math.max(1, input.slideCount))
      if (partialRefunded > 0) {
        await db.$transaction(async (tx) => {
          const t = await tx.generationTask.updateMany({
            // 条件写守卫:任务若已被结算(取消/超时),这里不再额外退
            where: { id: taskId, status: { notIn: FINAL_STATUSES } },
            data: { creditsUsed: Math.max(0, input.slideCount - partialRefunded) },
          })
          if (t.count === 0) return
          const refunded = await tx.user.updateMany({
            where: { id: userId },
            data: { remainingCredits: { increment: partialRefunded } },
          })
          if (refunded.count === 0) return
          const user = await tx.user.findUnique({ where: { id: userId }, select: { remainingCredits: true } })
          await tx.creditChange.create({
            data: {
              userId,
              taskId,
              change: partialRefunded,
              reason: 'partial_refund',
              balance: user?.remainingCredits ?? 0,
              remark: `引擎只交付 ${delivered}/${input.slideCount} 页,按比例退还 ${partialRefunded} 次`,
            },
          })
        })
      }
    }

    // 预守卫(M-12):写文件前先查一次终态,已结算则连 PPTX 都不落盘,不留孤儿产物。
    // (非互斥的轻量检查;真正的原子守卫是下方 updateMany)
    const preGuard = await db.generationTask.findUnique({
      where: { id: taskId },
      select: { status: true },
    })
    if (!preGuard || FINAL_STATUSES.includes(preGuard.status)) {
      console.warn(`[pipeline] 任务 ${taskId} 已被结算(超时/取消),构建结果不落盘`)
      rmSync(outPath, { force: true })
      return
    }
    // 存到标准位置(下载 token 用)。此时尚未置 succeeded,
    // 后续任何失败仍会走 catch → refundTask 正常退款,不吞账
    const buf = readFileSync(outPath)
    const storedPath = await saveGenerated(userId, taskId, buf, 'pptx')
    // M-24:标准位已落盘,删除引擎内层副本,避免同体积产物存两份。
    // saveGenerated 失败时不会走到这里(异常向上),内层保留作兜底。
    rmSync(outPath, { force: true })

    const engineReport = buildEngineReport(built)
    const outline = outlineOf(plan)
    const themeSnapshotJson = JSON.stringify(themeSnapshotFor(plan, artifact.spec))
    const finishedAt = new Date()
    // 终态守卫:任务若已被超时/取消结算,迟到的成功写入不得覆盖
    const settled = await db.generationTask.updateMany({
      where: { id: taskId, status: { notIn: FINAL_STATUSES } },
      data: {
        status: 'succeeded',
        resultFile: storedPath,
        progress: 100,
        progressStage: '完成',
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        finishedAt,
        qcWarnings: built.warnings > 0 ? JSON.stringify(built.warningDetails || []) : null,
        outline: JSON.stringify(outline),
        theme: themeSnapshotJson,
        deckSpec: JSON.stringify(artifact.spec),
        engineReport,
      },
    })
    if (settled.count === 0) {
      // 落盘已成,但库未写:孤儿文件留待每日清理,账务由守卫保证不重复
      console.warn(`[pipeline] 任务 ${taskId} 已被结算(超时/取消),丢弃迟到的成功结果`)
      return
    }
    // 质量提示:布局警告必须让调用方知道,在终态事件前发出
    if (built.warnings > 0) {
      const pages = (built.warningDetails || [])
        .map((w) => w.slide ?? 0)
        .filter((n) => n > 0)
        .sort((a, b) => a - b)
      await emitEvent(taskId, 'answer', {
        text: `⚠️ 质量提示:引擎报了 ${built.warnings} 条布局警告${pages.length ? `(第 ${Array.from(new Set(pages)).join('、')} 页)` : ''},`
          + 'PPT 已生成,个别文字可能偏紧。',
      })
    }
    if (missing > 0) {
      const refundNote = partialRefunded > 0
        ? `其中 ${missing} 页未交付,已按比例退还 ${partialRefunded} 次`
        : `其中 ${missing} 页未交付(不足一次兑换折算,未退款)`
      await emitEvent(taskId, 'answer', { text: `✅ 生成完成,${refundNote}。` })
    }
    await emitEvent(taskId, 'status', {
      status: 'succeeded',
      stage: '完成',
      slideCount: delivered,
      filename: `${plan.title}.pptx`,
    })
    console.log(
      `[pipeline] 任务 ${taskId} 成功:${delivered} 页 / ${built.bytes}B / warnings ${built.warnings} / 耗时 ${finishedAt.getTime() - startedAt.getTime()}ms`,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[pipeline] 任务 ${taskId} 失败:`, msg)
    const safe = userSafeError(msg)
    await emitEvent(taskId, 'error', { message: safe })
    await refundTask(taskId, safe)
  }
}

/** 构建 + 进度;失败原样抛出(错误里已含引擎 stderr 原文) */
async function buildDeck(
  spec: DeckSpecJson,
  outPath: string,
  taskId: string,
  progress: number,
): Promise<NativeBuildResult> {
  await emitEvent(taskId, 'status', { status: 'generating', stage: '正在用原生引擎写 OOXML(严格模式)…' })
  const built = await buildPptx(spec, outPath)
  await emitEvent(taskId, 'tool_response', {
    name: 'native_engine',
    status: built.ok ? 'completed' : 'failed',
    text: built.ok
      ? `${built.slides ?? spec.slides.length} 页 / ${Math.round(built.bytes / 1024)}KB / warnings ${built.warnings}` +
        ` / objects ${Object.keys(built.objects).sort().map((k) => `${k} ${built.objects[k]}`).join(' · ')}`
      : (built.error || '构建失败'),
  })
  if (built.ok) await setProgressSafe(taskId, progress, 'PPTX 已生成,正在校验')
  return built
}

/** 只在任务未终态时推进进度 */
async function setProgressSafe(taskId: string, progress: number, stage: string): Promise<void> {
  await db.generationTask
    .updateMany({
      where: { id: taskId, status: { notIn: FINAL_STATUSES } },
      data: { progress, progressStage: stage },
    })
    .catch(() => {})
}

/** 大纲快照:预览/列表页用(引擎不读) */
function outlineOf(plan: OutlinePlan): Array<{ title: string; template: string; brief: string; bullets: string[] }> {
  return plan.pages.map((page) => ({
    title: page.title,
    template: page.template,
    brief: page.brief,
    bullets: extractBullets(page.brief),
  }))
}

/** engineReport 入库内容:预览/排障都要的一份(JSON 字符串) */
function buildEngineReport(built: NativeBuildResult): string {
  const parsed = (() => {
    try {
      return JSON.parse(built.report) as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  // stdout 里的字段(objects/warnings/pageSize/slides)在下面又落了一遍,
  // 入库前把它去掉:engineReport 是 DB 里按任务存的,重复一份没有任何收益。
  const rest = { ...parsed }
  delete rest.stdout
  return JSON.stringify({
    ...rest,
    ok: built.ok,
    warnings: built.warnings,
    warningsByCode: built.warningsByCode || {},
    warningDetails: built.warningDetails || [],
    objects: built.objects,
    bytes: built.bytes,
    slides: built.slides,
    pageSize: built.pageSize,
    layout: built.layout,
  })
}

/** 主题快照:预设有真值,兼容字段留给旧列表页 */
function themeSnapshotFor(plan: OutlinePlan, spec: DeckSpecJson): Record<string, unknown> {
  const theme = spec.theme || themeFor(normalizePreset(plan.preset), 'zh-CN')
  const colors = theme.colors
  return {
    name: plan.styleName,
    preset: theme.name || plan.preset,
    colors,
    fonts: theme.fonts,
    sizes: theme.sizes,
    // 兼容字段(旧列表页按这几个键取色)
    bg: colors.background,
    titleColor: colors.primary,
    bodyColor: colors.foreground,
    fontName: theme.fonts.heading,
    titleSize: theme.sizes?.title ?? 32,
    bodySize: theme.sizes?.body ?? 14,
  }
}

/** 生成用户可见的错误文案:剥离服务器路径、截断日志尾巴 */
export function userSafeError(msg: string): string {
  const cleaned = msg
    .replace(/[A-Za-z]:\\[^\s"'`,;)）】]+/g, '<路径>')
    .replace(/\/(?:home|usr|var|tmp|app|root)\/\S+/g, '<路径>')
    .replace(/\s+/g, ' ')
    .trim()
  const friendly: Array<[RegExp, string]> = [
    [/引擎构建超时/, 'PPTX 构建超时,已自动退款,请稍后重试'],
    [/原生引擎目录不存在|缺少 cli\.js/, 'PPTX 引擎未就绪,请联系管理员(NATIVE_ENGINE_DIR)'],
    [/规格未通过引擎校验/, '生成的原生规格未通过引擎校验,请稍后重试或换个主题描述'],
    [/引擎拒绝了这份 spec|引擎未产出 JSON/, 'PPTX 构建失败,请稍后重试;若持续失败请联系客服'],
  ]
  for (const [pattern, message] of friendly) {
    if (pattern.test(msg)) return message
  }
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned
}

function extractBullets(brief: string): string[] {
  const lines = (brief || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const bullets: string[] = []
  for (const l of lines) {
    const c = l.replace(/^[-•*\d.)\s]+/, '')
    if (c.length > 4 && c.length < 120) bullets.push(c)
    if (bullets.length >= 5) break
  }
  return bullets.length ? bullets : ['要点一', '要点二']
}
