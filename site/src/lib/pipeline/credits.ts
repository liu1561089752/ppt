/**
 * pipeline/credits.ts — 积分结算(退款/取消共用一份账务实现)
 *
 * - 幂等:已是终态的任务返回 false,保证不重复退款
 * - 事务内完成:退积分 + 置终态 + 写账本,随后发事件
 */
import { db } from '@/lib/db'
import { emitEvent } from './events'
import { FINAL_STATUSES } from './types'

export { FINAL_STATUSES }

export async function settleTaskCredits(
  taskId: string,
  finalStatus: 'refunded' | 'cancelled',
  errorMessage: string,
  progressStage: string,
  remark: string,
): Promise<boolean> {
  // 先查一次仅用于拿 userId/creditsUsed(存在但已终态 → 不重复退款)
  const task = await db.generationTask.findUnique({ where: { id: taskId } })
  if (!task || FINAL_STATUSES.includes(task.status)) return false
  await db.$transaction(async (tx) => {
    // 终态守卫(M-11 核心):置终态用 updateMany 带 notIn 条件,count===0 说明
    // 并发方已结算过,直接放弃,杜绝事务外检查与写入之间的窗口导致双退
    const claimed = await tx.generationTask.updateMany({
      where: { id: taskId, status: { notIn: FINAL_STATUSES } },
      data: { status: finalStatus, errorMessage, progressStage, finishedAt: new Date() },
    })
    if (claimed.count === 0) return
    // 退款 update 用条件写(带 status 守卫):守卫不满足(已被并发结算)不退分
    const refunded = await tx.user.updateMany({
      where: { id: task.userId },
      data: { remainingCredits: { increment: task.creditsUsed } },
    })
    if (refunded.count === 0) return
    const user = await tx.user.findUnique({ where: { id: task.userId }, select: { remainingCredits: true } })
    await tx.creditChange.create({
      data: {
        userId: task.userId,
        taskId,
        change: task.creditsUsed,
        reason: 'refund',
        balance: user?.remainingCredits ?? 0,
        remark,
      },
    })
  })
  // 事件迟到无害:前端按 status 判定,重复 status 事件幂等
  await emitEvent(taskId, 'status', { status: finalStatus, stage: progressStage, message: errorMessage })
  return true
}

/** 失败退款(管线异常/超时/僵尸清扫共用);返回是否真正完成结算 */
export async function refundTask(taskId: string, errorMessage: string): Promise<boolean> {
  try {
    return await settleTaskCredits(taskId, 'refunded', errorMessage, '失败已退款', '生成失败自动退款')
  } catch (e) {
    console.error('[pipeline] 退款失败:', e)
    return false
  }
}
