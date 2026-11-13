/**
 * user-reset-password-dialog.tsx — 管理员重置用户密码。
 * 重置后该用户所有旧会话立即失效;行为写入审计日志。
 */
'use client'

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
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

import type { UserItem } from './user-shared'

interface ResetPasswordDialogProps {
  user: UserItem | null
  onClose: () => void
}

export function ResetPasswordDialog({ user, onClose }: ResetPasswordDialogProps) {
  const qc = useQueryClient()
  const [newPassword, setNewPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    if (user) {
// eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开/对象切换时重置本地状态(既定模式,一次性渲染开销,非派生状态)
      setNewPassword('')
      setConfirmPassword('')
      setError('')
    }
  }, [user])

  if (!user) return null

  const invalid = newPassword.length < 6 || newPassword.length > 32 || newPassword !== confirmPassword
  // 实时提示:让用户明确知道按钮为何不可点(而非只看到灰色按钮)
  const hint = !newPassword
    ? '请先设置新密码(6-32 位)'
    : newPassword.length < 6
      ? `新密码还需 ${6 - newPassword.length} 个字符`
      : newPassword.length > 32
        ? '新密码不能超过 32 位'
        : !confirmPassword
          ? '请在下方再次输入相同密码以确认'
          : newPassword !== confirmPassword
            ? '两次输入的密码不一致'
            : ''

  const handleSubmit = async () => {
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await apiPost(`/api/admin/users/${user.id}/reset-password`, { newPassword })
      toast.success('密码已重置', {
        description: `${user.username} 的旧登录会话已全部失效`,
      })
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      onClose()
    } catch (e) {
      setError((e as Error).message || '重置失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-amber-600" />
            重置 {user.username} 的密码
          </DialogTitle>
          <DialogDescription>
            重置后请将新密码告知用户;该用户所有已登录设备将被强制退出
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="rp-new">新密码(6-32 位)</Label>
            <Input
              id="rp-new"
              type="text"
              autoComplete="off"
              placeholder="管理员直接设定,建议告知用户后自行修改"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rp-confirm">确认新密码</Label>
            <Input
              id="rp-confirm"
              type="text"
              autoComplete="off"
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
                确认重置
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
