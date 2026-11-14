/**
 * POST /api/admin/cards/generate
 * 管理员生成卡密批次
 *
 * - body: { credits, quantity, expiresAt?(ISO), remark? }
 * - 校验: credits 1-100, quantity 1-1000
 * - 批次号: BATCH-yyyymmdd-random6 (e.g. BATCH-20240101-A3F9K2)
 * - 事务:
 *   1. 内存生成 quantity 个全局唯一 code(去重 + 查库 + 最多重试 5 轮)
 *   2. 创建 CardBatch
 *   3. createMany 批量插入 Card(继承批次 expiresAt)
 *   4. 写 AuditLog
 * - 返回 { batchNo, quantity, credits, cards: [{ code, credits }] }
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { generateCardCode } from '@/lib/card-code-gen'
import { requireAdmin } from '@/lib/session'
import { ok, handleApiError, ApiError, parseBody } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const generateSchema = z.object({
  credits: z.number().int().min(1, '面额最少 1').max(100, '面额最多 100'),
  quantity: z.number().int().min(1, '数量最少 1').max(1000, '单批最多 1000 张'),
  expiresAt: z.string().optional(),
  remark: z.string().max(500).optional(),
})

function yyyymmdd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function random6(): string {
  // Crockford Base32 6 字符,~10亿空间,日批次碰撞概率极低
  const charset = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
  let s = ''
  for (let i = 0; i < 6; i++) {
    s += charset[Math.floor(Math.random() * charset.length)]
  }
  return s
}

function generateBatchNo(): string {
  return `BATCH-${yyyymmdd(new Date())}-${random6()}`
}

/**
 * 生成 quantity 个全局唯一卡密:每轮"批量生成 → 内存去重 → 查库去重",
 * 不足则加倍补生成,最多 5 轮(Crockford 32^16 空间下通常一轮即够)。
 */
async function generateUniqueCodes(quantity: number): Promise<string[]> {
  const seen = new Set<string>()
  const unique: string[] = []
  const MAX_ROUNDS = 5
  for (let round = 0; round < MAX_ROUNDS && unique.length < quantity; round++) {
    const need = quantity - unique.length
    const target = round === 0 ? Math.ceil(need * 1.1) : need * 2
    const batch: string[] = []
    let attempts = 0
    while (batch.length < target && attempts < target * 10) {
      const c = generateCardCode()
      attempts++
      if (!seen.has(c)) {
        seen.add(c)
        batch.push(c)
      }
    }
    const existing = await db.card.findMany({
      where: { code: { in: batch } },
      select: { code: true },
    })
    const existingSet = new Set(existing.map((c) => c.code))
    for (const c of batch) {
      if (!existingSet.has(c)) {
        unique.push(c)
        if (unique.length >= quantity) break
      }
    }
  }
  return unique.slice(0, quantity)
}

export async function POST(req: Request | NextRequest) {
  try {
    const session = await requireAdmin()

    // 轻限流:admin 写 30/min/user(生成批次要查库去重+事务插入,重操作)
    const rl = rateLimit(`adminw:${session.userId}`, 60 * 1000, 30)
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const { credits, quantity, remark, expiresAt: expiresAtRaw } = await parseBody(req, generateSchema)

    // 解析 expiresAt
    let expiresAt: Date | null = null
    if (expiresAtRaw) {
      const d = new Date(expiresAtRaw)
      if (isNaN(d.getTime())) {
        throw new ApiError(400, '过期时间格式无效', 'VALIDATION_ERROR')
      }
      expiresAt = d
    }

    // 生成批次号(若冲突则重试)
    let batchNo = generateBatchNo()
    for (let i = 0; i < 5; i++) {
      const existed = await db.cardBatch.findUnique({ where: { batchNo } })
      if (!existed) break
      batchNo = generateBatchNo()
    }

    const codes = await generateUniqueCodes(quantity)
    if (codes.length < quantity) {
      throw new ApiError(500, '卡密生成失败,请重试', 'INTERNAL')
    }

    // 事务: 创建批次 + 批量插入卡密 + 写审计日志
    const result = await db.$transaction(async (tx) => {
      const batch = await tx.cardBatch.create({
        data: {
          batchNo,
          credits,
          quantity,
          remark: remark || null,
          expiresAt,
          createdById: session.userId,
        },
      })

      await tx.card.createMany({
        data: codes.map((code) => ({
          code,
          credits,
          batchId: batch.id,
          expiresAt,
        })),
      })

      await tx.auditLog.create({
        data: {
          adminId: session.userId,
          action: 'generate_cards',
          target: batchNo,
          detail: JSON.stringify({
            batchId: batch.id,
            credits,
            quantity,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
            remark: remark || null,
          }),
        },
      })

      return batch
    })

    const cards = codes.map((code) => ({ code, credits }))

    return ok({
      batchNo: result.batchNo,
      quantity: result.quantity,
      credits: result.credits,
      cards,
    })
  } catch (e) {
    return handleApiError(e)
  }
}
