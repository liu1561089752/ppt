/**
 * GET /api/generate/[taskId]/events?since=N
 * 增量拉取对话事件(登录 + 本人任务)
 *
 * 前端对话页的数据通道:相比 SSE,HTTP 轮询在各类代理/隧道环境下
 * 不会被缓冲(实测 trycloudflare/cloudflared 会把流式响应攒到结束才发),
 * 1.5s 轮询 + 350ms 批量渲染的体感与推送无差别。
 *
 * 返回: { events: [{seq,type,payload}], status, progressStage, errorMessage }
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { CONFIG } from '@/lib/config'
import { requireUser } from '@/lib/session'
import { ok, handleApiError, ApiError, assertTaskOwner } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  req: Request | NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  try {
    const session = await requireUser()
    const { taskId } = await params

    // 轮询通道限流(正常 1.5s 一次 ≈ 40/min,上限 120/min)
    const rl = rateLimit(
      `events:${session.userId}`,
      CONFIG.RATE_LIMIT.events.windowMs,
      CONFIG.RATE_LIMIT.events.max,
    )
    if (!rl.ok) throw new ApiError(429, '请求过于频繁,请稍后再试', 'RATE_LIMITED')

    const task = await assertTaskOwner(taskId, session)

    const since = Number(new URL(req.url).searchParams.get('since') ?? '0') || 0
    const events = await db.chatMessage.findMany({
      where: { taskId, seq: { gt: since } },
      orderBy: { seq: 'asc' },
      take: 2000,
      select: { seq: true, type: true, payload: true },
    })

    return ok({
      events: events.map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: JSON.parse(e.payload || '{}'),
      })),
      status: task.status,
      progressStage: task.progressStage,
      errorMessage: task.errorMessage,
    })
  } catch (e) {
    return handleApiError(e)
  }
}
