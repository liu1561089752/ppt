/**
 * POST /api/admin/cards/revoke
 * 管理员作废卡密(单张 or 整批 二选一)
 *
 * - body: { cardId?: string, batchId?: string }
 * - 单张: status='unused' → 'revoked';已用过的报错(不能作废)
 * - 整批: 把该批次所有 unused 卡密 → revoked
 * - 写 AuditLog
 * - 返回 { revokedCount: number }
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { ok, handleApiError, ApiError, parseBody } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const revokeSchema = z
  .object({
    cardId: z.string().min(1).optional(),
    batchId: z.string().min(1).optional(),
  })
  .refine((d) => (!!d.cardId) !== (!!d.batchId), {
    message: '必须且只能指定 cardId 或 batchId 之一',
  })

export async function POST(req: Request | NextRequest) {
  try {
    const session = await requireAdmin()

    // 轻限流:admin 写 30/min/user
    const rl = rateLimit(`adminw:${session.userId}`, 60 * 1000, 30)
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const { cardId, batchId } = await parseBody(req, revokeSchema)

    let revokedCount = 0
    let target = ''
    let detail: Record<string, unknown> = {}

    await db.$transaction(async (tx) => {
      if (cardId) {
        // 单张作废:必须存在且 unused
        const card = await tx.card.findUnique({ where: { id: cardId } })
        if (!card) {
          throw new ApiError(404, '卡密不存在', 'CARD_INVALID')
        }
        if (card.status === 'used') {
          throw new ApiError(400, '已使用的卡密不能作废', 'CARD_INVALID')
        }
        if (card.status === 'revoked') {
          // 幂等,直接返回 0
          target = card.code
          detail = { cardId, code: card.code, alreadyRevoked: true }
          return
        }
        // 未知状态(M-113):不再静默改写成 revoked,显式 400 让人工核对
        if (card.status !== 'unused') {
          throw new ApiError(400, '卡密状态异常,请人工核对', 'CARD_INVALID')
        }
        await tx.card.update({
          where: { id: cardId },
          data: { status: 'revoked' },
        })
        revokedCount = 1
        target = card.code
        detail = { cardId, code: card.code, batchId: card.batchId }
      } else if (batchId) {
        // 整批作废:把该批次所有 unused → revoked
        const batch = await tx.cardBatch.findUnique({ where: { id: batchId } })
        if (!batch) {
          throw new ApiError(404, '批次不存在', 'CARD_INVALID')
        }
        const res = await tx.card.updateMany({
          where: { batchId, status: 'unused' },
          data: { status: 'revoked' },
        })
        revokedCount = res.count
        target = batch.batchNo
        detail = { batchId, batchNo: batch.batchNo, revokedCount }
      }
    })

    await db.auditLog.create({
      data: {
        adminId: session.userId,
        action: 'revoke_card',
        target,
        detail: JSON.stringify(detail),
      },
    })

    return ok({ revokedCount })
  } catch (e) {
    return handleApiError(e)
  }
}
