/**
 * admin-cards-view.tsx — Task 4-c 管理员后台 · 卡密管理
 *
 * 左栏:批次操作区(生成新批次按钮 + 批次列表卡片,显示统计 + 导出 + 整批作废)
 * 右栏:卡密列表(状态/批次筛选 + code 搜索 + Table 桌面 / 卡片 移动 + 分页)
 *
 * 生成批次 Dialog(card-generate-dialog.tsx)
 * 成功后弹出结果 Dialog(card-result-dialog.tsx):展示所有 code + 单行复制 + 全部复制 + 导出 CSV
 * 批次卡片与卡密表格见 cards-table.tsx
 *
 * 响应式:mobile-first;桌面 lg:grid-cols-3 左 1 右 2;移动单栏堆叠
 */
'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import {
  KeyRound,
  Plus,
  Package,
  Ban,
  Loader2,
  Search,
  XCircle,
} from 'lucide-react'

import { apiGet, apiPost } from '@/lib/api-client'

import { Card, CardContent } from '@/components/ui/card'
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PaginationFooter } from '@/components/pagination-footer'

import { GenerateDialog } from './card-generate-dialog'
import { ResultDialog } from './card-result-dialog'
import { BatchCard, CardsTable } from './cards-table'
import type {
  BatchItem,
  BatchesResponse,
  CardItem,
  CardStatus,
  CardsResponse,
  GenerateResponse,
} from './card-shared'

const PAGE_SIZE = 15

// ----- 主组件 -----
export default function AdminCardsView() {
  const qc = useQueryClient()
  const [page, setPage] = React.useState(1)
  const [status, setStatus] = React.useState<'all' | CardStatus>('all')
  const [batchId, setBatchId] = React.useState<'all' | string>('all')
  const [search, setSearch] = React.useState('')
  const [searchInput, setSearchInput] = React.useState('')

  const [genOpen, setGenOpen] = React.useState(false)
  const [result, setResult] = React.useState<GenerateResponse | null>(null)
  const [revokeTarget, setRevokeTarget] = React.useState<
    { kind: 'card'; card: CardItem } | { kind: 'batch'; batch: BatchItem } | null
  >(null)
  const [revoking, setRevoking] = React.useState(false)

  // 批次列表(全量,通常不会太多)
  const batchesQuery = useQuery<BatchesResponse, Error>({
    queryKey: ['admin', 'cards', 'batches'],
    queryFn: () =>
      apiGet<BatchesResponse>(
        '/api/admin/cards/batches?page=1&pageSize=100',
      ),
    staleTime: 30_000,
  })

  // 卡密列表
  const cardsQuery = useQuery<CardsResponse, Error>({
    queryKey: ['admin', 'cards', 'list', { page, status, batchId, search }],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (status !== 'all') params.set('status', status)
      if (batchId !== 'all') params.set('batchId', batchId)
      if (search.trim()) params.set('q', search.trim())
      return apiGet<CardsResponse>(`/api/admin/cards?${params.toString()}`)
    },
    placeholderData: (prev) => prev,
  })

  const handleSearch = () => {
    setPage(1)
    setSearch(searchInput.trim())
  }

  const handleRevokeConfirm = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      const body: Record<string, string> =
        revokeTarget.kind === 'card'
          ? { cardId: revokeTarget.card.id }
          : { batchId: revokeTarget.batch.id }
      const res = await apiPost<{ revokedCount: number }>(
        '/api/admin/cards/revoke',
        body,
      )
      toast.success(
        `已作废 ${res.revokedCount} 张卡密`,
        revokeTarget.kind === 'batch'
          ? { description: `批次 ${revokeTarget.batch.batchNo}` }
          : undefined,
      )
      // 刷新
      qc.invalidateQueries({ queryKey: ['admin', 'cards'] })
      setRevokeTarget(null)
    } catch (e) {
      const err = e as Error
      toast.error(err.message || '作废失败')
    } finally {
      setRevoking(false)
    }
  }

  const cards = cardsQuery.data?.items || []
  const total = cardsQuery.data?.total || 0

  const batches = batchesQuery.data?.items || []

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
            <div className="flex size-8 items-center justify-center rounded-md bg-amber-500/15 text-amber-600">
              <KeyRound className="size-5" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              卡密管理
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            生成 / 作废卡密,查看批次与卡密明细
          </p>
        </div>
        <Button onClick={() => setGenOpen(true)} className="w-full sm:w-auto">
          <Plus className="size-4" />
          生成新批次
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 左栏:批次管理 */}
        <div className="lg:col-span-1">
          <div className="mb-3 flex items-center gap-2">
            <Package className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">批次列表</h2>
            {batchesQuery.data && (
              <Badge variant="secondary" className="ml-auto tabular-nums">
                {batchesQuery.data.total}
              </Badge>
            )}
          </div>

          {batchesQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-32 w-full" />
              ))}
            </div>
          ) : batchesQuery.isError ? (
            <Card>
              <CardContent className="flex items-center gap-2 px-4 py-6 text-sm text-destructive">
                <XCircle className="size-4" />
                {batchesQuery.error?.message || '加载失败'}
              </CardContent>
            </Card>
          ) : batches.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Package className="size-5" />
                </div>
                <p className="text-sm text-muted-foreground">暂无批次</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setGenOpen(true)}
                >
                  生成第一批
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {batches.map((b) => (
                <BatchCard
                  key={b.id}
                  batch={b}
                  onRevokeBatch={(batch) =>
                    setRevokeTarget({ kind: 'batch', batch })
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* 右栏:卡密列表 */}
        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">卡密明细</h2>
            {cardsQuery.data && (
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                共 {total} 条
              </span>
            )}
          </div>

          <Card>
            <CardContent className="p-4 sm:p-5">
              {/* 筛选栏 */}
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select
                  value={status}
                  onValueChange={(v) => {
                    setStatus(v as 'all' | CardStatus)
                    setPage(1)
                  }}
                >
                  <SelectTrigger className="h-8 w-full sm:w-28">
                    <SelectValue placeholder="状态" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部状态</SelectItem>
                    <SelectItem value="unused">未用</SelectItem>
                    <SelectItem value="used">已用</SelectItem>
                    <SelectItem value="revoked">作废</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  value={batchId}
                  onValueChange={(v) => {
                    setBatchId(v)
                    setPage(1)
                  }}
                >
                  <SelectTrigger className="h-8 w-full sm:w-48">
                    <SelectValue placeholder="批次" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="all">全部批次</SelectItem>
                    {batches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.batchNo}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="flex flex-1 items-center gap-2">
                  <Input
                    placeholder="按卡密 code 模糊搜索"
                    className="h-8 flex-1 font-mono"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSearch()
                    }}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-8 gap-1.5"
                    onClick={handleSearch}
                  >
                    <Search className="size-3.5" />
                    搜索
                  </Button>
                </div>
              </div>

              {cardsQuery.isError && (
                <div className="py-6 text-center text-sm text-destructive">
                  {cardsQuery.error?.message || '加载失败'}
                </div>
              )}

              <CardsTable
                items={cards}
                isLoading={cardsQuery.isLoading}
                onRevokeCard={(card) =>
                  setRevokeTarget({ kind: 'card', card })
                }
              />

              {/* 分页 */}
              {!cardsQuery.isLoading && total > 0 && (
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
        </div>
      </div>

      {/* 生成 Dialog */}
      <GenerateDialog
        open={genOpen}
        onOpenChange={setGenOpen}
        onSuccess={(r) => {
          setResult(r)
          qc.invalidateQueries({ queryKey: ['admin', 'cards'] })
        }}
      />

      {/* 生成结果 Dialog */}
      <ResultDialog result={result} onClose={() => setResult(null)} />

      {/* 作废确认 */}
      <AlertDialog
        open={!!revokeTarget}
        onOpenChange={(o) => !o && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Ban className="size-5 text-rose-600" />
              确认作废
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget?.kind === 'card' ? (
                <>
                  将作废卡密{' '}
                  <span className="font-mono text-foreground">
                    {revokeTarget.card.code}
                  </span>
                  ,该卡密将不可再被兑换。此操作不可撤销。
                </>
              ) : revokeTarget?.kind === 'batch' ? (
                <>
                  将作废批次{' '}
                  <span className="font-mono text-foreground">
                    {revokeTarget.batch.batchNo}
                  </span>{' '}
                  下所有未用卡密(共 {revokeTarget.batch.stats.unused} 张),已用卡密不受影响。
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevokeConfirm}
              disabled={revoking}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {revoking ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  处理中
                </>
              ) : (
                <>确认作废</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  )
}
