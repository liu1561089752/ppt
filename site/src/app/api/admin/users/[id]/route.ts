/**
 * GET /api/admin/users/[id]
 * 管理员查看用户详情
 *
 * - 基础信息: id, username, email, remainingCredits, isActive, isAdmin, createdAt, lastLoginAt, lastLoginIp
 * - 兑换记录: redemptions(降序,最近 10 条,含 card.code)
 * - 生成任务: tasks(降序,最近 10 条)
 * - 次数变动: creditChanges(降序,最近 20 条)
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { ok, handleApiError, ApiError } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

export async function GET(
  req: Request | NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAdmin()
    const { id: userId } = await params

    // 轻限流:admin 读 120/min/user(详情联查 3 张表,防刷)
    const rl = rateLimit(`admin:${session.userId}`, 60 * 1000, 120)
    if (!rl.ok) throw new ApiError(429, '请求过于频繁,请稍后再试', 'RATE_LIMITED')

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        remainingCredits: true,
        isActive: true,
        isAdmin: true,
        createdAt: true,
        lastLoginAt: true,
        lastLoginIp: true,
        redemptions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            card: { select: { code: true, credits: true, status: true } },
          },
        },
        tasks: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            topic: true,
            status: true,
            preset: true,
            language: true,
            slideCount: true,
            creditsUsed: true,
            model: true,
            durationMs: true,
            errorMessage: true,
            createdAt: true,
            finishedAt: true,
          },
        },
        creditChanges: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            change: true,
            reason: true,
            balance: true,
            remark: true,
            taskId: true,
            createdAt: true,
          },
        },
      },
    })

    if (!user) {
      throw new ApiError(404, '用户不存在', 'VALIDATION_ERROR')
    }

    const redemptions = user.redemptions.map((r) => ({
      id: r.id,
      cardId: r.cardId,
      code: r.card.code,
      credits: r.credits,
      cardStatus: r.card.status,
      xianyuOrderNo: r.xianyuOrderNo,
      createdAt: r.createdAt.toISOString(),
    }))

    const tasks = user.tasks.map((t) => ({
      id: t.id,
      topic: t.topic,
      status: t.status,
      preset: t.preset,
      language: t.language,
      slideCount: t.slideCount,
      creditsUsed: t.creditsUsed,
      model: t.model,
      durationMs: t.durationMs,
      errorMessage: t.errorMessage,
      createdAt: t.createdAt.toISOString(),
      finishedAt: t.finishedAt ? t.finishedAt.toISOString() : null,
    }))

    const creditChanges = user.creditChanges.map((c) => ({
      id: c.id,
      change: c.change,
      reason: c.reason,
      balance: c.balance,
      remark: c.remark,
      taskId: c.taskId,
      createdAt: c.createdAt.toISOString(),
    }))

    return ok({
      id: user.id,
      username: user.username,
      email: user.email,
      remainingCredits: user.remainingCredits,
      isActive: user.isActive,
      isAdmin: user.isAdmin,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      lastLoginIp: user.lastLoginIp,
      redemptions,
      tasks,
      creditChanges,
    })
  } catch (e) {
    return handleApiError(e)
  }
}
