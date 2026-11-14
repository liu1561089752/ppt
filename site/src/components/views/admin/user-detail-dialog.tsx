/**
 * user-detail-dialog.tsx — 用户详情 Dialog(基础信息 + 兑换记录 + 生成任务 + 次数变动)。
 * 从 admin-users-view.tsx 拆出,逻辑不变。
 */
'use client'

import { useQuery } from '@tanstack/react-query'
import {
  Eye,
  Mail,
  Calendar,
  LogIn,
  History as HistoryIcon,
  Gift,
  FileText,
  KeyRound,
  Settings2,
  Ban,
  RotateCcw,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { apiGet } from '@/lib/api-client'
import { formatDate, formatDuration } from '@/lib/format'
import { reasonMeta, statusMeta } from '@/lib/meta'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'

import type { UserDetail, UserItem } from './user-shared'

interface DetailDialogProps {
  user: UserItem | null
  onClose: () => void
  onAdjustCredits: () => void
  onBan: () => void
}

export function DetailDialog({
  user,
  onClose,
  onAdjustCredits,
  onBan,
}: DetailDialogProps) {
  const detailQuery = useQuery<UserDetail, Error>({
    queryKey: ['admin', 'users', 'detail', user?.id],
    queryFn: () => apiGet<UserDetail>(`/api/admin/users/${user!.id}`),
    enabled: !!user,
    staleTime: 30_000,
  })

  if (!user) return null
  const detail = detailQuery.data

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="size-4" />
            用户详情
          </DialogTitle>
          <DialogDescription>
            查看用户基础信息、兑换记录、生成任务、次数变动
          </DialogDescription>
        </DialogHeader>

        {detailQuery.isLoading ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : detailQuery.isError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            加载失败:{detailQuery.error?.message}
          </div>
        ) : detail ? (
          <div className="space-y-3">
            {/* 基础信息 */}
            <div className="grid grid-cols-2 gap-3 rounded-md border bg-card p-3 text-sm sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">用户名</p>
                <p className="font-medium">{detail.username}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">剩余次数</p>
                <p className="font-medium tabular-nums">
                  {detail.remainingCredits}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">角色</p>
                {detail.isAdmin ? (
                  <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
                    管理员
                  </Badge>
                ) : (
                  <Badge variant="secondary">普通</Badge>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground">状态</p>
                {detail.isActive ? (
                  <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                    正常
                  </Badge>
                ) : (
                  <Badge className="border-transparent bg-destructive/15 text-destructive">
                    封禁
                  </Badge>
                )}
              </div>
              <div className="col-span-2">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Mail className="size-3" /> 邮箱
                </p>
                <p className="font-medium">{detail.email || '未设置'}</p>
              </div>
              <div>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Calendar className="size-3" /> 注册时间
                </p>
                <p className="font-medium">{formatDate(detail.createdAt)}</p>
              </div>
              <div>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <LogIn className="size-3" /> 最后登录
                </p>
                <p className="font-medium">
                  {detail.lastLoginAt
                    ? formatDate(detail.lastLoginAt)
                    : '从未登录'}
                </p>
              </div>
              {detail.lastLoginIp && (
                <div className="col-span-2">
                  <p className="text-xs text-muted-foreground">登录 IP</p>
                  <p className="font-mono text-xs">{detail.lastLoginIp}</p>
                </div>
              )}
            </div>

            {/* 嵌套 Tabs */}
            <Tabs defaultValue="changes" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="changes" className="gap-1.5">
                  <HistoryIcon className="size-3.5" />
                  次数变动
                </TabsTrigger>
                <TabsTrigger value="redemptions" className="gap-1.5">
                  <Gift className="size-3.5" />
                  兑换记录
                </TabsTrigger>
                <TabsTrigger value="tasks" className="gap-1.5">
                  <FileText className="size-3.5" />
                  生成任务
                </TabsTrigger>
              </TabsList>

              <TabsContent value="changes" className="mt-2">
                <ScrollArea className="h-60 rounded-md border">
                  <div className="p-2">
                    {detail.creditChanges.length === 0 ? (
                      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                        暂无变动
                      </div>
                    ) : (
                      <ul className="space-y-1.5">
                        {detail.creditChanges.map((c) => {
                          const meta = reasonMeta(c.reason)
                          const positive = c.change > 0
                          return (
                            <li
                              key={c.id}
                              className="flex items-center gap-3 rounded-md bg-muted/30 px-3 py-2 text-sm"
                            >
                              <Badge className={meta.className}>
                                {meta.label}
                              </Badge>
                              <span
                                className={cn(
                                  'shrink-0 font-semibold tabular-nums',
                                  positive
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-destructive',
                                )}
                              >
                                {positive ? '+' : ''}
                                {c.change}
                              </span>
                              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                余额 {c.balance}
                              </span>
                              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                {formatDate(c.createdAt)}
                              </span>
                              {c.remark && (
                                <span className="col-span-full w-full truncate text-xs text-muted-foreground">
                                  备注:{c.remark}
                                </span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="redemptions" className="mt-2">
                <ScrollArea className="h-60 rounded-md border">
                  <div className="p-2">
                    {detail.redemptions.length === 0 ? (
                      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                        暂无兑换
                      </div>
                    ) : (
                      <ul className="space-y-1.5">
                        {detail.redemptions.map((r) => (
                          <li
                            key={r.id}
                            className="flex items-center gap-3 rounded-md bg-muted/30 px-3 py-2 text-sm"
                          >
                            <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="font-mono text-xs">{r.code}</span>
                            <Badge
                              className={
                                'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                              }
                            >
                              +{r.credits}
                            </Badge>
                            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                              {formatDate(r.createdAt)}
                            </span>
                            {r.xianyuOrderNo && (
                              <span className="col-span-full w-full truncate text-xs text-muted-foreground">
                                闲鱼单号:{r.xianyuOrderNo}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="tasks" className="mt-2">
                <ScrollArea className="h-60 rounded-md border">
                  <div className="p-2">
                    {detail.tasks.length === 0 ? (
                      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                        暂无任务
                      </div>
                    ) : (
                      <ul className="space-y-1.5">
                        {detail.tasks.map((t) => {
                          const meta = statusMeta(t.status)
                          return (
                            <li
                              key={t.id}
                              className="flex flex-col gap-1.5 rounded-md bg-muted/30 px-3 py-2 text-sm"
                            >
                              <div className="flex items-center gap-2">
                                <Badge className={meta.className}>
                                  {meta.label}
                                </Badge>
                                <span className="line-clamp-1 flex-1 text-xs">
                                  {t.topic}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {formatDate(t.createdAt)}
                                </span>
                              </div>
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                                <span>{t.slideCount} 张</span>
                                <span>消耗 {t.creditsUsed} 次</span>
                                {t.durationMs != null && (
                                  <span>耗时 {formatDuration(t.durationMs)}</span>
                                )}
                                {t.errorMessage && (
                                  <span className="line-clamp-1 text-destructive">
                                    {t.errorMessage}
                                  </span>
                                )}
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </div>
        ) : null}

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          {!user.isAdmin && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={onAdjustCredits}
                disabled={!detail}
              >
                <Settings2 className="size-4" />
                调整次数
              </Button>
              <Button
                variant={user.isActive ? 'destructive' : 'default'}
                className="gap-1.5"
                onClick={onBan}
                disabled={!detail}
              >
                {user.isActive ? (
                  <>
                    <Ban className="size-4" />
                    封禁用户
                  </>
                ) : (
                  <>
                    <RotateCcw className="size-4" />
                    解除封禁
                  </>
                )}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
