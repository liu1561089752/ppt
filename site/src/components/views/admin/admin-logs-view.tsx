/**
 * admin-logs-view.tsx — Task 4-c 管理员后台 · 操作审计日志
 *
 * 单栏布局:
 * 1) 顶部筛选:action(Select:全部 + 常见 action 列表)
 * 2) 日志表格:管理员 / 操作 / 目标 / 详情(可点击查看 JSON Dialog)/ 时间
 * 3) 分页(省略号)
 *
 * 响应式:桌面 Table + 行操作,移动端切换为卡片堆叠
 */
'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  ScrollText,
  Filter,
  ChevronRight,
  User,
  Activity,
  Target,
  Clock,
  FileJson,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { apiGet } from '@/lib/api-client'
import { formatDate } from '@/lib/format'

import {
  Card,
  CardContent,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
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
interface LogItem {
  id: string
  adminId: string
  adminUsername: string
  action: string
  target: string | null
  detail: string
  createdAt: string
}

interface LogsResponse {
  items: LogItem[]
  total: number
  page: number
  pageSize: number
}

const PAGE_SIZE = 20

// 常见 action 列表(给筛选下拉用;实际后端可能还有更多,用"全部"覆盖)
const COMMON_ACTIONS: Array<{ value: string; label: string; className: string }> = [
  { value: 'all', label: '全部操作', className: '' },
  { value: 'generate_cards', label: '生成卡密', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  { value: 'revoke_card', label: '作废卡密', className: 'bg-rose-500/15 text-rose-600' },
  { value: 'adjust_credits', label: '调整次数', className: 'bg-sky-500/15 text-sky-600' },
  { value: 'ban_user', label: '封禁用户', className: 'bg-rose-500/15 text-rose-600' },
  { value: 'unban_user', label: '解封用户', className: 'bg-emerald-500/15 text-emerald-600' },
  { value: 'create_announcement', label: '新建公告', className: 'bg-emerald-500/15 text-emerald-600' },
  { value: 'update_announcement', label: '更新公告', className: 'bg-sky-500/15 text-sky-600' },
  { value: 'delete_announcement', label: '删除公告', className: 'bg-rose-500/15 text-rose-600' },
]

const ACTION_BADGE_CLASS: Record<string, string> = Object.fromEntries(
  COMMON_ACTIONS.filter((a) => a.value !== 'all').map((a) => [a.value, a.className]),
)

const ACTION_LABEL: Record<string, string> = Object.fromEntries(
  COMMON_ACTIONS.filter((a) => a.value !== 'all').map((a) => [a.value, a.label]),
)

// ----- 工具 -----
function prettyJson(detail: string): string {
  try {
    const obj = JSON.parse(detail)
    return JSON.stringify(obj, null, 2)
  } catch {
    return detail
  }
}

function shortDetail(detail: string, max = 80): string {
  try {
    const obj = JSON.parse(detail)
    const s = JSON.stringify(obj)
    return s.length > max ? `${s.slice(0, max)}…` : s
  } catch {
    return detail.length > max ? `${detail.slice(0, max)}…` : detail
  }
}

// ----- 日志表格 -----
interface LogsTableProps {
  items: LogItem[]
  isLoading: boolean
  onViewDetail: (log: LogItem) => void
}

function LogsTable({ items, isLoading, onViewDetail }: LogsTableProps) {
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
          <ScrollText className="size-5" />
        </div>
        <p className="text-sm text-muted-foreground">暂无日志记录</p>
      </div>
    )
  }

  return (
    <>
      {/* 移动端:卡片 */}
      <div className="space-y-2 lg:hidden">
        {items.map((l) => {
          const badgeClass = ACTION_BADGE_CLASS[l.action]
          const label = ACTION_LABEL[l.action] || l.action
          return (
            <div key={l.id} className="rounded-md border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <Badge className={cn(badgeClass)}>
                  {label}
                </Badge>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDate(l.createdAt, 'yyyy-MM-dd HH:mm:ss')}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-xs">
                <User className="size-3 text-muted-foreground" />
                <span className="font-medium">{l.adminUsername}</span>
                {l.target && (
                  <>
                    <span className="text-muted-foreground/40">→</span>
                    <span className="truncate font-mono text-muted-foreground">
                      {l.target}
                    </span>
                  </>
                )}
              </div>
              {l.detail && (
                <button
                  type="button"
                  className="mt-2 w-full rounded bg-muted/40 px-2 py-1 text-left font-mono text-[11px] text-muted-foreground"
                  onClick={() => onViewDetail(l)}
                >
                  {shortDetail(l.detail)}
                </button>
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
              <TableHead className="w-32">管理员</TableHead>
              <TableHead className="w-44">操作</TableHead>
              <TableHead className="w-56">目标</TableHead>
              <TableHead>详情</TableHead>
              <TableHead className="w-44">时间</TableHead>
              <TableHead className="w-12 text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((l) => {
              const badgeClass = ACTION_BADGE_CLASS[l.action]
              const label = ACTION_LABEL[l.action] || l.action
              return (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">
                    {l.adminUsername}
                  </TableCell>
                  <TableCell>
                    <Badge className={cn(badgeClass)}>{label}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {l.target || '-'}
                  </TableCell>
                  <TableCell className="max-w-md">
                    {l.detail ? (
                      <button
                        type="button"
                        className="block w-full truncate rounded bg-muted/40 px-2 py-1 text-left font-mono text-[11px] text-muted-foreground hover:bg-muted"
                        onClick={() => onViewDetail(l)}
                        title="点击查看完整详情"
                      >
                        {shortDetail(l.detail, 100)}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDate(l.createdAt, 'yyyy-MM-dd HH:mm:ss')}
                  </TableCell>
                  <TableCell className="text-right">
                    {l.detail && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => onViewDetail(l)}
                      >
                        <ChevronRight className="size-3.5" />
                      </Button>
                    )}
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

// ----- 详情 Dialog -----
interface LogDetailDialogProps {
  log: LogItem | null
  onClose: () => void
}

function LogDetailDialog({ log, onClose }: LogDetailDialogProps) {
  if (!log) return null
  const label = ACTION_LABEL[log.action] || log.action
  const badgeClass = ACTION_BADGE_CLASS[log.action]
  return (
    <Dialog open={!!log} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="size-4 text-primary" />
            操作详情
          </DialogTitle>
          <DialogDescription>
            {label} · {formatDate(log.createdAt, 'yyyy-MM-dd HH:mm:ss')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border p-2">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <User className="size-3" />
                管理员
              </p>
              <p className="mt-0.5 font-medium">{log.adminUsername}</p>
            </div>
            <div className="rounded-md border p-2">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Activity className="size-3" />
                操作类型
              </p>
              <p className="mt-0.5">
                <Badge className={cn(badgeClass)}>{label}</Badge>
              </p>
            </div>
            {log.target && (
              <div className="col-span-2 rounded-md border p-2">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Target className="size-3" />
                  目标
                </p>
                <p className="mt-0.5 break-all font-mono text-xs">
                  {log.target}
                </p>
              </div>
            )}
            <div className="col-span-2 rounded-md border p-2">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="size-3" />
                时间
              </p>
              <p className="mt-0.5 tabular-nums">
                {formatDate(log.createdAt, 'yyyy-MM-dd HH:mm:ss')}
              </p>
            </div>
          </div>

          {log.detail && (
            <div>
              <p className="mb-1.5 text-xs text-muted-foreground">详情(JSON)</p>
              <ScrollArea className="h-56 rounded-md border">
                <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed">
                  {prettyJson(log.detail)}
                </pre>
              </ScrollArea>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ----- 主组件 -----
export default function AdminLogsView() {
  const [page, setPage] = React.useState(1)
  const [action, setAction] = React.useState('all')
  const [viewing, setViewing] = React.useState<LogItem | null>(null)

  const query = useQuery<LogsResponse, Error>({
    queryKey: ['admin', 'logs', { page, action }],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (action !== 'all') params.set('action', action)
      return apiGet<LogsResponse>(`/api/admin/logs?${params.toString()}`)
    },
    placeholderData: (prev) => prev,
  })

  const logs = query.data?.items || []
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
            <ScrollText className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            操作审计日志
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          查看管理员的卡密生成 / 用户调整 / 公告维护等操作记录
        </p>
      </div>

      <Card>
        <CardContent className="p-4 sm:p-5">
          {/* 筛选栏 */}
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Filter className="size-4" />
              <span>按操作筛选:</span>
            </div>
            <Select
              value={action}
              onValueChange={(v) => {
                setAction(v)
                setPage(1)
              }}
            >
              <SelectTrigger className="h-9 w-full sm:w-48">
                <SelectValue placeholder="操作类型" />
              </SelectTrigger>
              <SelectContent>
                {COMMON_ACTIONS.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {total > 0 && (
              <span className="ml-auto hidden text-xs text-muted-foreground tabular-nums sm:inline">
                共 {total} 条
              </span>
            )}
          </div>

          {query.isError && (
            <div className="py-6 text-center text-sm text-destructive">
              {query.error?.message || '加载失败'}
            </div>
          )}

          <LogsTable
            items={logs}
            isLoading={query.isLoading}
            onViewDetail={setViewing}
          />

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

      <LogDetailDialog log={viewing} onClose={() => setViewing(null)} />
    </motion.div>
  )
}
