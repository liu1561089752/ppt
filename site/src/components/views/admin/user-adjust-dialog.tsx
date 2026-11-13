/**
 * user-adjust-dialog.tsx — 调整用户次数 Dialog(change 可正可负 + remark)。
 * 从 admin-users-view.tsx 拆出,逻辑不变。
 */
'use client'

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Minus,
  Plus,
  Settings2,
  Loader2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { apiPost } from '@/lib/api-client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

import type { UserItem } from './user-shared'

interface AdjustDialogProps {
  user: UserItem | null
  onClose: () => void
}

export function AdjustDialog({ user, onClose }: AdjustDialogProps) {
  const qc = useQueryClient()
  const [change, setChange] = React.useState(0)
  const [remark, setRemark] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    if (user) {
// eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开/对象切换时重置本地状态(既定模式,一次性渲染开销,非派生状态)
      setChange(0)
      setRemark('')
      setError('')
    }
  }, [user])

  if (!user) return null

  const afterBalance = user.remainingCredits + change
  const invalid = change === 0 || afterBalance < 0

  const handleSubmit = async () => {
    if (change === 0) {
      setError('变动值不能为 0')
      return
    }
    if (afterBalance < 0) {
      setError(`调整后余额为 ${afterBalance},不能为负数`)
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const body: { change: number; remark?: string } = { change }
      if (remark.trim()) body.remark = remark.trim()
      const res = await apiPost<{ newBalance: number }>(
        `/api/admin/users/${user.id}/credits`,
        body,
      )
      toast.success('调整成功', {
        description: `${user.username} 当前余额 ${res.newBalance} 次`,
      })
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      onClose()
    } catch (e) {
      const err = e as Error
      setError(err.message || '调整失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="size-4 text-amber-600" />
            调整 {user.username} 的次数
          </DialogTitle>
          <DialogDescription>
            正数表示充值,负数表示扣减;记录将写入次数变动与审计日志
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-md border p-2">
              <p className="text-xs text-muted-foreground">当前余额</p>
              <p className="font-semibold tabular-nums">
                {user.remainingCredits}
              </p>
            </div>
            <div className="rounded-md border p-2">
              <p className="text-xs text-muted-foreground">本次变动</p>
              <p
                className={cn(
                  'font-semibold tabular-nums',
                  change > 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : change < 0
                      ? 'text-destructive'
                      : '',
                )}
              >
                {change > 0 ? '+' : ''}
                {change || 0}
              </p>
            </div>
            <div
              className={cn(
                'rounded-md border p-2',
                afterBalance < 0 && 'border-destructive/50 bg-destructive/5',
              )}
            >
              <p className="text-xs text-muted-foreground">调整后</p>
              <p className="font-semibold tabular-nums">{afterBalance}</p>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="adj-change">变动值(整数,可正可负)</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setChange((c) => c - 1)}
                disabled={submitting}
              >
                <Minus className="size-4" />
              </Button>
              <Input
                id="adj-change"
                type="number"
                value={change}
                onChange={(e) => setChange(parseInt(e.target.value, 10) || 0)}
                disabled={submitting}
                className="text-center tabular-nums"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setChange((c) => c + 1)}
                disabled={submitting}
              >
                <Plus className="size-4" />
              </Button>
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8"
                  onClick={() => setChange(3)}
                >
                  +3
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8"
                  onClick={() => setChange(10)}
                >
                  +10
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="adj-remark">备注(可选)</Label>
            <Input
              id="adj-remark"
              placeholder="如:客服补发 / 测试 / 违规扣减"
              maxLength={200}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              disabled={submitting}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || invalid}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                处理中
              </>
            ) : (
              <>
                <Settings2 className="size-4" />
                确认调整
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
