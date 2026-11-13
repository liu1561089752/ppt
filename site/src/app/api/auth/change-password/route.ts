/**
 * POST /api/auth/change-password
 * 用户修改自己的密码
 *
 * - 必须登录;需验证当前密码
 * - 成功后 passwordChangedAt 置为现在:其它设备的旧 token 全部失效
 * - 为当前会话签发新 token(本设备保持登录)
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { verifyPassword, hashPassword } from '@/lib/password'
import { requireUser, setSessionCookie } from '@/lib/session'
import { signToken } from '@/lib/jwt'
import { ok, handleApiError, ApiError, parseBody } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码').max(128, '密码过长'),
  newPassword: z.string().min(6, '新密码长度需为 6-32').max(32, '新密码长度需为 6-32'),
})

export async function POST(req: Request | NextRequest) {
  try {
    const session = await requireUser()

    // 轻限流:verifyPassword+hashPassword 是两次 bcrypt,单请求 CPU 成本高,
    // 不设上限会被拿来烧 CPU(5 次/分钟/用户,正常改密远用不满)
    const rl = rateLimit(`changepw:user:${session.userId}`, 60 * 1000, 5)
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const { currentPassword, newPassword } = await parseBody(req, changePasswordSchema)

    const user = await db.user.findUnique({ where: { id: session.userId } })
    if (!user) throw new ApiError(401, '请先登录', 'UNAUTHORIZED')

    const passwordOk = await verifyPassword(currentPassword, user.passwordHash)
    if (!passwordOk) throw new ApiError(401, '当前密码错误', 'INVALID_CREDENTIALS')

    // 新密码不能与当前密码相同(M-45):后端无明文,用"新密码能通过旧 hash 验证"判定
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new ApiError(400, '新密码不能与当前密码相同', 'VALIDATION_ERROR')
    }

    const passwordHash = await hashPassword(newPassword)
    const passwordChangedAt = new Date()
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordChangedAt },
    })

    // 当前会话补发新 token(签发时间不早于 passwordChangedAt,不会被自己踢掉)
    const token = signToken({ userId: user.id, username: user.username, isAdmin: user.isAdmin })
    await setSessionCookie(token)

    return ok({ ok: true })
  } catch (e) {
    return handleApiError(e)
  }
}
