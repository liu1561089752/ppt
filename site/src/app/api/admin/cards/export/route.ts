/**
 * GET /api/admin/cards/export
 * 管理员导出卡密为 CSV
 *
 * - query: ?batchId=xxx 或 ?status=unused
 * - Content-Type: text/csv; charset=utf-8
 * - Content-Disposition: attachment; filename="cards-{batchNo}.csv"
 * - BOM 头 (\uFEFF) 开头,Excel 友好
 * - 表头: code,credits,status,batchNo,expiresAt,createdAt
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { err, handleApiError, ApiError } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const VALID_STATUS = ['unused', 'used', 'revoked'] as const
type CardStatus = (typeof VALID_STATUS)[number]

function parseStatus(s: string | null): CardStatus | undefined {
  if (!s) return undefined
  if (VALID_STATUS.includes(s as CardStatus)) return s as CardStatus
  return undefined
}

// CSV 字段转义:含逗号/换行/引号则用双引号包裹,内部双引号翻倍
function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export async function GET(req: Request | NextRequest) {
  try {
    const session = await requireAdmin()

    // 轻限流:admin 读 120/min/user(CSV 导出可能全表扫,防刷)
    const rl = rateLimit(`admin:${session.userId}`, 60 * 1000, 120)
    if (!rl.ok) throw new ApiError(429, '请求过于频繁,请稍后再试', 'RATE_LIMITED')

    const url = new URL(req.url)
    const batchId = url.searchParams.get('batchId')
    const status = parseStatus(url.searchParams.get('status'))

    if (!batchId && !status) {
      return err(400, '请指定 batchId 或 status', 'VALIDATION_ERROR')
    }

    // 确定 where 条件 + 文件名
    let where: { batchId?: string; status?: CardStatus } = {}
    let fileLabel = 'all'

    if (batchId) {
      where = { batchId }
      // 查批次号用于文件名
      const batch = await db.cardBatch.findUnique({
        where: { id: batchId },
        select: { batchNo: true },
      })
      if (!batch) {
        throw new ApiError(404, '批次不存在', 'CARD_INVALID')
      }
      fileLabel = batch.batchNo
    } else if (status) {
      where = { status }
      fileLabel = `status-${status}`
    }

    const cards = await db.card.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { batch: { select: { batchNo: true } } },
    })

    const header = ['code', 'credits', 'status', 'batchNo', 'expiresAt', 'createdAt']
    const lines: string[] = [header.join(',')]

    for (const c of cards) {
      lines.push(
        [
          csvEscape(c.code),
          csvEscape(String(c.credits)),
          csvEscape(c.status),
          csvEscape(c.batch?.batchNo ?? null),
          csvEscape(c.expiresAt ? c.expiresAt.toISOString() : null),
          csvEscape(c.createdAt.toISOString()),
        ].join(','),
      )
    }

    const csvString = '\uFEFF' + lines.join('\r\n')

    return new NextResponse(csvString, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="cards-${fileLabel}.csv"`,
      },
    })
  } catch (e) {
    return handleApiError(e)
  }
}
