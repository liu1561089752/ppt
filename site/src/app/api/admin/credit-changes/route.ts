/**
 * GET /api/admin/credit-changes
 * 全用户次数变动审计/对账
 *
 * - query: ?page=1&pageSize=20&userId=xxx&reason=xxx
 * - 按 createdAt 降序
 * - 关联 user 取 username
 * - 字段: id, userId, username, taskId, change, reason, balance, remark, createdAt
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { ok, handleApiError, ApiError, paginate } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

export async function GET(req: Request | NextRequest) {
  try {
    const session = await requireAdmin()

    // 轻限流:admin 读 120/min/user
    const rl = rateLimit(`admin:${session.userId}`, 60 * 1000, 120)
    if (!rl.ok) throw new ApiError(429, '请求过于频繁,请稍后再试', 'RATE_LIMITED')

    const url = new URL(req.url)
    const userId = url.searchParams.get('userId')?.trim() || undefined
    const reason = url.searchParams.get('reason')?.trim() || undefined
    const { page, pageSize, skip, take } = paginate(req.url)

    const where = {
      ...(userId ? { userId } : {}),
      ...(reason ? { reason } : {}),
    }

    const [total, items] = await Promise.all([
      db.creditChange.count({ where }),
      db.creditChange.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          user: { select: { username: true } },
        },
      }),
    ])

    return ok({
      items: items.map((c) => ({
        id: c.id,
        userId: c.userId,
        username: c.user.username,
        taskId: c.taskId,
        change: c.change,
        reason: c.reason,
        balance: c.balance,
        remark: c.remark,
        createdAt: c.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    })
  } catch (e) {
    return handleApiError(e)
  }
}
