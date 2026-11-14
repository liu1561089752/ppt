/**
 * GET /api/admin/users
 * 管理员查询用户列表(分页 + 筛选)
 *
 * - query: ?page=1&pageSize=20&q=username模糊&status=active|banned
 * - status=banned 等价于 isActive=false
 * - 按 createdAt 降序
 * - 字段: id, username, email, remainingCredits, isActive, isAdmin, createdAt, lastLoginAt, lastLoginIp
 * - 不返回 passwordHash
 * - 返回 { items, total, page, pageSize }
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
    const q = url.searchParams.get('q')?.trim() || undefined
    const statusParam = url.searchParams.get('status')
    const { page, pageSize, skip, take } = paginate(req.url)

    // status -> isActive
    let isActiveFilter: boolean | undefined
    if (statusParam === 'active') isActiveFilter = true
    else if (statusParam === 'banned') isActiveFilter = false
    else if (statusParam) {
      throw new ApiError(400, 'status 参数无效(仅支持 active / banned)', 'VALIDATION_ERROR')
    }

    const where = {
      ...(isActiveFilter !== undefined ? { isActive: isActiveFilter } : {}),
      ...(q ? { username: { contains: q } } : {}),
    }

    const [total, users] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
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
        },
      }),
    ])

    const items = users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      remainingCredits: u.remainingCredits,
      isActive: u.isActive,
      isAdmin: u.isAdmin,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
      lastLoginIp: u.lastLoginIp,
    }))

    return ok({ items, total, page, pageSize })
  } catch (e) {
    return handleApiError(e)
  }
}
