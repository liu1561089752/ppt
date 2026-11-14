/**
 * GET /api/admin/announcements
 * POST /api/admin/announcements
 *
 * - GET: 公告列表(分页,默认按 pinned desc + createdAt desc)
 * - POST: 创建公告 body: { title, content, type='info', pinned=false }
 * - 全部 requireAdmin
 * - POST 写 AuditLog
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { ok, handleApiError, ApiError, parseBody, paginate } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const VALID_TYPES = ['info', 'warning', 'success'] as const
type AnnType = (typeof VALID_TYPES)[number]

const createSchema = z.object({
  title: z.string().min(1, '标题必填').max(200, '标题最多 200 字'),
  content: z.string().min(1, '内容必填').max(5000, '内容最多 5000 字'),
  type: z.enum(VALID_TYPES).default('info'),
  pinned: z.boolean().default(false),
})

export async function GET(req: Request | NextRequest) {
  try {
    const session = await requireAdmin()

    // 轻限流:admin 读 120/min/user
    const rl = rateLimit(`admin:${session.userId}`, 60 * 1000, 120)
    if (!rl.ok) throw new ApiError(429, '请求过于频繁,请稍后再试', 'RATE_LIMITED')

    const { page, pageSize } = paginate(req.url)

    // 列表所有公告(含 active=false),管理员能看历史
    const [total, items] = await Promise.all([
      db.announcement.count(),
      db.announcement.findMany({
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return ok({
      items: items.map((a) => ({
        id: a.id,
        title: a.title,
        content: a.content,
        type: a.type,
        pinned: a.pinned,
        active: a.active,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    })
  } catch (e) {
    return handleApiError(e)
  }
}

export async function POST(req: Request | NextRequest) {
  try {
    const session = await requireAdmin()

    // 轻限流:admin 写 30/min/user(写操作配额外低档)
    const rl = rateLimit(`adminw:${session.userId}`, 60 * 1000, 30)
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const { title, content, type, pinned } = await parseBody(req, createSchema)

    const ann = await db.announcement.create({
      data: { title, content, type: type as AnnType, pinned, active: true },
    })

    await db.auditLog.create({
      data: {
        adminId: session.userId,
        action: 'create_announcement',
        target: ann.id,
        detail: JSON.stringify({ title, type, pinned }),
      },
    })

    return ok(
      {
        id: ann.id,
        title: ann.title,
        content: ann.content,
        type: ann.type,
        pinned: ann.pinned,
        active: ann.active,
        createdAt: ann.createdAt.toISOString(),
        updatedAt: ann.updatedAt.toISOString(),
      },
      201,
    )
  } catch (e) {
    return handleApiError(e)
  }
}
