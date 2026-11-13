/**
 * pipeline/events.ts — 进度写入与对话事件流
 *
 * - 终态守卫:任务已结束(退款/取消/超时)后,迟到的阶段写入不得复活任务
 * - emitEvent 供管线各阶段与结算模块共用;seq 用 aggregate+create 分配,
 *   并发渲染可能撞唯一约束——捕获后重读重试
 */
import { db } from '@/lib/db'
import { FINAL_STATUSES } from './types'

export async function setProgress(taskId: string, status: string, progress: number, stage: string): Promise<void> {
  await db.generationTask
    .updateMany({
      where: { id: taskId, status: { notIn: FINAL_STATUSES } },
      data: { status, progress, progressStage: stage },
    })
    .catch(() => {})
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code?: string }).code === 'P2002'
}

/**
 * 终态 status 事件去重(H11/M-96):同一 taskId + 同一终态 status 只进时间线一次。
 * 进程内存 Map,重启清空无害——重启后迟到终态事件再发一次也可接受。
 * 退款/取消/成功的最后一条状态行因此能进对话页,且不会重复刷屏。
 */
const finalStatusEmitted = new Map<string, string>()

export async function emitEvent(taskId: string, type: string, payload: unknown): Promise<void> {
  try {
    if (type === 'status') {
      const t = await db.generationTask.findUnique({ where: { id: taskId }, select: { status: true } })
      if (t && FINAL_STATUSES.includes(t.status)) {
        // 任务已终态:仅放行与当前终态一致的状态事件,且每对 (taskId, status) 只放行一次
        const p = payload as { status?: string } | null
        if (p?.status !== t.status) return
        if (finalStatusEmitted.get(taskId) === t.status) return
        finalStatusEmitted.set(taskId, t.status)
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const agg = await db.chatMessage.aggregate({ where: { taskId }, _max: { seq: true } })
      const seq = (agg._max.seq ?? 0) + 1
      try {
        await db.chatMessage.create({
          data: { taskId, seq, type, payload: JSON.stringify(payload ?? {}) },
        })
        return
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === 2) throw e
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
      }
    }
  } catch {
    /* 事件失败不影响生成 */
  }
}

/** 累计 token 用量(事务内读改写,SQLite 写锁下并发安全) */
export async function addUsage(taskId: string, prompt: number, completion: number): Promise<void> {
  if (prompt === 0 && completion === 0) return
  try {
    await db.$transaction(async (tx) => {
      const t = await tx.generationTask.findUnique({
        where: { id: taskId },
        select: { promptTokens: true, completionTokens: true },
      })
      await tx.generationTask.update({
        where: { id: taskId },
        data: {
          promptTokens: (t?.promptTokens ?? 0) + prompt,
          completionTokens: (t?.completionTokens ?? 0) + completion,
        },
      })
    })
  } catch {
    /* 忽略 */
  }
}
