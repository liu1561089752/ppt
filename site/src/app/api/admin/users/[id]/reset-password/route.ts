/**
 * POST /api/admin/users/[id]/reset-password
 * 管理员重置指定用户的密码
 *
 * - requireAdmin;body { newPassword }
 * - 重置后该用户所有旧会话立即失效(passwordChangedAt)
 * - 写 AuditLog(action: reset_password)
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/password'
import { requireAdmin } from '@/lib/session'
import { ok, handleApiError, ApiError, parseBody } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const resetPasswordSchema = z.object({
  newPassword: z.string().min(6, '新密码长度需为 6-32').max(32, '新密码长度需为 6-32'),
})

export async function POST(
  req: Request | NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAdmin()
    const { id } = await params

    // 轻限流:admin 写 30/min/user
    const rl = rateLimit(`adminw:${session.userId}`, 60 * 1000, 30)
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const { newPassword } = await parseBody(req, resetPasswordSchema)

    const user = await db.user.findUnique({
      where: { id },
      select: { username: true, isAdmin: true },
    })
    if (!user) throw new ApiError(404, '用户不存在', 'TASK_NOT_FOUND')
    // 不能重置管理员密码(M-56):对照 ban 路由同款护栏,防误操作锁死管理后台
    if (user.isAdmin) {
      throw new ApiError(400, '不能对管理员执行此操作', 'VALIDATION_ERROR')
    }

    const passwordHash = await hashPassword(newPassword)
    await db.user.update({
      where: { id },
      data: { passwordHash, passwordChangedAt: new Date() },
    })

    await db.auditLog.create({
      data: {
        adminId: session.userId,
        action: 'reset_password',
        target: user.username,
        detail: JSON.stringify({ userId: id }),
      },
    })

    return ok({ ok: true })
  } catch (e) {
    return handleApiError(e)
  }
}
