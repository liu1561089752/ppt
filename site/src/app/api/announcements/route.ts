/**
 * GET /api/announcements
 *
 * 公开接口(无需登录):
 * - 返回当前 active=true 的公告列表
 * - 按 pinned desc + createdAt desc 排序
 *
 * 与 /api/admin/announcements 区别:
 *   - 该接口仅返回 active 公告(管理员才看 active=false 历史)
 *   - 该接口无需鉴权,任何人(含未登录)都可访问
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { ok, handleApiError } from '@/lib/api-utils'

export async function GET(_req: Request | NextRequest) {
  try {
    // 仅返回 active=true 公告,pinned 优先,然后按创建时间倒序
    const items = await db.announcement.findMany({
      where: { active: true },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 50, // 最多 50 条,防止公告爆炸
    })

    return ok({
      items: items.map((a) => ({
        id: a.id,
        title: a.title,
        content: a.content,
        type: a.type,
        pinned: a.pinned,
        createdAt: a.createdAt.toISOString(),
      })),
    })
  } catch (e) {
    return handleApiError(e)
  }
}
