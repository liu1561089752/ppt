/**
 * POST /api/admin/users/[id]/credits
 * 管理员调整用户次数(可加可减)
 *
 * - body: { change: number, remark?: string }
 * - 事务:
 *   1. 查 user 当前 remainingCredits
 *   2. 计算 newBalance = remainingCredits + change
 *   3. newBalance < 0 → 报错(不能扣成负数)
 *   4. 更新 user.remainingCredits
 *   5. 写 CreditChange(change, reason='admin_adjust', balance=newBalance, remark)
 *   6. 写 AuditLog(action='adjust_credits', target=userId, detail=JSON)
 * - 返回 { newBalance: number }
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { ok, handleApiError, ApiError, parseBody } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const adjustSchema = z.object({
  change: z.number().int().refine((n) => n !== 0, 'change 不能为 0'),
  remark: z.string().max(500).optional(),
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

    const { change, remark } = await parseBody(req, adjustSchema)

    const newBalance = await db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, remainingCredits: true, username: true, isAdmin: true },
      })
      if (!user) {
        throw new ApiError(404, '用户不存在', 'VALIDATION_ERROR')
      }
      // M-57:管理员账号不参与余额调整(含自我调整)。理由:管理员余额走人工
      // 运维通道;对 isAdmin 账号加/扣会污染审计口径,且"给自己加次数"若被
      // 误用等于绕过卡密发放流程。与 ban/reset-password 的护栏同一口径。
      if (user.isAdmin) {
        throw new ApiError(400, '不能对管理员执行此操作', 'VALIDATION_ERROR')
      }

      const after = user.remainingCredits + change
      if (after < 0) {
        throw new ApiError(
          400,
          `调整后余额为 ${after},不能扣成负数(当前 ${user.remainingCredits})`,
          'VALIDATION_ERROR',
        )
      }

      await tx.user.update({
        where: { id: userId },
        data: { remainingCredits: after },
      })

      await tx.creditChange.create({
        data: {
          userId,
          change,
          reason: 'admin_adjust',
          balance: after,
          remark: remark || null,
        },
      })

      await tx.auditLog.create({
        data: {
          adminId: session.userId,
          action: 'adjust_credits',
          target: userId,
          detail: JSON.stringify({
            username: user.username,
            change,
            before: user.remainingCredits,
            after,
            remark: remark || null,
          }),
        },
      })

      return after
    })

    return ok({ newBalance })
  } catch (e) {
    return handleApiError(e)
  }
}
