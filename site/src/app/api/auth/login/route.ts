/**
 * POST /api/auth/login
 * 用户登录
 *
 * - body: { username, password }
 * - 失败退避:用户名维度指数退避(1→0s、2→5s、3→30s、4→2min、5+→15min),
 *   429 带 Retry-After,文案"尝试过于频繁,请 N 秒后再试"(不暴露"被锁")
 * - IP 维度仅 TRUST_PROXY=true 时启用('direct' 单桶会误伤全站)
 * - 用户不存在 / 被封禁 / 密码错误都返回 INVALID_CREDENTIALS(文案不区分)
 * - 成功:清理失败计数 + 更新 lastLoginAt/lastLoginIp + 签发 JWT + 写 cookie
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/password'
import { signToken } from '@/lib/jwt'
import { setSessionCookie } from '@/lib/session'
import { clearFail, recordBackoff, backoffRemaining } from '@/lib/rate-limit'
import { ok, err, handleApiError, getClientIp, parseBody } from '@/lib/api-utils'

const loginSchema = z.object({
  username: z.string().min(1, '请输入用户名').max(64, '用户名过长'),
  password: z.string().min(1, '请输入密码').max(128, '密码过长'),
})

export async function POST(req: Request | NextRequest) {
  try {
    const clientIp = getClientIp(req as Request)

    // 1. 解析 + 校验
    const { username, password } = await parseBody(req, loginSchema, (raw) => {
      if (typeof raw.username === 'string') raw.username = raw.username.trim()
    })

    // 2. 失败退避检查(防爆破)。
    // - 用户名维度:指数退避(1→0s、2→5s、3→30s、4→2min、5+→15min 封顶),
    //   是"需等待"而非"账户锁死"——避免硬锁可被用来定向锁死 admin(红线5)。
    // - IP 维度:仅当 TRUST_PROXY=true(能拿到真实 IP)才启用;未启用时
    //   getClientIp() 返回常量 'direct',若计入则全站共享一个桶,
    //   任意 5 次失败会把所有用户一起挡在门外,误伤不可接受。
    const useIpBucket = process.env.TRUST_PROXY === 'true'
    const userKey = `login:fail:${username.toLowerCase()}`
    const ipKey = `login:fail:ip:${clientIp}`
    let waitMs = backoffRemaining(userKey)
    if (useIpBucket) {
      waitMs = Math.max(waitMs, backoffRemaining(ipKey))
    }
    if (waitMs > 0) {
      return err(
        429,
        `尝试过于频繁,请 ${Math.ceil(waitMs / 1000)} 秒后再试`,
        'RATE_LIMITED',
        { 'retry-after': String(Math.ceil(waitMs / 1000)) },
      )
    }

    // 3. 查用户(密码错误或不存在都返回 INVALID_CREDENTIALS)。
    // 用户名大小写不敏感(M-63):与注册查重口径一致,防止 Alice/alice
    // 被视为两个账号。Prisma provider=sqlite 不支持 mode:'insensitive'
    // (仅 PostgreSQL 等),应用层等价实现:精确查 + 小写化比对;
    // 失败退避键仍用小写化 username,不受影响。
    const user = await db.user.findFirst({
      where: { username: username },
    })
    const userMatched = user && user.username.toLowerCase() === username.toLowerCase()
    if (!userMatched || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
      // 统一失败路径:计入指数退避;若已进入需等待区间则回 429,
      // 否则维持 401 INVALID_CREDENTIALS(文案不区分用户不存在/密码错)
      const retryAfterUser = recordBackoff(userKey)
      let retryAfter = retryAfterUser
      if (useIpBucket) {
        retryAfter = Math.max(retryAfter, recordBackoff(ipKey))
      }
      if (retryAfter > 0) {
        return err(
          429,
          `尝试过于频繁,请 ${Math.ceil(retryAfter / 1000)} 秒后再试`,
          'RATE_LIMITED',
          { 'retry-after': String(Math.ceil(retryAfter / 1000)) },
        )
      }
      return err(401, '用户名或密码错误', 'INVALID_CREDENTIALS')
    }

    // 4. 成功:清理失败计数 + 更新登录信息 + 签发 token
    clearFail(userKey)
    if (useIpBucket) clearFail(ipKey)

    await db.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        lastLoginIp: clientIp,
      },
    })

    const token = signToken({
      userId: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
    })
    await setSessionCookie(token)

    return ok({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        remainingCredits: user.remainingCredits,
        isAdmin: user.isAdmin,
      },
    })
  } catch (e) {
    return handleApiError(e)
  }
}
