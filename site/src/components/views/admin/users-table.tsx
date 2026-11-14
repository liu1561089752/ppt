/**
 * users-table.tsx — 用户管理的用户列表(移动端卡片 + 桌面表格)。
 * 从 admin-users-view.tsx 拆出,逻辑不变。
 */
'use client'

import {
  Users,
  ShieldCheck,
  UserCheck,
  UserX,
  Coins,
  Eye,
  Settings2,
  Ban,
  RotateCcw,
  KeyRound,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatDate, formatRelative } from '@/lib/format'

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

import type { UserItem } from './user-shared'

interface UsersTableProps {
  items: UserItem[]
  isLoading: boolean
  onView: (user: UserItem) => void
  onResetPassword: (user: UserItem) => void
  onAdjustCredits: (user: UserItem) => void
  onBan: (user: UserItem) => void
}

export function UsersTable({
  items,
  isLoading,
  onView,
  onResetPassword,
  onAdjustCredits,
  onBan,
}: UsersTableProps) {
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
          <Users className="size-5" />
        </div>
        <p className="text-sm text-muted-foreground">暂无用户</p>
      </div>
    )
  }

  return (
    <>
      {/* 移动端:卡片列表 */}
      <div className="space-y-2 lg:hidden">
        {items.map((u) => (
          <div key={u.id} className="rounded-md border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{u.username}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {u.email || '未设置邮箱'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {u.isAdmin && (
                  <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
                    管理员
                  </Badge>
                )}
                <Badge
                  className={
                    u.isActive
                      ? 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                      : 'border-transparent bg-destructive/15 text-destructive'
                  }
                >
                  {u.isActive ? '正常' : '封禁'}
                </Badge>
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Coins className="size-3" />
              <span className="tabular-nums">{u.remainingCredits} 次</span>
              <span className="text-muted-foreground/40">·</span>
              <span>{formatRelative(u.lastLoginAt)}</span>
            </div>
            <div className="mt-2 flex items-center justify-end gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => onView(u)}
              >
                <Eye className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => onResetPassword(u)}
                title="重置密码"
              >
                <KeyRound className="size-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => onAdjustCredits(u)}
                disabled={u.isAdmin}
              >
                <Settings2 className="size-3.5" />
              </Button>
              {!u.isAdmin && (
                <Button
                  size="sm"
                  variant="ghost"
                  className={cn(
                    'h-7 px-2',
                    u.isActive
                      ? 'text-rose-600 hover:bg-rose-500/10'
                      : 'text-emerald-600 hover:bg-emerald-500/10',
                  )}
                  onClick={() => onBan(u)}
                >
                  {u.isActive ? (
                    <Ban className="size-3.5" />
                  ) : (
                    <RotateCcw className="size-3.5" />
                  )}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 桌面端:表格 */}
      <div className="hidden lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">用户名</TableHead>
              <TableHead>邮箱</TableHead>
              <TableHead className="w-20 text-right">次数</TableHead>
              <TableHead className="w-24">角色</TableHead>
              <TableHead className="w-20">状态</TableHead>
              <TableHead className="w-32">注册时间</TableHead>
              <TableHead className="w-36">最后登录</TableHead>
              <TableHead className="w-32 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.username}</TableCell>
                <TableCell className="max-w-48 truncate text-xs text-muted-foreground">
                  {u.email || '-'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <span
                    className={cn(
                      u.remainingCredits < 1 && 'text-destructive',
                    )}
                  >
                    {u.remainingCredits}
                  </span>
                </TableCell>
                <TableCell>
                  {u.isAdmin ? (
                    <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
                      <ShieldCheck className="size-3" />
                      管理员
                    </Badge>
                  ) : (
                    <Badge variant="secondary">普通</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {u.isActive ? (
                    <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                      <UserCheck className="size-3" />
                      正常
                    </Badge>
                  ) : (
                    <Badge className="border-transparent bg-destructive/15 text-destructive">
                      <UserX className="size-3" />
                      封禁
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(u.createdAt)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {u.lastLoginAt ? formatDate(u.lastLoginAt) : '从未登录'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => onView(u)}
                      title="查看详情"
                    >
                      <Eye className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => onResetPassword(u)}
                      title="重置密码"
                    >
                      <KeyRound className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => onAdjustCredits(u)}
                      disabled={u.isAdmin}
                      title={u.isAdmin ? '管理员不可调整' : '调整次数'}
                    >
                      <Settings2 className="size-3.5" />
                    </Button>
                    {!u.isAdmin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className={cn(
                          'h-7 px-2',
                          u.isActive
                            ? 'text-rose-600 hover:bg-rose-500/10'
                            : 'text-emerald-600 hover:bg-emerald-500/10',
                        )}
                        onClick={() => onBan(u)}
                        title={u.isActive ? '封禁' : '解封'}
                      >
                        {u.isActive ? (
                          <Ban className="size-3.5" />
                        ) : (
                          <RotateCcw className="size-3.5" />
                        )}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  )
}
