/**
 * cards-table.tsx — 单批次卡片(BatchCard)与卡密明细表格(CardsTable,移动端卡片 + 桌面 Table)。
 * 从 admin-cards-view.tsx 拆出,逻辑不变。
 */
'use client'

import {
  KeyRound,
  Coins,
  Hash,
  Download,
  Ban,
} from 'lucide-react'

import { formatDate } from '@/lib/format'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import type { BatchItem, CardItem, CardStatus } from './card-shared'

// ----- 状态映射 -----
const STATUS_META: Record<
  CardStatus,
  { label: string; className: string }
> = {
  unused: {
    label: '未用',
    className:
      'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  },
  used: {
    label: '已用',
    className:
      'border-transparent bg-primary/15 text-primary',
  },
  revoked: {
    label: '已作废',
    className:
      'border-transparent bg-muted text-muted-foreground',
  },
}

function downloadCsv(batchId: string) {
  // 直接 window 触发下载(后端返回 CSV 流)
  const a = document.createElement('a')
  a.href = `/api/admin/cards/export?batchId=${encodeURIComponent(batchId)}`
  a.download = ''
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

// ----- 单批次卡片 -----
interface BatchCardProps {
  batch: BatchItem
  onRevokeBatch: (batch: BatchItem) => void
}

export function BatchCard({ batch, onRevokeBatch }: BatchCardProps) {
  const usedPct =
    batch.stats.total > 0
      ? Math.round((batch.stats.used / batch.stats.total) * 100)
      : 0
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-sm font-medium leading-tight">
              {batch.batchNo}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Coins className="size-3" />
              {batch.credits} 次 / 张
              <span className="text-muted-foreground/40">·</span>
              <Hash className="size-3" />
              {batch.quantity} 张
              <span className="text-muted-foreground/40">·</span>
              {formatDate(batch.createdAt)}
            </p>
          </div>
          <Badge variant="outline" className="tabular-nums">
            {usedPct}%
          </Badge>
        </div>

        {batch.remark && (
          <p className="mb-3 truncate rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
            {batch.remark}
          </p>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <Badge className={STATUS_META.unused.className}>
            未用 {batch.stats.unused}
          </Badge>
          <Badge className={STATUS_META.used.className}>
            已用 {batch.stats.used}
          </Badge>
          <Badge className={STATUS_META.revoked.className}>
            作废 {batch.stats.revoked}
          </Badge>
          <span className="ml-auto text-muted-foreground">
            共 {batch.stats.total} 张
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => downloadCsv(batch.id)}
          >
            <Download className="size-3.5" />
            导出 CSV
          </Button>
          {batch.stats.unused > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600"
              onClick={() => onRevokeBatch(batch)}
            >
              <Ban className="size-3.5" />
              作废未用 {batch.stats.unused}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ----- 卡密表格 -----
interface CardsTableProps {
  items: CardItem[]
  isLoading: boolean
  onRevokeCard: (card: CardItem) => void
}

export function CardsTable({ items, isLoading, onRevokeCard }: CardsTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <KeyRound className="size-5" />
        </div>
        <p className="text-sm text-muted-foreground">暂无卡密记录</p>
      </div>
    )
  }

  return (
    <>
      {/* 移动端卡片 */}
      <div className="space-y-2 lg:hidden">
        {items.map((c) => {
          const meta = STATUS_META[c.status]
          return (
            <div
              key={c.id}
              className="rounded-md border bg-card p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="font-mono text-xs tracking-wider break-all">
                  {c.code}
                </p>
                <Badge className={meta.className}>{meta.label}</Badge>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="tabular-nums">{c.credits} 次</span>
                {c.batchNo && (
                  <span className="font-mono text-[10px]">{c.batchNo}</span>
                )}
                <span>到期 {c.expiresAt ? formatDate(c.expiresAt) : '永久'}</span>
              </div>
              {c.redeemedBy && (
                <p className="mt-1 text-xs text-muted-foreground">
                  兑换人 {c.redeemedBy} · {c.redeemedAt ? formatDate(c.redeemedAt) : '-'}
                </p>
              )}
              {c.status === 'unused' && (
                <div className="mt-2 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 px-2 text-rose-600 hover:bg-rose-500/10"
                    onClick={() => onRevokeCard(c)}
                  >
                    <Ban className="size-3" />
                    作废
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 桌面端 Table */}
      <div className="hidden lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>卡密</TableHead>
              <TableHead className="w-16 text-right">面额</TableHead>
              <TableHead className="w-20">状态</TableHead>
              <TableHead className="w-44">批次号</TableHead>
              <TableHead className="w-36">到期</TableHead>
              <TableHead className="w-28">兑换人</TableHead>
              <TableHead className="w-32">兑换时间</TableHead>
              <TableHead className="w-16 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => {
              const meta = STATUS_META[c.status]
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-xs tracking-wider">
                    {c.code}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.credits}
                  </TableCell>
                  <TableCell>
                    <Badge className={meta.className}>{meta.label}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {c.batchNo || '-'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.expiresAt ? formatDate(c.expiresAt) : '永久'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {c.redeemedBy || '-'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.redeemedAt ? formatDate(c.redeemedAt) : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    {c.status === 'unused' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-rose-600 hover:bg-rose-500/10"
                        onClick={() => onRevokeCard(c)}
                      >
                        <Ban className="size-3.5" />
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
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
