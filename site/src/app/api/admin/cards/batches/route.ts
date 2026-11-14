/**
 * GET /api/admin/cards/batches
 * 管理员查询卡密批次列表(含每批统计)
 *
 * - query: ?page=1&pageSize=20
 * - 返回 { items: [{ id, batchNo, credits, quantity, remark, expiresAt, createdAt, createdBy, stats: { total, used, unused, revoked } }], total, page, pageSize }
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

    const { page, pageSize, skip, take } = paginate(req.url)

    const [total, batches] = await Promise.all([
      db.cardBatch.count(),
      db.cardBatch.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          createdBy: { select: { username: true } },
        },
      }),
    ])

    const batchIds = batches.map((b) => b.id)

    // 一次性 groupBy 拿到每个批次的 status 统计
    const grouped = await db.card.groupBy({
      by: ['batchId', 'status'],
      _count: true,
      where: { batchId: { in: batchIds } },
    })

    // 构建 batchId -> { total, unused, used, revoked }
    const statsMap = new Map<string, { total: number; unused: number; used: number; revoked: number }>()
    for (const b of batchIds) {
      statsMap.set(b, { total: 0, unused: 0, used: 0, revoked: 0 })
    }
    for (const g of grouped) {
      if (!g.batchId) continue
      const s = statsMap.get(g.batchId)
      if (!s) continue
      s.total += g._count
      if (g.status === 'unused' || g.status === 'used' || g.status === 'revoked') {
        s[g.status] += g._count
      }
    }

    const items = batches.map((b) => ({
      id: b.id,
      batchNo: b.batchNo,
      credits: b.credits,
      quantity: b.quantity,
      remark: b.remark,
      expiresAt: b.expiresAt ? b.expiresAt.toISOString() : null,
      createdAt: b.createdAt.toISOString(),
      createdBy: b.createdBy.username,
      stats: statsMap.get(b.id) ?? { total: 0, unused: 0, used: 0, revoked: 0 },
    }))

    return ok({ items, total, page, pageSize })
  } catch (e) {
    return handleApiError(e)
  }
}
