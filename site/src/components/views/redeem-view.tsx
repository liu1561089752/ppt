/**
 * redeem-view.tsx — Task 4-b 卡密兑换视图
 *
 * 顶部大输入框:卡密(自动格式化:大写 + 每 4 字符加 -)+ 闲鱼订单号(可选)
 * 提交:/api/redeem → 成功 toast + 刷新 useCurrentUser
 * 兑换历史:从 /api/credits/history 筛选 reason='redeem' 的记录
 *
 * 响应式:mobile-first,max-w-2xl 单栏
 */
'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import {
  KeyRound,
  Loader2,
  Gift,
  CheckCircle2,
  Send,
  Info,
  History as HistoryIcon,
  Coins,
  XCircle,
} from 'lucide-react'

import { apiGet, apiPost } from '@/lib/api-client'
import { normalizeCardCode, isValidCardCodeFormat } from '@/lib/card-code'
import { useCurrentUser, CURRENT_USER_QUERY_KEY } from '@/hooks/use-current-user'
import { formatDate } from '@/lib/format'
import { PaginationFooter } from '@/components/pagination-footer'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

// ----- 类型 -----
interface RedeemResponse {
  success: true
  credits: number
  newBalance: number
  card: { code: string; credits: number }
}

interface CreditChange {
  id: string
  change: number
  reason: 'redeem' | 'generate' | 'refund' | 'admin_adjust'
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

// ----- 工具:输入框格式化 -----
function formatCardInput(value: string): string {
  // 去除非字母数字 → 大写 → 每 4 个字符加 -
  const cleaned = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const groups: string[] = []
  for (let i = 0; i < cleaned.length && groups.length < 4; i += 4) {
    groups.push(cleaned.slice(i, i + 4))
  }
  return groups.length > 0 ? groups.join('-') : ''
}

// ----- 兑换历史 -----
interface RedeemHistoryProps {
  items: CreditChange[]
  isLoading: boolean
  isError: boolean
  errorMessage: string | null
  onRetry: () => void
  page: number
  total: number
  onPageChange: (p: number) => void
}

function RedeemHistory({
  items,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  page,
  total,
  onPageChange,
}: RedeemHistoryProps) {
  // 服务端已按 reason='redeem' 过滤并返回对口的 total(H9),前端不再本地 filter
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    )
  }

  // 加载失败不得被空态吞掉:显式错误卡 + 重试(H5/M-03 同源)
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
        <p className="text-sm text-muted-foreground">暂无兑换记录</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {items.map((c) => (
        <div
          key={c.id}
          className="flex items-center gap-3 rounded-md border bg-card p-3"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
            <Gift className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                +{c.change} 次
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDate(c.createdAt)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {c.remark || '兑换卡密'}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs text-muted-foreground">余额</p>
            <p className="text-sm font-medium tabular-nums">{c.balance}</p>
          </div>
        </div>
      ))}

      {totalPages > 1 && (
        <div className="mt-4">
          <PaginationFooter
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={onPageChange}
          />
        </div>
      )}
    </div>
  )
}

// ----- 主组件 -----
export default function RedeemView() {
  const { data: user } = useCurrentUser()
  const queryClient = useQueryClient()

  const [code, setCode] = React.useState('')
  const [xianyuOrderNo, setXianyuOrderNo] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)

  const historyQuery = useQuery<CreditHistoryResponse, Error>({
    queryKey: ['credits', 'history', page],
    queryFn: () =>
      apiGet<CreditHistoryResponse>(
        `/api/credits/history?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
    placeholderData: (prev) => prev,
  })

  // 兑换记录总数(服务端按 reason='redeem' 口径返回,与分页一致,不再本地 filter)
  const total = historyQuery.data?.total || 0

  // 输入处理
  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCode(formatCardInput(e.target.value))
  }

  const normalizedCode = React.useMemo(() => normalizeCardCode(code), [code])
  const isFormatValid = isValidCardCodeFormat(normalizedCode)
  const canSubmit = isFormatValid && !submitting

  const handleSubmit = async () => {
    if (!isFormatValid) {
      toast.error('卡密格式不正确,应为 16 位字符(如 K7XQ-2M9F-P4WT-8YBN)')
      return
    }

    setSubmitting(true)
    const toastId = 'redeem-task'
    toast.loading('正在兑换…', { id: toastId })
    setSubmitError(null)
    try {
      const res = await apiPost<RedeemResponse>('/api/redeem', {
        code: normalizedCode,
        xianyuOrderNo: xianyuOrderNo.trim() || undefined,
      })
      toast.success(`兑换成功,获得 ${res.credits} 次生成机会!`, {
        id: toastId,
        description: `当前余额:${res.newBalance} 次`,
      })
      setCode('')
      setXianyuOrderNo('')
      // 刷新 user(剩余次数)+ 历史
      queryClient.invalidateQueries({ queryKey: CURRENT_USER_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: ['credits', 'history'] })
    } catch (e) {
      // M-39:失败可区分 + 行内错误位(表单下方),错误提示只走行内这一处通道
      const err = e as Error & { code?: string }
      const msg =
        err.code === 'CARD_INVALID'
          ? '卡密不存在或已被使用,请核对后重试'
          : err.code === 'RATE_LIMITED' || (e as { status?: number }).status === 429
            ? '尝试过于频繁,请稍后再试'
            : err.message || '兑换失败'
      setSubmitError(msg)
      toast.error(msg, { id: toastId })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-8"
    >
      {/* 头部 */}
      <div className="mb-6">
        <div className="mb-1 flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md bg-amber-500/15 text-amber-600">
            <KeyRound className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            卡密兑换
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          输入您购买的卡密,即可获得对应的生成次数
        </p>
      </div>

      {/* 当前余额提示 */}
      <Card className="mb-4 bg-amber-500/5">
        <CardContent className="flex items-center justify-between gap-3 p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-full bg-amber-500/15 text-amber-600">
              <Coins className="size-5" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">当前剩余次数</p>
              <p className="text-2xl font-semibold tabular-nums">
                {user?.remainingCredits ?? 0}
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  次
                </span>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 兑换表单 */}
      <Card className="mb-4">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">输入卡密</CardTitle>
          <CardDescription>
            卡密格式:XXXX-XXXX-XXXX-XXXX(共 16 位字符 + 3 个短横)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cardCode">
              卡密 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="cardCode"
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={code}
              onChange={handleCodeChange}
              placeholder="K7XQ-2M9F-P4WT-8YBN"
              className="h-12 font-mono text-base tracking-wider sm:text-lg"
              disabled={submitting}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
            />
            <div className="flex items-center justify-between text-xs">
              {code && !isFormatValid ? (
                <span className="text-destructive">
                  格式不正确,应为 16 位字符,仅限大写字母与数字(不含 0、1、I、O、L)
                </span>
              ) : (
                <span className="text-muted-foreground">
                  输入时自动格式化,无需手动添加短横
                </span>
              )}
              <span className="text-muted-foreground tabular-nums">
                {code.replace(/[^A-Za-z0-9]/g, '').length}/16
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="xianyuOrderNo">闲鱼订单号(可选)</Label>
            <Input
              id="xianyuOrderNo"
              type="text"
              value={xianyuOrderNo}
              onChange={(e) => setXianyuOrderNo(e.target.value)}
              placeholder="方便客服核对(可选)"
              maxLength={64}
              disabled={submitting}
            />
          </div>

          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                兑换中
              </>
            ) : (
              <>
                <Send className="size-4" />
                立即兑换
              </>
            )}
          </Button>

          {/* 行内错误位(M-39):与 toast 同文案,失败原因固定可见、不随弹层消失 */}
          {submitError && (
            <p className="text-sm text-destructive" role="alert">
              {submitError}
            </p>
          )}
        </CardContent>
      </Card>

      {/* 提示 */}
      <Alert className="mb-6">
        <Info className="size-4" />
        <AlertDescription className="text-xs">
          卡密为 16 位字符,仅限大写字母与数字(不含 0、1、I、O、L),通过闲鱼购买后向卖家索取。
          每张卡密只能兑换一次,且需在有效期内使用。
        </AlertDescription>
      </Alert>

      {/* 兑换历史 */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <CheckCircle2 className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">兑换历史</h2>
        </div>
        <Card>
          <CardContent className="p-4 sm:p-5">
            <RedeemHistory
              items={historyQuery.data?.items || []}
              isLoading={historyQuery.isLoading}
              isError={historyQuery.isError}
              errorMessage={historyQuery.error?.message ?? null}
              onRetry={() => historyQuery.refetch()}
              page={page}
              total={total}
              onPageChange={setPage}
            />
          </CardContent>
        </Card>
      </div>
    </motion.div>
  )
}
