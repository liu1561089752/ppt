/**
 * POST /api/auth/logout
 * 退出登录
 *
 * - 任意情况都清 cookie
 * - 返回 { ok: true }
 */
import { NextRequest } from 'next/server'
import { clearSessionCookie } from '@/lib/session'
import { ok, handleApiError } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

export async function POST(_req: Request | NextRequest) {
  try {
    // 轻限流:logout 本身是幂等清 cookie,无重资源;防异常客户端刷日志/写 cookie
    const rl = rateLimit('logout:anon', 60 * 1000, 120)
    if (!rl.ok) return ok({ ok: true }) // 限流时静默成功:登出语义无副作用,拒绝反而造成前端状态不一致
    // 任意情况都尝试清 cookie(没有 session 时 cookies().delete 也是幂等的)
    await clearSessionCookie()
    return ok({ ok: true })
  } catch (e) {
    return handleApiError(e)
  }
}
