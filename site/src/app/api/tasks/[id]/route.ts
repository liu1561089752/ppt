/**
 * GET /api/tasks/[id]
 * 任务详情
 *
 * - 必须登录
 * - 鉴权: task.userId === current user,否则 FORBIDDEN
 * - 字段: 列表所有字段 + audience/tone/resultFile 替换为 hasResult
 */
import { NextRequest } from 'next/server'
import { requireUser } from '@/lib/session'
import { ok, handleApiError, assertTaskOwner } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

export async function GET(
  req: Request | NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireUser()
    const { id } = await params

    // 轻限流:详情页轮询路径,120/min/user(与列表同档)
    const rl = rateLimit(`task:${session.userId}`, 60 * 1000, 120)
    if (!rl.ok) return ok({ rateLimited: true }) // 超限轻量响应;前端按已有任务状态继续渲染

    // M-10:改用 omitHeavyFields——只丢最重的预览类字段,
    // 保留 outline/theme(对话页大纲与主题不再消失);qcWarnings 本就不在重字段里
    const task = await assertTaskOwner(id, session, { omitHeavyFields: true })

    // 解析 outline/theme/qcWarnings JSON(失败不报错,只返回 null)
    let outline: unknown = null
    let theme: unknown = null
    let qcWarnings: unknown = null
    try {
      if (task.outline) outline = JSON.parse(task.outline)
    } catch {
      outline = null
    }
    try {
      if (task.theme) theme = JSON.parse(task.theme)
    } catch {
      theme = null
    }
    try {
      if (task.qcWarnings) qcWarnings = JSON.parse(task.qcWarnings)
    } catch {
      qcWarnings = null
    }

    return ok({
      id: task.id,
      topic: task.topic,
      status: task.status,
      audience: task.audience,
      tone: task.tone,
      preset: task.preset,
      customStyle: task.customStyle,
      customRequirements: task.customRequirements,
      language: task.language,
      slideCount: task.slideCount,
      creditsUsed: task.creditsUsed,
      errorMessage: task.errorMessage,
      qcWarnings,
      model: task.model,
      mode: task.mode,
      promptTokens: task.promptTokens,
      completionTokens: task.completionTokens,
      durationMs: task.durationMs,
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt ? task.startedAt.toISOString() : null,
      finishedAt: task.finishedAt ? task.finishedAt.toISOString() : null,
      hasResult: !!task.resultFile,
      outline,
      theme,
      progress: task.progress,
      progressStage: task.progressStage,
    })
  } catch (e) {
    return handleApiError(e)
  }
}
