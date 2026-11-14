/**
 * profile-view.tsx — Task 4-b 个人中心视图
 *
 * 三张卡片堆叠:
 * 1) 个人信息:用户名 / 邮箱 / 注册时间 / 角色徽章
 * 2) 剩余次数:大数字 + "去兑换"按钮
 * 3) 次数变动历史:表格(时间 / 变动 / 类型 / 余额 / 备注)+ 分页
 *
 * 响应式:mobile-first,max-w-3xl 单栏
 */
'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  User as UserIcon,
  Mail,
  Calendar,
  ShieldCheck,
  Coins,
  ArrowRight,
  History as HistoryIcon,
  KeyRound,
  XCircle,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { apiGet } from '@/lib/api-client'
import { useAppStore } from '@/store/app-store'
import { useCurrentUser } from '@/hooks/use-current-user'
import { reasonMeta } from '@/lib/meta'
import { formatDate } from '@/lib/format'
import { PaginationFooter } from '@/components/pagination-footer'
import { ChangePasswordDialog } from '@/components/change-password-dialog'

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

// ----- 类型 -----
type Reason = 'redeem' | 'generate' | 'refund' | 'admin_adjust'

interface CreditChange {
  id: string
  change: number
  reason: Reason
  balance: number
  remark: string | null
  taskId: string | null
  createdAt: string
}

interface CreditHistoryResponse {
  items: CreditChange[]
  total: number
  page: number
  pageSize: number
}

const PAGE_SIZE = 10

// ----- 历史表格 -----
interface HistoryTableProps {
  items: CreditChange[]
  isLoading: boolean
  isError: boolean
  errorMessage: string | null
  onRetry: () => void
}

function HistoryTable({ items, isLoading, isError, errorMessage, onRetry }: HistoryTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  // 加载失败不得被空态吞掉(H5/M-03 同源):错误卡 + 重试
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <XCircle className="size-5" />
        </div>
        <p className="text-sm text-muted-foreground">
          {errorMessage || '加载失败,点击重试'}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          重试
        </Button>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <HistoryIcon className="size-5" />
        </div>
        <p className="text-sm text-muted-foreground">暂无变动记录</p>
      </div>
    )
  }

  return (
    <>
      {/* 移动端:卡片列表 */}
      <div className="space-y-2 sm:hidden">
        {items.map((c) => {
          const meta = reasonMeta(c.reason)
          const ReasonIcon = meta.icon
          const positive = c.change > 0
          return (
            <div
              key={c.id}
              className="flex items-center gap-3 rounded-md border bg-card p-3"
            >
              <div
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-md',
                  positive
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    : 'bg-destructive/10 text-destructive',
                )}
              >
                <ReasonIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{meta.label}</span>
                  <span
                    className={cn(
                      'text-sm font-semibold tabular-nums',
                      positive
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-destructive',
                    )}
                  >
                    {positive ? '+' : ''}
                    {c.change}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{formatDate(c.createdAt)}</span>
                  <span className="tabular-nums">余额 {c.balance}</span>
                </div>
                {c.remark && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {c.remark}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 桌面端:表格 */}
      <div className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">时间</TableHead>
              <TableHead className="w-24">变动</TableHead>
              <TableHead className="w-28">类型</TableHead>
              <TableHead className="w-20 text-right">余额</TableHead>
              <TableHead>备注</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => {
              const meta = reasonMeta(c.reason)
              const positive = c.change > 0
              return (
                <TableRow key={c.id}>
                  <TableCell className="text-muted-foreground">
                    {formatDate(c.createdAt)}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'font-semibold tabular-nums',
                        positive
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-destructive',
                      )}
                    >
                      {positive ? '+' : ''}
                      {c.change}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge className={meta.className}>{meta.label}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.balance}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">
                    {c.remark || '-'}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

// ----- 主组件 -----
export default function ProfileView() {
  const { data: user, isLoading } = useCurrentUser()
  const setView = useAppStore((s) => s.setView)
  const [page, setPage] = React.useState(1)
  const [pwOpen, setPwOpen] = React.useState(false)

  const historyQuery = useQuery<CreditHistoryResponse, Error>({
    queryKey: ['credits', 'history', page],
    queryFn: () =>
      apiGet<CreditHistoryResponse>(
        `/api/credits/history?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
    placeholderData: (prev) => prev,
  })

  const total = historyQuery.data?.total || 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8"
    >
      {/* 头部 */}
      <div className="mb-6">
        <div className="mb-1 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <UserIcon className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            个人中心
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">查看你的账户信息与次数明细</p>
      </div>

      {/* 个人信息卡片 */}
      <Card className="mb-4">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">个人信息</CardTitle>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setPwOpen(true)}>
              <KeyRound className="size-3.5" />
              修改密码
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading || !user ? (
            <>
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-5 w-2/3" />
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 text-sm">
                  <UserIcon className="size-4 text-muted-foreground" />
                  <span className="text-muted-foreground">用户名</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{user.username}</span>
                  {user.isAdmin ? (
                    <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
                      <ShieldCheck className="size-3" />
                      管理员
                    </Badge>
                  ) : (
                    <Badge variant="secondary">普通用户</Badge>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 text-sm">
                  <Mail className="size-4 text-muted-foreground" />
                  <span className="text-muted-foreground">邮箱</span>
                </div>
                <span className="text-sm font-medium">
                  {user.email || '未设置'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 text-sm">
                  <Calendar className="size-4 text-muted-foreground" />
                  <span className="text-muted-foreground">注册时间</span>
                </div>
                <span className="text-sm font-medium">
                  {formatDate(user.createdAt)}
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 剩余次数卡片 */}
      <Card className="mb-4 overflow-hidden">
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div
                className={cn(
                  'flex size-14 items-center justify-center rounded-full',
                  (user?.remainingCredits ?? 0) > 0
                    ? 'bg-amber-500/15 text-amber-600'
                    : 'bg-destructive/10 text-destructive',
                )}
              >
                <Coins className="size-7" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">当前剩余生成机会</p>
                <p className="text-3xl font-bold tabular-nums leading-tight">
                  {user?.remainingCredits ?? 0}
                  <span className="ml-1.5 text-base font-normal text-muted-foreground">
                    次
                  </span>
                </p>
                {(user?.remainingCredits ?? 0) < 1 && (
                  <p className="mt-1 text-xs text-destructive">
                    次数不足,请尽快兑换
                  </p>
                )}
              </div>
            </div>
            <Button
              variant="default"
              size="lg"
              className="w-full sm:w-auto"
              onClick={() => setView('redeem')}
            >
              去兑换
              <ArrowRight className="size-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 次数变动历史 */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <HistoryIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">次数变动历史</h2>
        </div>
        <Card>
          <CardContent className="p-4 sm:p-5">
            <HistoryTable
              items={historyQuery.data?.items || []}
              isLoading={historyQuery.isLoading}
              isError={historyQuery.isError}
              errorMessage={historyQuery.error?.message ?? null}
              onRetry={() => historyQuery.refetch()}
            />

            {!historyQuery.isLoading && !historyQuery.isError && total > 0 && (
              <div className="mt-3">
                <PaginationFooter
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={total}
                  onPageChange={setPage}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </motion.div>
  )
}
