/**
 * change-password-dialog.tsx — 用户修改自己的密码
 * 成功后其它设备旧会话立即失效;当前设备自动续签保持登录。
 */
'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { KeyRound, Loader2 } from 'lucide-react'

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

interface ChangePasswordDialogProps {
  open: boolean
  onClose: () => void
}

export function ChangePasswordDialog({ open, onClose }: ChangePasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开/对象切换时重置本地状态(既定模式,一次性渲染开销,非派生状态)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setError('')
    }
  }, [open])

  const sameAsCurrent = !!currentPassword && newPassword === currentPassword
  const invalid =
    !currentPassword ||
    newPassword.length < 6 ||
    newPassword.length > 32 ||
    newPassword !== confirmPassword ||
    sameAsCurrent
  // 实时提示:明确告知按钮不可点的原因
  const hint = !currentPassword
    ? '请先输入当前密码'
    : !newPassword
      ? '请设置新密码(6-32 位)'
      : newPassword.length < 6
        ? `新密码还需 ${6 - newPassword.length} 个字符`
        : newPassword.length > 32
          ? '新密码不能超过 32 位'
          : sameAsCurrent
            ? '新密码不能与当前密码相同'
            : !confirmPassword
              ? '请再次输入新密码以确认'
              : newPassword !== confirmPassword
                ? '两次输入的新密码不一致'
                : ''

  const handleSubmit = async () => {
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }
    if (sameAsCurrent) {
      setError('新密码不能与当前密码相同')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await apiPost('/api/auth/change-password', { currentPassword, newPassword })
      // M-46:其它设备会因 passwordChangedAt 被踢,静默变有感知
      toast.success('密码已修改,其它设备将需要重新登录', {
        description: '本设备已自动续签,无需重新登录',
      })
      onClose()
    } catch (e) {
      // 失败文案优先用服务器返回的 message(如"当前密码错误"),不做硬编码
      const msg = (e as Error).message || '修改失败'
      setError(msg)
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        {/* 小视口(如 390×400 + 软键盘)下内容可滚动,保证"确认修改"按钮可达 */}
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            修改密码
          </DialogTitle>
          <DialogDescription>
            修改成功后,其它已登录设备将被强制退出
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="cp-current">当前密码</Label>
            <Input
              id="cp-current"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cp-new">新密码(6-32 位)</Label>
            <Input
              id="cp-new"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="cp-confirm">确认新密码</Label>
            <Input
              id="cp-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
            />
            {confirmPassword &&
              (newPassword === confirmPassword ? (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">两次输入一致 ✓</p>
              ) : (
                <p className="text-xs text-destructive">两次输入不一致</p>
              ))}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {!error && hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || invalid}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                提交中
              </>
            ) : (
              <>
                <KeyRound className="size-4" />
                确认修改
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
