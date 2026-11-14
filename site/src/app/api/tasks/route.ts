/**
 * GET /api/tasks
 * 当前用户任务列表(分页 + 状态筛选)
 *
 * - 必须登录
 * - query: ?page=1&pageSize=10&status=xxx
 * - 返回当前用户的任务(按 createdAt 降序)
 * - 字段: id, topic, status, preset, language, slideCount, creditsUsed,
 *         errorMessage, model, durationMs, createdAt, startedAt, finishedAt, hasResult
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { ok, handleApiError, paginate } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const VALID_STATUS = [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'refunded',
  'cancelled',
] as const

export async function GET(req: Request | NextRequest) {
  try {
    const session = await requireUser()

    // 轻限流:读操作 120/min/user(列表查询带 count+findMany,防异常客户端刷库)
    const rl = rateLimit(`tasks:${session.userId}`, 60 * 1000, 120)
    if (!rl.ok) return ok({ items: [], total: 0, page: 1, pageSize: 10 }) // 超限回空集:前端列表语义安全,不打断轮询

    const url = new URL(req.url)
    const statusParam = url.searchParams.get('status')
    const status =
      statusParam && VALID_STATUS.includes(statusParam as (typeof VALID_STATUS)[number])
        ? (statusParam as (typeof VALID_STATUS)[number])
        : undefined
    const { page, pageSize, skip, take } = paginate(req.url, 10)

    const where = {
      userId: session.userId,
      ...(status ? { status } : {}),
    }

    const [total, tasks] = await Promise.all([
      db.generationTask.count({ where }),
      db.generationTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true,
          topic: true,
          status: true,
          preset: true,
          customStyle: true,
          customRequirements: true,
          language: true,
          slideCount: true,
          creditsUsed: true,
          errorMessage: true,
          model: true,
          mode: true,
          durationMs: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
          resultFile: true,
          outline: true,
          theme: true,
          progress: true,
          progressStage: true,
        },
      }),
    ])

    const items = tasks.map((t) => {
      let outline: unknown = null
      let theme: unknown = null
      try {
        if (t.outline) outline = JSON.parse(t.outline)
      } catch {
        outline = null
      }
      try {
        if (t.theme) theme = JSON.parse(t.theme)
      } catch {
        theme = null
      }
      return {
        id: t.id,
        topic: t.topic,
        status: t.status,
        preset: t.preset,
        mode: t.mode,
        customStyle: t.customStyle,
        customRequirements: t.customRequirements,
        language: t.language,
        slideCount: t.slideCount,
        creditsUsed: t.creditsUsed,
        errorMessage: t.errorMessage,
        model: t.model,
        durationMs: t.durationMs,
        createdAt: t.createdAt.toISOString(),
        startedAt: t.startedAt ? t.startedAt.toISOString() : null,
        finishedAt: t.finishedAt ? t.finishedAt.toISOString() : null,
        hasResult: !!t.resultFile,
        outline,
        theme,
        progress: t.progress,
        progressStage: t.progressStage,
      }
    })

    return ok({ items, total, page, pageSize })
  } catch (e) {
    return handleApiError(e)
  }
}
