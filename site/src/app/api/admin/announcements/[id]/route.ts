/**
 * PUT /api/admin/announcements/[id]
 * DELETE /api/admin/announcements/[id]
 *
 * - PUT: 更新任意字段 { title?, content?, type?, pinned?, active? }
 * - DELETE: 物理删除(我们选删除而非软删除)
 * - 全部 requireAdmin
 * - PUT/DELETE 写 AuditLog
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { ok, handleApiError, ApiError, parseBody } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

const VALID_TYPES = ['info', 'warning', 'success'] as const

const updateSchema = z
  .object({
    title: z.string().min(1, '标题必填').max(200).optional(),
    content: z.string().min(1).max(5000).optional(),
    type: z.enum(VALID_TYPES).optional(),
    pinned: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: '至少需要更新一个字段' })

export async function PUT(
  req: Request | NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAdmin()
    const { id } = await params

    // 轻限流:admin 写 30/min/user
    const rl = rateLimit(`adminw:${session.userId}`, 60 * 1000, 30)
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const patch = await parseBody(req, updateSchema)

    const existing = await db.announcement.findUnique({ where: { id } })
    if (!existing) {
      throw new ApiError(404, '公告不存在', 'VALIDATION_ERROR')
    }

    const updated = await db.announcement.update({
      where: { id },
      data: patch,
    })

    await db.auditLog.create({
      data: {
        adminId: session.userId,
        action: 'update_announcement',
        target: id,
        detail: JSON.stringify({ before: existing, patch }),
      },
    })

    return ok({
      id: updated.id,
      title: updated.title,
      content: updated.content,
      type: updated.type,
      pinned: updated.pinned,
      active: updated.active,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    })
  } catch (e) {
    return handleApiError(e)
  }
}

export async function DELETE(
  req: Request | NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAdmin()
    const { id } = await params

    // 轻限流:admin 写 30/min/user
    const rl = rateLimit(`adminw:${session.userId}`, 60 * 1000, 30)
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const existing = await db.announcement.findUnique({ where: { id } })
    if (!existing) {
      throw new ApiError(404, '公告不存在', 'VALIDATION_ERROR')
    }

    await db.announcement.delete({ where: { id } })

    await db.auditLog.create({
      data: {
        adminId: session.userId,
        action: 'delete_announcement',
        target: id,
        detail: JSON.stringify({ title: existing.title, type: existing.type }),
      },
    })

    return ok({ deleted: true })
  } catch (e) {
    return handleApiError(e)
  }
}
