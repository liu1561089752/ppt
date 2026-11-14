/**
 * card-generate-dialog.tsx — 生成新批次卡密 Dialog(credits / quantity / expiresAt / remark)。
 * 从 admin-cards-view.tsx 拆出,逻辑不变。
 */
'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { format } from 'date-fns'
import {
  Plus,
  Loader2,
  Sparkles,
  Calendar,
  FileText,
} from 'lucide-react'

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
import { Switch } from '@/components/ui/switch'

import type { GenerateResponse } from './card-shared'

function defaultExpiresAt(): string {
  const d = new Date()
  d.setDate(d.getDate() + 90)
  return format(d, 'yyyy-MM-dd')
}

interface GenerateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (result: GenerateResponse) => void
}

export function GenerateDialog({ open, onOpenChange, onSuccess }: GenerateDialogProps) {
  const [credits, setCredits] = React.useState(3)
  const [quantity, setQuantity] = React.useState(10)
  const [permanent, setPermanent] = React.useState(false)
  const [expiresAt, setExpiresAt] = React.useState(defaultExpiresAt())
  const [remark, setRemark] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开/对象切换时重置本地状态(既定模式,一次性渲染开销,非派生状态)
      setCredits(3)
      setQuantity(10)
      setPermanent(false)
      setExpiresAt(defaultExpiresAt())
      setRemark('')
      setErrors({})
    }
  }, [open])

  const handleSubmit = async () => {
    const next: Record<string, string> = {}
    if (!Number.isFinite(credits) || credits < 1 || credits > 100) {
      next.credits = '面额必须为 1-100 的整数'
    }
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 1000) {
      next.quantity = '数量必须为 1-1000 的整数'
    }
    if (!permanent) {
      if (!expiresAt) {
        next.expiresAt = '请选择过期日期或勾选"永久"'
      } else {
        const d = new Date(expiresAt)
        if (isNaN(d.getTime())) {
          next.expiresAt = '日期格式无效'
        } else if (d.getTime() < Date.now()) {
          next.expiresAt = '过期时间不能早于当前'
        }
      }
    }
    setErrors(next)
    if (Object.keys(next).length > 0) return

    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        credits,
        quantity,
      }
      if (!permanent) {
        // 用日期字符串 + 当天 23:59:59 作为过期时间
        const d = new Date(expiresAt)
        d.setHours(23, 59, 59, 0)
        body.expiresAt = d.toISOString()
      }
      if (remark.trim()) body.remark = remark.trim()
      const res = await apiPost<GenerateResponse>(
        '/api/admin/cards/generate',
        body,
      )
      toast.success(`已生成 ${res.quantity} 张卡密`, {
        description: `批次号 ${res.batchNo}`,
      })
      onSuccess(res)
      onOpenChange(false)
    } catch (e) {
      const err = e as Error
      toast.error(err.message || '生成失败,请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-amber-600" />
            生成新批次卡密
          </DialogTitle>
          <DialogDescription>
            填写面额与数量,系统将生成 Crockford Base32 卡密
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="gen-credits">面额(次数)</Label>
              <Input
                id="gen-credits"
                type="number"
                min={1}
                max={100}
                value={credits}
                onChange={(e) => setCredits(parseInt(e.target.value, 10) || 0)}
              />
              {errors.credits && (
                <p className="text-xs text-destructive">{errors.credits}</p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="gen-quantity">数量(张)</Label>
              <Input
                id="gen-quantity"
                type="number"
                min={1}
                max={1000}
                value={quantity}
                onChange={(e) => setQuantity(parseInt(e.target.value, 10) || 0)}
              />
              {errors.quantity && (
                <p className="text-xs text-destructive">{errors.quantity}</p>
              )}
            </div>
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="gen-expires" className="flex items-center gap-1.5">
                <Calendar className="size-3.5 text-muted-foreground" />
                过期时间
              </Label>
              <div className="flex items-center gap-2">
                <Label htmlFor="gen-permanent" className="text-xs text-muted-foreground">
                  永久
                </Label>
                <Switch
                  id="gen-permanent"
                  checked={permanent}
                  onCheckedChange={setPermanent}
                />
              </div>
            </div>
            <Input
              id="gen-expires"
              type="date"
              value={expiresAt}
              disabled={permanent}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            {errors.expiresAt && (
              <p className="text-xs text-destructive">{errors.expiresAt}</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="gen-remark" className="flex items-center gap-1.5">
              <FileText className="size-3.5 text-muted-foreground" />
              备注(可选)
            </Label>
            <Input
              id="gen-remark"
              placeholder="如:闲鱼订单批次 / 活动赠送"
              maxLength={200}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                生成中
              </>
            ) : (
              <>
                <Plus className="size-4" />
                确认生成
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
