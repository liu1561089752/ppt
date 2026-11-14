/**
 * POST /api/tasks/[id]/cancel
 * 手动取消进行中的任务(登录 + 本人任务)
 *
 * - 仅允许取消进行中的任务(pending/generating/finalizing 等)
 * - 复用管线 settleTaskCredits:事务内退次数 + 置 cancelled + 写账本 + 发事件
 * - 取消后管线的后续写入会被终态守卫忽略
 */
import { NextRequest } from 'next/server'
import { requireUser } from '@/lib/session'
import { ok, handleApiError, ApiError, assertTaskOwner } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'
import { settleTaskCredits } from '@/lib/pipeline'

const ACTIVE_STATUSES = [
  'pending',
  'starting',
  'question_pending',
  'answering',
  'generating',
  'finalizing',
  'stage1',
  'stage2',
  'stage3',
  'stage4',
  'processing',
]

export async function POST(
  req: Request | NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireUser()
    const { id } = await params

    // 轻限流:防止高频刷取消接口反复触发结算查询(10 次/分钟/用户)
    const rl = rateLimit(`cancel:${session.userId}`, 60 * 1000, 10)
    if (!rl.ok) throw new ApiError(429, '操作过于频繁,请稍后再试', 'RATE_LIMITED')

    const task = await assertTaskOwner(id, session)
    if (!ACTIVE_STATUSES.includes(task.status)) {
      throw new ApiError(409, '任务已结束,无需取消', 'TASK_NOT_READY')
    }

    const settled = await settleTaskCredits(
      id,
      'cancelled',
      '用户手动取消',
      '已手动取消',
      `手动取消: ${task.topic.slice(0, 40)}`,
    )
    if (!settled) throw new ApiError(409, '任务已结束,无需取消', 'TASK_NOT_READY')

    return ok({ ok: true })
  } catch (e) {
    return handleApiError(e)
  }
}
