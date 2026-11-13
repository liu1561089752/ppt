/**
 * POST /api/admin/users/[id]/ban
 * 管理员封禁 / 解封用户
 *
 * - body: { banned: boolean }
 * - 不能封禁 isAdmin=true 的用户(防止管理员误封自己/其他管理员)
 * - 更新 user.isActive = !banned
 * - 写 AuditLog(action='ban_user' / 'unban_user', target=userId)
 * - 返回 { isActive: boolean }
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { ok, handleApiError, ApiError, parseBody } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const banSchema = z.object({
  banned: z.boolean(),
})

export async function POST(
  req: Request | NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAdmin()
    const { id: userId } = await params

    // 轻限流:admin 写 30/min/user
    const rl = rateLimit(`adminw:${session.userId}`, 60 * 1000, 30)
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const { banned } = await parseBody(req, banSchema)

    // 不能封禁自己 / 不能封禁其他管理员
    if (userId === session.userId && banned) {
      throw new ApiError(400, '不能封禁自己', 'VALIDATION_ERROR')
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, isActive: true, isAdmin: true },
    })
    if (!user) {
      throw new ApiError(404, '用户不存在', 'VALIDATION_ERROR')
    }
    if (user.isAdmin && banned) {
      throw new ApiError(400, '不能封禁管理员', 'VALIDATION_ERROR')
    }

    const isActive = !banned
    // 单事务完成:封禁 + 吊销未过期下载令牌 + 审计。
    // (M-106:封禁必须同步吊销下载令牌,否则被封用户已签发的 1h 直链仍可用;
    //  M-顺带:审计此前在事务外,崩溃窗口会出现"已封禁但无审计"的不一致。
    //  DownloadToken 表无 userId 字段,经 token→task 关系过滤 task.userId。)
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { isActive },
      })
      if (banned) {
        await tx.downloadToken.deleteMany({
          where: { task: { userId }, expiresAt: { gt: new Date() } },
        })
      }
      await tx.auditLog.create({
        data: {
          adminId: session.userId,
          action: banned ? 'ban_user' : 'unban_user',
          target: userId,
          detail: JSON.stringify({
            username: user.username,
            banned,
            before: user.isActive,
            revokedDownloadTokens: banned,
          }),
        },
      })
    })

    return ok({ isActive })
  } catch (e) {
    return handleApiError(e)
  }
}
