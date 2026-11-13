/**
 * GET /api/credits/history
 * 当前用户积分变更历史(CreditChange 列表)
 *
 * - 必须登录
 * - query: ?page=1&pageSize=20
 * - 仅返回 reason='redeem'(兑换历史口径;generate/refund/admin_adjust 走 profile 的全部流水)
 * - 按 createdAt 降序
 * - 字段: change, reason, balance, remark, taskId, createdAt
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { ok, handleApiError, paginate } from '@/lib/api-utils'

export async function GET(req: Request | NextRequest) {
  try {
    const session = await requireUser()

    const { page, pageSize, skip, take } = paginate(req.url)

    // 口径对齐(H9/M-40):只返回兑换记录(redeem),与前端"兑换历史"语义一致;
    // 此前返回全部 CreditChange 导致分页 total 与列表展示错位
    const where = { userId: session.userId, reason: 'redeem' }

    const [total, items] = await Promise.all([
      db.creditChange.count({ where }),
      db.creditChange.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true,
          change: true,
          reason: true,
          balance: true,
          remark: true,
          taskId: true,
          createdAt: true,
        },
      }),
    ])

    return ok({
      items: items.map((c) => ({
        id: c.id,
        change: c.change,
        reason: c.reason,
        balance: c.balance,
        remark: c.remark,
        taskId: c.taskId,
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
