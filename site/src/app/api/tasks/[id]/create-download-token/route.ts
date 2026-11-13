/**
 * POST /api/tasks/[id]/create-download-token
 * 为指定任务创建下载 token(1 小时有效)
 *
 * - 必须登录
 * - 鉴权: task.userId === current user
 * - 必须 status === 'succeeded'
 * - token: 32 hex 字符 = crypto.randomBytes(16).toString('hex')(128 bit 熵)
 * - 限时多次:30 分钟内可重复下载,刻意设计(部分移动端浏览器会对下载链接
 *   预取探测,一次性 token 会被预取消耗导致真正下载失败)
 * - 返回 { token, expiresAt, downloadUrl }
 */
import { NextRequest } from 'next/server'
import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { requireUser } from '@/lib/session'
import { ok, handleApiError, ApiError, assertTaskOwner } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

export async function POST(
  req: Request | NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireUser()
    const { id } = await params

    // 签发限流,防止刷表
    const rl = rateLimit(
      `dltoken:${session.userId}`,
      CONFIG.RATE_LIMIT.downloadToken.windowMs,
      CONFIG.RATE_LIMIT.downloadToken.max,
    )
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const task = await assertTaskOwner(id, session)

    if (task.status !== 'succeeded') {
      throw new ApiError(409, '任务尚未完成,无法下载', 'TASK_NOT_READY')
    }
    if (!task.resultFile) {
      throw new ApiError(409, '任务尚未完成,无法下载', 'TASK_NOT_READY')
    }

    // 32 hex 字符(128 bit 熵,足够防猜测);1 小时有效、限时多次(见头注释)
    const token = randomBytes(16).toString('hex')

    const expiresAt = new Date(Date.now() + CONFIG.DOWNLOAD.tokenExpiresMs)

    await db.downloadToken.create({
      data: {
        taskId: task.id,
        token,
        expiresAt,
      },
    })

    return ok({
      token,
      expiresAt: expiresAt.toISOString(),
      downloadUrl: `/api/download/${task.id}?token=${encodeURIComponent(token)}`,
    })
  } catch (e) {
    return handleApiError(e)
  }
}
