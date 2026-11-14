/**
 * 维护任务:僵尸任务清扫 + 过期数据清理。
 * 由 src/instrumentation.ts 在服务启动时注册;
 * src/lib/db.ts 末尾另有动态 import 兜底(standalone 未收录 instrumentation 时),
 * 两钩子靠本文件的 globalThis.__chatpptMaintenance 旗标幂等。
 *
 * - 僵尸清扫:进程崩溃/重启导致永久停留在进行中状态的任务,超时后自动退款
 * - 产物清理:超过保留期的 data/generated 任务目录(slides + pptx)
 * - 令牌清理:过期 DownloadToken
 * - 事件清理:已完结任务 90 天前的 ChatMessage
 */
import { db } from './db'
import { cleanupOldFiles } from './file-storage'
import { refundTask, FINAL_STATUSES } from '@/lib/pipeline/credits'
import { CONFIG } from './config'

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000
/** 已完结任务事件保留天数 */
const MESSAGE_RETENTION_DAYS = 90

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

/** 清扫卡死的进行中任务(崩溃/重启残留),自动退款 */
export async function sweepZombieTasks(): Promise<{ swept: number; refundFailed: number }> {
  // 2 倍任务超时才判定为僵尸,避免误杀慢任务
  // 僵尸判定:任务表无页数上下文,用保守上限(6 页典型任务 2 倍 ≈ 基数 2 倍)
  const timeoutMs = CONFIG.GENERATE.taskTimeoutBaseMs + 25 * CONFIG.GENERATE.taskTimeoutPerSlideMs
  const cutoff = new Date(Date.now() - timeoutMs * 1.2)
  const zombies = await db.generationTask.findMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, createdAt: { lt: cutoff } }],
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' }, // 稳定排序:take 50 不再饿死同一批任务
    take: 50,
  })
  let refundFailed = 0
  const failedIds: string[] = []
  for (const t of zombies) {
    console.warn('[maintenance] 清扫僵尸任务:', t.id)
    const ok = await refundTask(t.id, '任务超时(服务可能中断过),已自动退款')
    if (!ok) {
      refundFailed++
      failedIds.push(t.id)
    }
  }
  // 退款失败必须可见(便于以后接告警):数量 + 明细 taskId
  if (refundFailed > 0) {
    console.warn(`[maintenance] 僵尸清扫退款失败 ${refundFailed} 例:`, failedIds.join(', '))
  }
  return { swept: zombies.length, refundFailed }
}

/** 每日数据清理 */
async function cleanupData(): Promise<void> {
  try {
    await cleanupOldFiles()
  } catch (e) {
    console.warn('[maintenance] 产物清理失败:', (e as Error).message)
  }
  try {
    const removedTokens = await db.downloadToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    })
    const msgCutoff = new Date(Date.now() - MESSAGE_RETENTION_DAYS * DAY_MS)
    const removedMsgs = await db.chatMessage.deleteMany({
      where: {
        task: { status: { in: FINAL_STATUSES } },
        createdAt: { lt: msgCutoff },
      },
    })
    if (removedTokens.count || removedMsgs.count) {
      console.log(`[maintenance] 清理过期下载 token ${removedTokens.count} 条,历史事件 ${removedMsgs.count} 条`)
    }
  } catch (e) {
    console.warn('[maintenance] 数据清理失败:', (e as Error).message)
  }
}

/** 服务启动时注册;进程内幂等(热重载/多实例只挂一套) */
export function bootstrapMaintenance(): void {
  const g = globalThis as { __chatpptMaintenance?: boolean }
  if (g.__chatpptMaintenance) return
  g.__chatpptMaintenance = true

  // 启动后 15 秒做首轮清扫,避开启动高峰
  setTimeout(() => {
    sweepZombieTasks().catch((e) => console.warn('[maintenance] 僵尸清扫失败:', (e as Error).message))
  }, 15_000).unref?.()

  // 僵尸清扫每 5 分钟(查询廉价,及时退款)
  setInterval(() => {
    sweepZombieTasks().catch((e) => console.warn('[maintenance] 僵尸清扫失败:', (e as Error).message))
  }, 5 * MINUTE_MS).unref?.()

  // 数据清理每日一次
  setInterval(() => {
    cleanupData()
  }, DAY_MS).unref?.()

  console.log('[maintenance] 维护任务已注册(僵尸清扫 5min / 数据清理 24h)')
}
