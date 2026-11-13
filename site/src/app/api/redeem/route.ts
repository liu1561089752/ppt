/**
 * POST /api/redeem
 * 用户兑换卡密
 *
 * - body: { code: string, xianyuOrderNo?: string }
 * - 限流: 同用户 10/h + 同 IP 30/h (CONFIG.RATE_LIMIT.redeem)
 * - 标准化卡密 → 格式校验(失败 → CARD_INVALID)
 * - 事务内 updateMany 原子占用 card (status: unused → used)
 *   count=0 时再查一次区分"无效" vs "过期" vs "已使用"
 * - 加用户余额 + 写 redemption + 写 credit_change
 * - 返回 { success, credits, newBalance, card: { code, credits } }
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { normalizeCardCode, isValidCardCodeFormat } from '@/lib/card-code'
import { requireUser } from '@/lib/session'
import { rateLimit } from '@/lib/rate-limit'
import { ok, err, handleApiError, getClientIp, parseBody } from '@/lib/api-utils'

const redeemSchema = z.object({
  code: z.string().min(1, '请输入卡密').max(64, '卡密过长'),
  xianyuOrderNo: z.string().max(64).optional(),
})

export async function POST(req: Request | NextRequest) {
  try {
    const clientIp = getClientIp(req as Request)
    const session = await requireUser()

    // 1. 限流(用户 + IP 双键)
    const { windowMs, maxUser, maxIp } = CONFIG.RATE_LIMIT.redeem
    const userLimit = rateLimit(`redeem:user:${session.userId}`, windowMs, maxUser)
    if (!userLimit.ok) {
      return err(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')
    }
    const ipLimit = rateLimit(`redeem:ip:${clientIp}`, windowMs, maxIp)
    if (!ipLimit.ok) {
      return err(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')
    }

    // 2. 解析 + 校验
    const { code, xianyuOrderNo } = await parseBody(req, redeemSchema, (raw) => {
      if (typeof raw.code === 'string') raw.code = raw.code.trim()
    })

    // 3. 标准化卡密 + 格式校验
    const normalized = normalizeCardCode(code)
    if (!normalized || !isValidCardCodeFormat(normalized)) {
      return err(400, '卡密无效或已被使用', 'CARD_INVALID')
    }

    // 4. 事务: 原子兑换
    const result = await db.$transaction(async (tx) => {
      const now = new Date()
      // 原子占用: 只有 unused 且未过期 才能被更新
      const updateRes = await tx.card.updateMany({
        where: {
          code: normalized,
          status: 'unused',
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data: {
          status: 'used',
          redeemedBy: session.userId,
          redeemedAt: now,
        },
      })

      if (updateRes.count === 0) {
        // 区分"无效" / "已使用" / "过期"
        const existed = await tx.card.findUnique({ where: { code: normalized } })
        if (!existed || existed.status === 'revoked') {
          throw new Error('CARD_INVALID')
        }
        if (existed.status === 'used') {
          throw new Error('CARD_INVALID')
        }
        // unused 但过期
        throw new Error('CARD_EXPIRED')
      }

      // 取出 card.credits(已被本事务占用,用 findUnique 拿到)
      const card = await tx.card.findUnique({ where: { code: normalized } })
      if (!card) {
        // 极端情况: 刚占用就被删,理论上不会发生
        throw new Error('CARD_INVALID')
      }

      // 加用户余额(select 拿到最新余额)
      const updatedUser = await tx.user.update({
        where: { id: session.userId },
        data: { remainingCredits: { increment: card.credits } },
        select: { remainingCredits: true },
      })

      // 写 redemption 记录
      await tx.redemption.create({
        data: {
          userId: session.userId,
          cardId: card.id,
          credits: card.credits,
          xianyuOrderNo: xianyuOrderNo || null,
        },
      })

      // 写 credit_change 记录(审计)
      await tx.creditChange.create({
        data: {
          userId: session.userId,
          change: card.credits,
          reason: 'redeem',
          balance: updatedUser.remainingCredits,
          remark: `兑换卡密 ${card.code}`,
        },
      })

      return {
        credits: card.credits,
        newBalance: updatedUser.remainingCredits,
        card: { code: card.code, credits: card.credits },
      }
    })

    return ok({
      success: true,
      credits: result.credits,
      newBalance: result.newBalance,
      card: result.card,
    })
  } catch (e) {
    return handleApiError(e)
  }
}
