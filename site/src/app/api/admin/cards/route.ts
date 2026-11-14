/**
 * GET /api/admin/cards
 * 管理员查询卡密列表(分页 + 筛选)
 *
 * - query: ?status=unused|used|revoked&batchId=xxx&page=1&pageSize=20&q=code模糊
 * - 返回 { items: [...], total, page, pageSize }
 * - 列表字段: code, credits, status, batchNo, expiresAt, redeemedBy(username), redeemedAt, createdAt
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { ok, err, handleApiError, ApiError, paginate } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const VALID_STATUS = ['unused', 'used', 'revoked'] as const
type CardStatus = (typeof VALID_STATUS)[number]

function parseStatus(s: string | null): CardStatus | undefined {
  if (!s) return undefined
  if (VALID_STATUS.includes(s as CardStatus)) return s as CardStatus
  return undefined
}

export async function GET(req: Request | NextRequest) {
  try {
    const session = await requireAdmin()

    // 轻限流:admin 读 120/min/user
    const rl = rateLimit(`admin:${session.userId}`, 60 * 1000, 120)
    if (!rl.ok) throw new ApiError(429, '请求过于频繁,请稍后再试', 'RATE_LIMITED')

    const url = new URL(req.url)
    // 非法 status 显式 400(M-114):此前静默吞掉导致筛选参数被忽略、返回全量
    const statusParam = url.searchParams.get('status')
    if (statusParam && parseStatus(statusParam) === undefined) {
      return err(400, 'status 参数无效(仅支持 unused / used / revoked)', 'VALIDATION_ERROR')
    }
    const status = parseStatus(statusParam)
    const batchId = url.searchParams.get('batchId') || undefined
    const q = url.searchParams.get('q')?.trim() || undefined
    const { page, pageSize, skip, take } = paginate(req.url)

    const where = {
      ...(status ? { status } : {}),
      ...(batchId ? { batchId } : {}),
      ...(q ? { code: { contains: q } } : {}),
    }

    const [total, cards] = await Promise.all([
      db.card.count({ where }),
      db.card.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          batch: { select: { batchNo: true } },
          redeemedByUser: { select: { username: true } },
        },
      }),
    ])

    const items = cards.map((c) => ({
      id: c.id,
      code: c.code,
      credits: c.credits,
      status: c.status,
      batchNo: c.batch?.batchNo ?? null,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      redeemedBy: c.redeemedByUser?.username ?? null,
      redeemedAt: c.redeemedAt ? c.redeemedAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
    }))

    return ok({ items, total, page, pageSize })
  } catch (e) {
    return handleApiError(e)
  }
}
