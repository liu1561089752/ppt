/**
 * admin-stats-view.tsx — Task 4-c 管理员后台 · 数据看板
 *
 * 顶部:4 个关键指标摘要 Card(总用户 / 总卡密 / 总任务 / 成功率)
 * 主体:
 *  - 卡密统计:Card + PieChart(状态分布)
 *  - 任务统计:Card + PieChart(状态分布)
 *  - 用户统计:Card + 关键指标
 *  - 成本统计:Card + token / 消耗次数
 *  - 销量统计:已兑换次数 + BarChart(面值销量)
 *
 * 响应式:grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 自适应
 */
'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  BarChart3,
  Users,
  KeyRound,
  FileText,
  Coins,
  TrendingUp,
  CheckCircle2,
  XCircle,
  RefreshCcw,
  Sparkles,
  CalendarDays,
  Cpu,
} from 'lucide-react'
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
} from 'recharts'

import { cn } from '@/lib/utils'
import { apiGet } from '@/lib/api-client'
import { formatDuration } from '@/lib/format'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'

// ----- 类型 -----
interface StatsResponse {
  cards: {
    total: number
    used: number
    unused: number
    revoked: number
    expired: number
    redemptionRate: number
    totalCreditsIssued: number
    totalCreditsRedeemed: number
  }
  users: {
    total: number
    active: number
    banned: number
    newToday: number
    newThisWeek: number
  }
  tasks: {
    total: number
    succeeded: number
    failed: number
    refunded: number
    pending: number
    processing: number
    successRate: number
    avgDurationMs: number
    totalToday: number
  }
  cost: {
    totalTokens: number
    totalCreditsConsumed: number
  }
  revenue: {
    totalRedeemedCredits: number
    cardsSoldByFaceValue: Array<{ credits: number; count: number }>
  }
}

// ----- 工具 -----
function formatNumber(n: number): string {
  return n.toLocaleString('zh-CN')
}

function formatPercent(p: number): string {
  if (!Number.isFinite(p)) return '0%'
  return `${(p * 100).toFixed(1)}%`
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// ----- 图表颜色 -----
const STATUS_COLORS = {
  used: '#10b981', // emerald-500
  unused: '#f59e0b', // amber-500
  revoked: '#94a3b8', // slate-400
}

const TASK_STATUS_COLORS: Record<string, string> = {
  succeeded: '#10b981',
  failed: '#ef4444',
  refunded: '#f43f5e',
  pending: '#f59e0b',
  processing: '#fbbf24',
  cancelled: '#94a3b8',
}

// ----- 摘要卡 -----
interface SummaryCardProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  hint?: string
  tone?: 'primary' | 'amber' | 'emerald' | 'rose' | 'sky'
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'primary',
}: SummaryCardProps) {
  const toneMap = {
    primary: 'bg-primary/10 text-primary',
    amber: 'bg-amber-500/15 text-amber-600',
    emerald: 'bg-emerald-500/15 text-emerald-600',
    rose: 'bg-rose-500/15 text-rose-600',
    sky: 'bg-sky-500/15 text-sky-600',
  }
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
            {hint && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {hint}
              </p>
            )}
          </div>
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              toneMap[tone],
            )}
          >
            <Icon className="size-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ----- Recharts Tooltip 自定义 -----
interface TooltipPayloadItem {
  name?: string
  value?: number | string
  color?: string
  payload?: Record<string, unknown>
}

function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean
  payload?: TooltipPayloadItem[]
  label?: string | number
  formatter?: (value: number, name: string) => string
}) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      {label != null && (
        <p className="mb-1 font-medium text-popover-foreground">{label}</p>
      )}
      {payload.map((p, i) => {
        const name = p.name || ''
        const value =
          typeof p.value === 'number' ? p.value : Number(p.value) || 0
        return (
          <div
            key={`${name}-${i}`}
            className="flex items-center gap-2"
          >
            <span
              className="size-2 rounded-sm"
              style={{ background: p.color }}
            />
            <span className="text-muted-foreground">{name}</span>
            <span className="ml-auto font-medium tabular-nums">
              {formatter ? formatter(value, name) : formatNumber(value)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ----- 主组件 -----
export default function AdminStatsView() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<
    StatsResponse,
    Error
  >({
    queryKey: ['admin', 'stats'],
    queryFn: () => apiGet<StatsResponse>('/api/admin/stats'),
    staleTime: 30_000,
  })

  // 卡密状态饼图数据
  const cardStatusData = data
    ? [
        { name: '已用', value: data.cards.used, key: 'used' },
        { name: '未用', value: data.cards.unused, key: 'unused' },
        { name: '作废', value: data.cards.revoked, key: 'revoked' },
      ]
    : []

  // 任务状态饼图数据
  const taskStatusData = data
    ? [
        { name: '成功', value: data.tasks.succeeded, key: 'succeeded' },
        { name: '失败', value: data.tasks.failed, key: 'failed' },
        { name: '退款', value: data.tasks.refunded, key: 'refunded' },
        { name: '排队', value: data.tasks.pending, key: 'pending' },
        { name: '处理中', value: data.tasks.processing, key: 'processing' },
      ].filter((d) => d.value > 0)
    : []

  // 面值销量 Bar
  const faceValueData = data?.revenue.cardsSoldByFaceValue || []

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8"
    >
      {/* 顶部页头 */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <BarChart3 className="size-5" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              数据看板
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            实时统计:用户、卡密、任务、成本与销量
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 sm:w-auto"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCcw
            className={cn('size-3.5', isFetching && 'animate-spin')}
          />
          刷新
        </Button>
      </div>

      {isError ? (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <XCircle className="size-5" />
            </div>
            <p className="text-sm text-destructive">
              统计加载失败:{error?.message || '请稍后重试'}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCcw
                className={cn('size-3.5', isFetching && 'animate-spin')}
              />
              重试
            </Button>
          </CardContent>
        </Card>
      ) : isLoading || !data ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-80" />
            ))}
          </div>
        </>
      ) : (
        <>
          {/* 摘要 4 卡 */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <SummaryCard
              icon={Users}
              label="总用户"
              value={formatNumber(data.users.total)}
              hint={`今日新增 ${data.users.newToday}`}
              tone="primary"
            />
            <SummaryCard
              icon={KeyRound}
              label="总卡密"
              value={formatNumber(data.cards.total)}
              hint={`已兑换 ${data.cards.used}`}
              tone="amber"
            />
            <SummaryCard
              icon={FileText}
              label="总任务"
              value={formatNumber(data.tasks.total)}
              hint={`今日 ${data.tasks.totalToday}`}
              tone="sky"
            />
            <SummaryCard
              icon={CheckCircle2}
              label="成功率"
              value={formatPercent(data.tasks.successRate)}
              hint={`平均耗时 ${formatDuration(data.tasks.avgDurationMs)}`}
              tone="emerald"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* 卡密统计 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="size-4 text-amber-600" />
                  卡密统计
                </CardTitle>
                <CardDescription>
                  总发放 {formatNumber(data.cards.totalCreditsIssued)} 次 ·
                  已兑换 {formatNumber(data.cards.totalCreditsRedeemed)} 次
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">已用</p>
                    <p className="font-semibold text-emerald-600 tabular-nums">
                      {formatNumber(data.cards.used)}
                    </p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">未用</p>
                    <p className="font-semibold text-amber-600 tabular-nums">
                      {formatNumber(data.cards.unused)}
                    </p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">作废</p>
                    <p className="font-semibold text-muted-foreground tabular-nums">
                      {formatNumber(data.cards.revoked)}
                    </p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">已过期</p>
                    <p className="font-semibold text-rose-600 tabular-nums">
                      {formatNumber(data.cards.expired)}
                    </p>
                  </div>
                  <div className="col-span-2 rounded-md border bg-muted/30 p-2">
                    <p className="text-xs text-muted-foreground">兑换率</p>
                    <p className="font-semibold tabular-nums">
                      {formatPercent(data.cards.redemptionRate)}
                    </p>
                  </div>
                </div>

                {data.cards.total > 0 ? (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={cardStatusData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={50}
                          outerRadius={80}
                          paddingAngle={2}
                        >
                          {cardStatusData.map((entry) => (
                            <Cell
                              key={entry.key}
                              fill={STATUS_COLORS[entry.key as keyof typeof STATUS_COLORS]}
                            />
                          ))}
                        </Pie>
                        <Legend
                          verticalAlign="bottom"
                          height={24}
                          iconType="circle"
                          iconSize={8}
                        />
                        <RechartsTooltip
                          content={<ChartTooltip />}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
                    暂无卡密数据
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 任务统计 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="size-4 text-sky-600" />
                  任务统计
                </CardTitle>
                <CardDescription>
                  成功率 {formatPercent(data.tasks.successRate)} · 平均耗时{' '}
                  {formatDuration(data.tasks.avgDurationMs)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">成功</p>
                    <p className="font-semibold text-emerald-600 tabular-nums">
                      {formatNumber(data.tasks.succeeded)}
                    </p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">失败</p>
                    <p className="font-semibold text-rose-600 tabular-nums">
                      {formatNumber(data.tasks.failed)}
                    </p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">退款</p>
                    <p className="font-semibold text-rose-500 tabular-nums">
                      {formatNumber(data.tasks.refunded)}
                    </p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">排队</p>
                    <p className="font-semibold text-amber-600 tabular-nums">
                      {formatNumber(data.tasks.pending)}
                    </p>
                  </div>
                  <div className="rounded-md border p-2">
                    <p className="text-xs text-muted-foreground">处理中</p>
                    <p className="font-semibold text-amber-500 tabular-nums">
                      {formatNumber(data.tasks.processing)}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-2">
                    <p className="text-xs text-muted-foreground">今日</p>
                    <p className="font-semibold tabular-nums">
                      {formatNumber(data.tasks.totalToday)}
                    </p>
                  </div>
                </div>

                {data.tasks.total > 0 ? (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={taskStatusData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={50}
                          outerRadius={80}
                          paddingAngle={2}
                        >
                          {taskStatusData.map((entry) => (
                            <Cell
                              key={entry.key}
                              fill={TASK_STATUS_COLORS[entry.key] ?? '#94a3b8'}
                            />
                          ))}
                        </Pie>
                        <Legend
                          verticalAlign="bottom"
                          height={24}
                          iconType="circle"
                          iconSize={8}
                        />
                        <RechartsTooltip content={<ChartTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
                    暂无任务数据
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 用户统计 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="size-4 text-primary" />
                  用户统计
                </CardTitle>
                <CardDescription>
                  今日新增 {data.users.newToday} · 本周新增 {data.users.newThisWeek}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <div className="rounded-md border p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Users className="size-3.5" />
                      总用户
                    </div>
                    <p className="mt-1 text-xl font-semibold tabular-nums">
                      {formatNumber(data.users.total)}
                    </p>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <CheckCircle2 className="size-3.5 text-emerald-600" />
                      活跃
                    </div>
                    <p className="mt-1 text-xl font-semibold text-emerald-600 tabular-nums">
                      {formatNumber(data.users.active)}
                    </p>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <XCircle className="size-3.5 text-rose-600" />
                      封禁
                    </div>
                    <p className="mt-1 text-xl font-semibold text-rose-600 tabular-nums">
                      {formatNumber(data.users.banned)}
                    </p>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <CalendarDays className="size-3.5 text-amber-600" />
                      今日新增
                    </div>
                    <p className="mt-1 text-xl font-semibold text-amber-600 tabular-nums">
                      {formatNumber(data.users.newToday)}
                    </p>
                  </div>
                  <div className="col-span-1 rounded-md border p-3 sm:col-span-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Sparkles className="size-3.5 text-amber-600" />
                      本周新增
                    </div>
                    <p className="mt-1 text-xl font-semibold text-amber-600 tabular-nums">
                      {formatNumber(data.users.newThisWeek)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 成本统计 */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Cpu className="size-4 text-sky-600" />
                  成本统计
                </CardTitle>
                <CardDescription>
                  累计消耗 {formatNumber(data.cost.totalCreditsConsumed)} 次
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border p-3">
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Cpu className="size-3.5" />
                      总 Token
                    </p>
                    <p className="mt-1 text-2xl font-bold tabular-nums">
                      {formatTokens(data.cost.totalTokens)}
                    </p>
                  </div>
                  <div className="rounded-md border bg-muted/30 p-3">
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Coins className="size-3.5" />
                      累计消耗次数
                    </p>
                    <p className="mt-1 text-2xl font-bold tabular-nums">
                      {formatNumber(data.cost.totalCreditsConsumed)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 销量统计 */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="size-4 text-emerald-600" />
                  销量统计
                </CardTitle>
                <CardDescription>
                  已兑换次数与卡密按面值销量分布
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-3 rounded-md border bg-muted/30 p-3">
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Coins className="size-3.5" />
                    已兑换次数
                  </p>
                  <p className="mt-1 text-2xl font-bold tabular-nums">
                    {formatNumber(data.revenue.totalRedeemedCredits)}
                  </p>
                </div>

                <div className="rounded-md border">
                  <div className="border-b px-3 py-2 text-sm font-medium">
                    按面值销量分布
                  </div>
                  {faceValueData.length === 0 ? (
                    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                      暂无销量数据
                    </div>
                  ) : (
                    <div className="h-56 p-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={faceValueData}>
                          <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="var(--border)"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="credits"
                            tick={{ fontSize: 12 }}
                            tickFormatter={(v: number) => `${v} 次`}
                            stroke="var(--muted-foreground)"
                          />
                          <YAxis
                            tick={{ fontSize: 12 }}
                            allowDecimals={false}
                            stroke="var(--muted-foreground)"
                          />
                          <RechartsTooltip
                            content={
                              <ChartTooltip
                                formatter={(value, name) =>
                                  name === 'count'
                                    ? `${formatNumber(value)} 张`
                                    : String(value)
                                }
                              />
                            }
                          />
                          <Bar
                            dataKey="count"
                            name="已售张数"
                            fill="#10b981"
                            radius={[4, 4, 0, 0]}
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </motion.div>
  )
}
