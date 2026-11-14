/**
 * GET /api/auth/me
 * 获取当前登录用户信息
 *
 * - 未登录返回 401
 * - 返回 { user: { id, username, email, remainingCredits, isAdmin, isActive, createdAt } }
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getSession } from '@/lib/session'
import { ok, err, handleApiError } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

export async function GET(_req: Request | NextRequest) {
  try {
    const session = await getSession()
    if (!session) {
      return err(401, '请先登录', 'UNAUTHORIZED')
    }

    // 轻限流:该接口被多个页面轮询/共享刷新,防止异常客户端刷库
    const rl = rateLimit(`me:${session.userId}`, 60 * 1000, 60)
    if (!rl.ok) return err(429, '请求过于频繁,请稍后再试', 'RATE_LIMITED')

    // session 只验签名;封禁状态必须回库复查(与 requireUser 的 USER_BANNED
    // 语义一致):被封禁用户不能继续拿到 200 + 余额,否则前端看似一切正常、
    // 每个操作却都 403,而错误提示又是 toast,用户感知"点了没反应"。
    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: {
        id: true,
        username: true,
        email: true,
        remainingCredits: true,
        isAdmin: true,
        isActive: true,
        createdAt: true,
      },
    })

    if (!user || !user.isActive) {
      // 用户已被删除,或已被封禁 → 会话作废
      return err(401, '请先登录', 'UNAUTHORIZED')
    }

    return ok({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        remainingCredits: user.remainingCredits,
        isAdmin: user.isAdmin,
        isActive: user.isActive,
        createdAt: user.createdAt.toISOString(),
      },
    })
  } catch (e) {
    return handleApiError(e)
  }
}
