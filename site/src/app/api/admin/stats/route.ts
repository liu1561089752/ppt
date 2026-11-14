/**
 * GET /api/admin/stats
 * 管理员综合统计仪表盘
 *
 * - cards: { total, used, unused, revoked, expired, redemptionRate, totalCreditsIssued, totalCreditsRedeemed }
 * - users: { total, active, banned, newToday, newThisWeek }
 * - tasks: { total, succeeded, failed, refunded, pending, processing, successRate, avgDurationMs, totalToday }
 * - cost: { totalTokens, totalCreditsConsumed }  ← token 来自任务表累计,无 LLM 单价数据源故不含金额
 * - revenue: { totalRedeemedCredits, cardsSoldByFaceValue: [{ credits, count }] }  ← 只展示真实售卡数据
 *
 * 定义:
 * - expired = status='unused' 且 expiresAt < now(不含 expiresAt=null 永久卡)
 * - redemptionRate = used / total
 * - totalCreditsIssued = sum of all card.credits
 * - totalCreditsRedeemed = sum of card.credits where status='used'
 * - successRate = succeeded / total (0 兜底)
 * - avgDurationMs = avg(durationMs) where status='succeeded' (null 兜底为 0)
 * - totalTokens = sum(promptTokens + completionTokens) across tasks(管线 addUsage 累计)
 * - totalCreditsConsumed = sum of creditsUsed across all tasks(已发起的生成次数)
 * - newToday = createdAt >= 今天 0 点;newThisWeek = createdAt >= 7 天前
 */
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/session'
import { ok, handleApiError, ApiError } from '@/lib/api-utils'
import { rateLimit } from '@/lib/rate-limit'

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export async function GET(_req: Request | NextRequest) {
  try {
    const session = await requireAdmin()

    // 轻限流:admin 读 120/min/user(stats 聚合查询最重,13 个并发查询)
    const rl = rateLimit(`admin:${session.userId}`, 60 * 1000, 120)
    if (!rl.ok) throw new ApiError(429, '请求过于频繁,请稍后再试', 'RATE_LIMITED')

    const now = new Date()
    const todayStart = startOfDay(now)
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    // 并发跑各维度统计
    const [
      cardStatusGroups,
      expiredCount,
      totalUsers,
      activeUsers,
      bannedUsers,
      newTodayUsers,
      newThisWeekUsers,
      taskStatusGroups,
      taskDurationAgg,
      totalTodayTasks,
      taskCreditsAgg,
      tokenAgg,
      soldByFace,
    ] = await Promise.all([
      // 1. 卡密按 status 分组(含 _count + _sum.credits)
      db.card.groupBy({
        by: ['status'],
        _count: true,
        _sum: { credits: true },
      }),
      // 2. 已过期卡密数(status='unused' 且 expiresAt < now)
      db.card.count({
        where: { status: 'unused', expiresAt: { lt: now } },
      }),
      // 3. 用户统计
      db.user.count(),
      db.user.count({ where: { isActive: true } }),
      db.user.count({ where: { isActive: false } }),
      db.user.count({ where: { createdAt: { gte: todayStart } } }),
      db.user.count({ where: { createdAt: { gte: weekAgo } } }),
      // 4. 任务按 status 分组
      db.generationTask.groupBy({
        by: ['status'],
        _count: true,
      }),
      // 5. 任务平均时长(仅 succeeded)
      db.generationTask.aggregate({
        where: { status: 'succeeded' },
        _avg: { durationMs: true },
      }),
      // 6. 今日任务总数
      db.generationTask.count({ where: { createdAt: { gte: todayStart } } }),
      // 7. 所有任务 creditsUsed 求和(totalCreditsConsumed)
      db.generationTask.aggregate({
        _sum: { creditsUsed: true },
      }),
      // 8. 任务表 token 聚合(管线 addUsage 累计的真实用量)
      db.generationTask.aggregate({
        _sum: {
          promptTokens: true,
          completionTokens: true,
        },
      }),
      // 9. 已售卡密按面值分组
      db.card.groupBy({
        by: ['credits'],
        where: { status: 'used' },
        _count: true,
        _sum: { credits: true },
      }),
    ])

    // 卡密汇总
    let cardsTotal = 0
    let cardsUsed = 0
    let cardsUnused = 0
    let cardsRevoked = 0
    let totalCreditsIssued = 0
    let totalCreditsRedeemed = 0
    for (const g of cardStatusGroups) {
      cardsTotal += g._count
      const creditsSum = g._sum.credits || 0
      totalCreditsIssued += creditsSum
      if (g.status === 'used') {
        cardsUsed = g._count
        totalCreditsRedeemed = creditsSum
      } else if (g.status === 'unused') {
        cardsUnused = g._count
      } else if (g.status === 'revoked') {
        cardsRevoked = g._count
      }
    }
    const cardsExpired = expiredCount
    const redemptionRate = cardsTotal > 0 ? cardsUsed / cardsTotal : 0

    // 任务汇总
    let tasksTotal = 0
    let tasksSucceeded = 0
    let tasksFailed = 0
    let tasksRefunded = 0
    let tasksPending = 0
    let tasksProcessing = 0
    for (const g of taskStatusGroups) {
      tasksTotal += g._count
      if (g.status === 'succeeded') tasksSucceeded = g._count
      else if (g.status === 'failed') tasksFailed = g._count
      else if (g.status === 'refunded') tasksRefunded = g._count
      else if (g.status === 'pending') tasksPending = g._count
      else if (g.status === 'processing') tasksProcessing = g._count
    }
    const successRate = tasksTotal > 0 ? tasksSucceeded / tasksTotal : 0
    const avgDurationMs = taskDurationAgg._avg.durationMs ?? 0

    // 成本汇总(token 为真实累计;金额无 LLM 单价数据源,不展示假数据)
    const totalTokens = (tokenAgg._sum.promptTokens || 0) + (tokenAgg._sum.completionTokens || 0)
    const totalCreditsConsumed = taskCreditsAgg._sum.creditsUsed || 0

    // 售卡数据(真实)
    const cardsSoldByFaceValue = soldByFace
      .map((g) => ({ credits: g.credits, count: g._count }))
      .sort((a, b) => a.credits - b.credits)

    return ok({
      cards: {
        total: cardsTotal,
        used: cardsUsed,
        unused: cardsUnused,
        revoked: cardsRevoked,
        expired: cardsExpired,
        redemptionRate,
        totalCreditsIssued,
        totalCreditsRedeemed,
      },
      users: {
        total: totalUsers,
        active: activeUsers,
        banned: bannedUsers,
        newToday: newTodayUsers,
        newThisWeek: newThisWeekUsers,
      },
      tasks: {
        total: tasksTotal,
        succeeded: tasksSucceeded,
        failed: tasksFailed,
        refunded: tasksRefunded,
        pending: tasksPending,
        processing: tasksProcessing,
        successRate,
        avgDurationMs,
        totalToday: totalTodayTasks,
      },
      cost: {
        totalTokens,
        totalCreditsConsumed,
      },
      revenue: {
        totalRedeemedCredits: totalCreditsRedeemed,
        cardsSoldByFaceValue,
      },
    })
  } catch (e) {
    return handleApiError(e)
  }
}
