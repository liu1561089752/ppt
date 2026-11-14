/**
 * admin-credit-changes-view.tsx — Task 4-c 管理员后台 · 次数对账
 *
 * 单栏布局:
 * 1) 筛选:userId(Input,可选)+ reason(Select:全部/redeem/generate/refund/admin_adjust)
 * 2) 表格:用户 / 变动(+N 绿色 -N 红色) / 类型 / 余额 / 备注 / 时间
 * 3) 分页(省略号)
 *
 * 响应式:桌面 Table,移动端切换为卡片堆叠
 */
'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Receipt,
  Filter,
  Search,
  User,
  XCircle,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { apiGet } from '@/lib/api-client'
import { formatDate } from '@/lib/format'
import { reasonMeta } from '@/lib/meta'

import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PaginationFooter } from '@/components/pagination-footer'

// ----- 类型 -----
type Reason = 'redeem' | 'generate' | 'refund' | 'admin_adjust'

interface CreditChangeItem {
  id: string
  userId: string
  username: string
  taskId: string | null
  change: number
  reason: Reason
  balance: number
  remark: string | null
  createdAt: string
}

interface CreditChangesResponse {
  items: CreditChangeItem[]
  total: number
  page: number
  pageSize: number
}

const PAGE_SIZE = 20

const REASON_OPTIONS: Array<{ value: 'all' | Reason; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'redeem', label: '兑换' },
  { value: 'generate', label: '生成消耗' },
  { value: 'refund', label: '退款' },
  { value: 'admin_adjust', label: '管理员调整' },
]

// ----- 表格 -----
interface ChangesTableProps {
  items: CreditChangeItem[]
  isLoading: boolean
}

function ChangesTable({ items, isLoading }: ChangesTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Receipt className="size-5" />
        </div>
        <p className="text-sm text-muted-foreground">暂无次数变动记录</p>
      </div>
    )
  }

  return (
    <>
      {/* 移动端:卡片 */}
      <div className="space-y-2 lg:hidden">
        {items.map((c) => {
          const meta = reasonMeta(c.reason)
          const ReasonIcon = meta.icon
          const positive = c.change > 0
          return (
            <div key={c.id} className="rounded-md border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <User className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{c.username}</span>
                </div>
                <Badge className={cn('shrink-0', meta.className)}>
                  <ReasonIcon className="size-3" />
                  {meta.label}
                </Badge>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'text-base font-semibold tabular-nums',
                    positive
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-destructive',
                  )}
                >
                  {positive ? '+' : ''}
                  {c.change}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  余额 {c.balance}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{formatDate(c.createdAt)}</span>
              </div>
              {c.remark && (
                <p className="mt-1.5 line-clamp-2 rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                  {c.remark}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {/* 桌面端:Table */}
      <div className="hidden lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">用户</TableHead>
              <TableHead className="w-24 text-right">变动</TableHead>
              <TableHead className="w-32">类型</TableHead>
              <TableHead className="w-20 text-right">余额</TableHead>
              <TableHead>备注</TableHead>
              <TableHead className="w-36">时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => {
              const meta = reasonMeta(c.reason)
              const ReasonIcon = meta.icon
              const positive = c.change > 0
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.username}</TableCell>
                  <TableCell className="text-right">
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
                    <Badge className={meta.className}>
                      <ReasonIcon className="size-3" />
                      {meta.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.balance}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-xs text-muted-foreground">
                    {c.remark || '-'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(c.createdAt)}
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
export default function AdminCreditChangesView() {
  const [page, setPage] = React.useState(1)
  const [reason, setReason] = React.useState<'all' | Reason>('all')
  const [userIdInput, setUserIdInput] = React.useState('')
  const [userId, setUserId] = React.useState('')

  const query = useQuery<CreditChangesResponse, Error>({
    queryKey: ['admin', 'credit-changes', { page, reason, userId }],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (reason !== 'all') params.set('reason', reason)
      if (userId.trim()) params.set('userId', userId.trim())
      return apiGet<CreditChangesResponse>(
        `/api/admin/credit-changes?${params.toString()}`,
      )
    },
    placeholderData: (prev) => prev,
  })

  const handleSearch = () => {
    setPage(1)
    setUserId(userIdInput.trim())
  }

  const items = query.data?.items || []
  const total = query.data?.total || 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8"
    >
      {/* 顶部页头 */}
      <div className="mb-6">
        <div className="mb-1 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Receipt className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            次数对账
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          查看全用户的次数变动记录,可按用户 ID 与变动类型筛选
        </p>
      </div>

      <Card>
        <CardContent className="p-4 sm:p-5">
          {/* 筛选栏 */}
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Filter className="size-4" />
              <span className="hidden sm:inline">筛选:</span>
            </div>
            <Input
              placeholder="按用户 ID 筛选(完整 UUID)"
              className="h-9 font-mono text-xs sm:max-w-xs"
              value={userIdInput}
              onChange={(e) => setUserIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch()
              }}
            />
            <Select
              value={reason}
              onValueChange={(v) => {
                setReason(v as 'all' | Reason)
                setPage(1)
              }}
            >
              <SelectTrigger className="h-9 w-full sm:w-36">
                <SelectValue placeholder="类型" />
              </SelectTrigger>
              <SelectContent>
                {REASON_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="secondary"
              className="h-9 gap-1.5 sm:w-auto"
              onClick={handleSearch}
            >
              <Search className="size-4" />
              查询
            </Button>
            {userId && (
              <Button
                size="sm"
                variant="ghost"
                className="h-9"
                onClick={() => {
                  setUserIdInput('')
                  setUserId('')
                  setPage(1)
                }}
              >
                清除筛选
              </Button>
            )}
            {total > 0 && (
              <span className="ml-auto hidden text-xs text-muted-foreground tabular-nums sm:inline">
                共 {total} 条
              </span>
            )}
          </div>

          {query.isError && (
            <div className="flex items-center gap-2 py-6 text-center text-sm text-destructive">
              <XCircle className="size-4" />
              {query.error?.message || '加载失败'}
            </div>
          )}

          <ChangesTable items={items} isLoading={query.isLoading} />

          {/* 分页 */}
          {!query.isLoading && total > 0 && (
            <div className="mt-4">
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
    </motion.div>
  )
}
