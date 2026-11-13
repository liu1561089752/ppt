/**
 * POST /api/generate
 * 生成任务入口(原生 PPTX 管线)
 *
 * - 必须登录
 * - 事务内校验并发/日限 + 原子扣 1 次 + 创建任务 + 写 CreditChange + 首条对话事件
 *   (日限只计未终态任务:failed/refunded/cancelled 不占每日额度)
 * - 幂等: 相同 requestId 返回已有 task(并发重复提交由唯一约束兜底)
 * - 事务后: after() 以 fire-and-forget 方式执行原生管线
 *   (调研 → 规划 → 生成规格 Deck Spec → 构建 PPTX → 校验),不阻塞响应
 * - 前端通过 /api/generate/[taskId]/events 轮询对话流与进度
 * - 返回 { taskId, status: 'pending' }
 */
import { after, NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { requireUser } from '@/lib/session'
import { ok, handleApiError, ApiError, parseBody } from '@/lib/api-utils'
import { executeNativePipeline } from '@/lib/pipeline'

const VALID_PRESETS = ['business', 'tech', 'education', 'marketing', 'minimal', 'creative']

const generateSchema = z.object({
  requestId: z.string().min(1, 'requestId 必填').max(128, 'requestId 过长'),
  topic: z
    .string()
    .min(3, '主题至少 3 个字符')
    .max(CONFIG.GENERATE.maxTopicLength, `主题最多 ${CONFIG.GENERATE.maxTopicLength} 个字符`),
  audience: z.string().max(200).optional(),
  tone: z.string().max(100).optional(),
  preset: z
    .string()
    .optional()
    .refine((v) => !v || VALID_PRESETS.includes(v.toLowerCase()), {
      message: 'preset 必须是 business/tech/education/marketing/minimal/creative 之一',
    }),
  customStyle: z
    .string()
    .max(CONFIG.GENERATE.maxCustomStyleLength, `自定义风格描述最多 ${CONFIG.GENERATE.maxCustomStyleLength} 个字符`)
    .optional(),
  customRequirements: z
    .string()
    .max(2000, '额外要求最多 2000 字符')
    .optional(),
  language: z.string().max(20).optional(),
  slideCount: z
    .number()
    .int()
    .min(CONFIG.GENERATE.minSlideCount, `幻灯片数最少 ${CONFIG.GENERATE.minSlideCount}`)
    .max(CONFIG.GENERATE.maxSlideCount, `幻灯片数最多 ${CONFIG.GENERATE.maxSlideCount}`)
    .optional(),
})

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export async function POST(req: Request | NextRequest) {
  try {
    const session = await requireUser()

    // 1. 解析 + 校验
    const {
      requestId,
      topic,
      audience,
      tone,
      preset,
      customStyle,
      customRequirements,
      language,
      slideCount,
    } = await parseBody(req, generateSchema, (raw) => {
      if (typeof raw.topic === 'string') raw.topic = raw.topic.trim()
      if (typeof raw.requestId === 'string') raw.requestId = raw.requestId.trim()
      if (typeof raw.preset === 'string') raw.preset = raw.preset.toLowerCase()
    })

    // 2. 幂等: 相同 requestId 返回已有 task
    const existing = await db.generationTask.findUnique({
      where: { requestId },
      select: { id: true, status: true, userId: true },
    })
    if (existing) {
      if (existing.userId !== session.userId) {
        throw new ApiError(409, '请勿重复提交', 'DUPLICATE_REQUEST')
      }
      return ok({ taskId: existing.id, status: existing.status })
    }

    // 3. 组装任务描述(对话页展示用;实际提示词由管线内各阶段生成)
    const effectiveSlideCount = slideCount || 8
    const promptDesc = `帮我制作一份 PPT,主题:${topic}`
      + (audience ? `
受众:${audience}` : '')
      + (customStyle ? `
风格:${customStyle}` : '')
      + (tone ? `
语气:${tone}` : '')
      + `
篇幅:约 ${effectiveSlideCount} 页`
    const promptSent = promptDesc

    // 4. 事务: 并发/日限校验 + 原子扣 1 次 + 创建任务 + 写 CreditChange
    //    (校验放进事务,避免并发提交双双通过先 count 后 create 的窗口)
    let task
    try {
      task = await db.$transaction(async (tx) => {
        const [pendingCount, todayCount] = await Promise.all([
          tx.generationTask.count({
            where: {
              userId: session.userId,
              status: { in: ['pending', 'starting', 'generating', 'question_pending', 'answering', 'finalizing'] },
            },
          }),
          tx.generationTask.count({
            where: {
              userId: session.userId,
              createdAt: { gte: startOfDay(new Date()) },
              // 失败/取消/退款的终态任务不占每日额度(H2/M-15)
              status: { notIn: ['failed', 'refunded', 'cancelled'] },
            },
          }),
        ])
        if (pendingCount >= CONFIG.RATE_LIMIT.generate.maxConcurrent) {
          throw new ApiError(429, `已有任务进行中,请等待完成后再试`, 'RATE_LIMITED')
        }
        if (todayCount >= CONFIG.RATE_LIMIT.generate.maxDaily) {
          throw new ApiError(
            429,
            `今日已生成 ${todayCount} 次,已达每日上限 ${CONFIG.RATE_LIMIT.generate.maxDaily} 次`,
            'RATE_LIMITED',
          )
        }

        const updated = await tx.user.updateMany({
          where: { id: session.userId, remainingCredits: { gte: 1 } },
          data: { remainingCredits: { decrement: 1 } },
        })
        if (updated.count === 0) {
          throw new Error('INSUFFICIENT_CREDITS')
        }

        const user = await tx.user.findUnique({
          where: { id: session.userId },
          select: { remainingCredits: true },
        })

        const newTask = await tx.generationTask.create({
          data: {
            userId: session.userId,
            requestId,
            topic,
            audience: audience || null,
            tone: tone || null,
            preset: preset || null,
            customStyle: customStyle || null,
            customRequirements: customRequirements || null,
            language: language || 'zh-CN',
            slideCount: effectiveSlideCount,
            status: 'pending',
            mode: 'native',
            promptSent,
            creditsUsed: 1,
          },
        })

        await tx.creditChange.create({
          data: {
            userId: session.userId,
            taskId: newTask.id,
            change: -1,
            reason: 'generate',
            balance: user?.remainingCredits || 0,
            remark: `生成 PPT: ${topic.slice(0, 60)}`,
          },
        })

        // 首条对话事件同事务写入(H1①):之前在事务外,这里失败会让任务
        // 卡在 pending 且对话页丢失首条;失败则整个事务回滚(扣分/建任务一并回退)
        await tx.chatMessage.create({
          data: {
            taskId: newTask.id,
            seq: 1,
            type: 'user_prompt',
            payload: JSON.stringify({ text: promptSent, topic }),
          },
        })

        return newTask
      })
    } catch (e) {
      // 并发重复提交撞 requestId 唯一约束 → 幂等返回已有任务
      if (
        typeof e === 'object' && e !== null && 'code' in e &&
        (e as { code?: string }).code === 'P2002'
      ) {
        const race = await db.generationTask.findUnique({
          where: { requestId },
          select: { id: true, status: true, userId: true },
        })
        if (race && race.userId === session.userId) {
          return ok({ taskId: race.id, status: race.status })
        }
        throw new ApiError(409, '请勿重复提交', 'DUPLICATE_REQUEST')
      }
      throw e
    }

    // 5. 首条对话事件已并入上方事务(H1①),此处不再单独写

    // 6. 异步执行原生管线(在响应返回前调度,不阻塞请求)。
    //    M-13 确认:扣分、建任务、账本、首条事件在同一个 $transaction 内,
    //    事务失败会 throw,走不到这里 —— 事务失败绝不调度管线
    //    (H1②)after 回调内任何 throw 必须被捕获:进程不崩,只留日志;
    //    管线启动失败的任务由僵尸清扫兜底退款(5min 周期,已有)
    //    唯一入口是 executeNativePipeline(ACCEPTANCE §5),路由层不做任何阶段编排。
    after(async () => {
      try {
        await executeNativePipeline({
          taskId: task.id,
          userId: session.userId,
          topic,
          audience: audience || undefined,
          tone: tone || undefined,
          preset: preset || undefined,
          customStyle: customStyle || undefined,
          customRequirements: customRequirements || undefined,
          language: language || 'zh-CN',
          slideCount: effectiveSlideCount,
        })
      } catch (e) {
        // 管线内部已 catch 常规失败并退款;能到这里的多为调度层异常
        console.error(`[generate] 原生管线调度异常(任务 ${task.id},由僵尸清扫兜底退款):`, e)
      }
    })

    return ok({ taskId: task.id, status: 'pending' })
  } catch (e) {
    return handleApiError(e)
  }
}
