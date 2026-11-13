/**
 * GET /api/admin/logs
 * 管理员操作审计日志列表
 *
 * - query: ?page=1&pageSize=20&action=xxx(可选筛选)
 * - 按 createdAt 降序
 * - 关联 admin 用户取 username
 * - 字段: id, adminId, adminUsername, action, target, detail, createdAt
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
    const action = url.searchParams.get('action')?.trim() || undefined
    const { page, pageSize, skip, take } = paginate(req.url)

    const where = {
      ...(action ? { action } : {}),
    }

    const [total, logs] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          admin: { select: { username: true } },
        },
      }),
    ])

    const items = logs.map((l) => ({
      id: l.id,
      adminId: l.adminId,
      adminUsername: l.admin.username,
      action: l.action,
      target: l.target,
      detail: l.detail,
      createdAt: l.createdAt.toISOString(),
    }))

    return ok({ items, total, page, pageSize })
  } catch (e) {
    return handleApiError(e)
  }
}
