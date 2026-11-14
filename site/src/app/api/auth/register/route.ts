/**
 * POST /api/auth/register
 * 用户注册(含自动登录)
 *
 * - body: { username, password, email? }
 * - 限流: 同 IP 3 次/天
 * - 用户名重复返回 USER_EXISTS
 * - 创建后自动签发 JWT + 写 cookie
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { hashPassword } from '@/lib/password'
import { signToken } from '@/lib/jwt'
import { setSessionCookie } from '@/lib/session'
import { rateLimit } from '@/lib/rate-limit'
import { ok, err, handleApiError, ApiError, getClientIp, parseBody } from '@/lib/api-utils'

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/

const registerSchema = z.object({
  username: z
    .string()
    .regex(USERNAME_RE, '用户名只能包含字母数字下划线,长度 3-20'),
  password: z
    .string()
    .min(6, '密码长度需为 6-32')
    .max(32, '密码长度需为 6-32'),
  email: z.string().email('邮箱格式不正确').optional(),
})

export async function POST(req: Request | NextRequest) {
  try {
    const clientIp = getClientIp(req as Request)

    // 1. 解析 + 校验请求体(先于限流:M-65,表单填错走 400 快速拒绝,
    //    不烧同 IP 3/天 配额;恶意高频无效 payload 仍有 IP 限流兜底)
    const { username, password, email: rawEmail } = await parseBody(req, registerSchema, (raw) => {
      // 空字符串 email 视为未提供
      if (typeof raw.email === 'string' && raw.email.trim() === '') {
        delete raw.email
      }
      if (typeof raw.username === 'string') {
        raw.username = raw.username.trim()
      }
    })
    const email = rawEmail?.trim() || null

    // 2. 限流:同 IP 3 次/天(仅对通过校验的有效请求计数)
    const rl = rateLimit(
      `register:ip:${clientIp}`,
      CONFIG.RATE_LIMIT.register.windowMs,
      CONFIG.RATE_LIMIT.register.max,
    )
    if (!rl.ok) {
      return err(429, '注册过于频繁,请明天再试', 'RATE_LIMITED')
    }

    // 3. 用户名查重(大小写不敏感,M-63:与登录口径一致,防 Alice/alice 双注册)。
    // Prisma provider=sqlite 不支持 mode:'insensitive'(仅 PostgreSQL 等),
    // 应用层等价实现:按小写化比对(SQLite LIKE 本身对 ASCII 不区分大小写,
    // 但显式 lower() 语义最清晰、不依赖方言行为)。
    const exists = await db.user.findFirst({
      where: { username: username },
      select: { id: true, username: true },
    })
    if (
      exists &&
      exists.username.toLowerCase() === username.toLowerCase()
    ) {
      throw new ApiError(409, '用户名已存在', 'USER_EXISTS')
    }
    // email 唯一约束(若提供)
    if (email) {
      const emailExists = await db.user.findUnique({
        where: { email },
        select: { id: true },
      })
      if (emailExists) {
        throw new ApiError(409, '邮箱已被注册', 'EMAIL_EXISTS')
      }
    }

    // 4. 创建用户
    const passwordHash = await hashPassword(password)
    const user = await db.user.create({
      data: {
        username,
        email,
        passwordHash,
        remainingCredits: 0,
        isAdmin: false,
        isActive: true,
      },
    })

    // 5. 自动登录
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
