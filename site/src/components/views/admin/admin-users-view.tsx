/**
 * admin-users-view.tsx — Task 4-c 管理员后台 · 用户管理
 *
 * 单栏布局:
 * 1) 顶部搜索栏(q username 模糊 + status 全部/正常/封禁)
 * 2) 用户表格:username / email / remainingCredits / 角色 / 状态 / 注册时间 / 最后登录 / 操作
 *    (users-table.tsx)+ 详情 Dialog(user-detail-dialog.tsx)+ 调整次数 Dialog(user-adjust-dialog.tsx)
 * 3) 封禁/解封 AlertDialog 确认
 * 4) 分页(PaginationFooter)
 *
 * 响应式:桌面 Table + 行操作按钮,移动端切换为卡片堆叠
 */
'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import {
  Users,
  Search,
  Ban,
  RotateCcw,
  Loader2,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { apiGet, apiPost } from '@/lib/api-client'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

import { AdjustDialog } from './user-adjust-dialog'
import { ResetPasswordDialog } from './user-reset-password-dialog'
import { DetailDialog } from './user-detail-dialog'
import { UsersTable } from './users-table'
import type { UserItem, UsersResponse } from './user-shared'

const PAGE_SIZE = 15

// ----- 主组件 -----
export default function AdminUsersView() {
  const qc = useQueryClient()
  const [page, setPage] = React.useState(1)
  const [statusFilter, setStatusFilter] = React.useState<
    'all' | 'active' | 'banned'
  >('all')
  const [searchInput, setSearchInput] = React.useState('')
  const [search, setSearch] = React.useState('')

  const [viewing, setViewing] = React.useState<UserItem | null>(null)
  const [adjusting, setAdjusting] = React.useState<UserItem | null>(null)
  const [resetting, setResetting] = React.useState<UserItem | null>(null)
  const [banning, setBanning] = React.useState<UserItem | null>(null)
  const [banningSubmitting, setBanningSubmitting] = React.useState(false)

  const query = useQuery<UsersResponse, Error>({
    queryKey: ['admin', 'users', 'list', { page, statusFilter, search }],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (search.trim()) params.set('q', search.trim())
      return apiGet<UsersResponse>(`/api/admin/users?${params.toString()}`)
    },
    placeholderData: (prev) => prev,
  })

  const handleSearch = () => {
    setPage(1)
    setSearch(searchInput.trim())
  }

  const handleBanConfirm = async () => {
    if (!banning) return
    setBanningSubmitting(true)
    try {
      await apiPost<{ isActive: boolean }>(
        `/api/admin/users/${banning.id}/ban`,
        { banned: banning.isActive },
      )
      toast.success(
        banning.isActive ? '已封禁用户' : '已解除封禁',
        { description: banning.username },
      )
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      setBanning(null)
      setViewing(null)
    } catch (e) {
      const err = e as Error
      toast.error(err.message || '操作失败')
    } finally {
      setBanningSubmitting(false)
    }
  }

  const users = query.data?.items || []
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
            <Users className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            用户管理
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          查看用户信息,调整次数,封禁违规账户
        </p>
      </div>

      <Card>
        <CardContent className="p-4 sm:p-5">
          {/* 搜索栏 */}
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              placeholder="按用户名模糊搜索"
              className="h-9 sm:max-w-xs"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch()
              }}
            />
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v as 'all' | 'active' | 'banned')
                setPage(1)
              }}
            >
              <SelectTrigger className="h-9 w-full sm:w-32">
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">正常</SelectItem>
                <SelectItem value="banned">封禁</SelectItem>
              </SelectContent>
            </Select>
            <Button
              className="h-9 gap-1.5 sm:w-auto"
              onClick={handleSearch}
            >
              <Search className="size-4" />
              搜索
            </Button>
            {total > 0 && (
              <span className="ml-auto hidden text-xs text-muted-foreground tabular-nums sm:inline">
                共 {total} 个用户
              </span>
            )}
          </div>

          {query.isError && (
            <div className="py-6 text-center text-sm text-destructive">
              {query.error?.message || '加载失败'}
            </div>
          )}

          <UsersTable
            items={users}
            isLoading={query.isLoading}
            onView={(u) => setViewing(u)}
            onResetPassword={setResetting}
          onAdjustCredits={(u) => setAdjusting(u)}
            onBan={(u) => setBanning(u)}
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

      {/* 详情 Dialog */}
      <DetailDialog
        user={viewing}
        onClose={() => setViewing(null)}
        onAdjustCredits={() => {
          setAdjusting(viewing)
        }}
        onBan={() => {
          setBanning(viewing)
        }}
      />

      {/* 调整次数 Dialog */}
      <AdjustDialog
        user={adjusting}
        onClose={() => setAdjusting(null)}
      />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />

      {/* 封禁确认 */}
      <AlertDialog
        open={!!banning}
        onOpenChange={(o) => !o && setBanning(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {banning?.isActive ? (
                <>
                  <Ban className="size-5 text-rose-600" />
                  确认封禁
                </>
              ) : (
                <>
                  <RotateCcw className="size-5 text-emerald-600" />
                  确认解封
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {banning?.isActive
                ? `封禁后,${banning?.username} 将无法登录与生成。管理员账户不可被封禁。`
                : `解除封禁后,${banning?.username} 可恢复正常登录与使用。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={banningSubmitting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBanConfirm}
              disabled={banningSubmitting}
              className={cn(
                banning?.isActive
                  ? 'bg-destructive text-white hover:bg-destructive/90'
                  : '',
              )}
            >
              {banningSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  处理中
                </>
              ) : banning?.isActive ? (
                '确认封禁'
              ) : (
                '确认解封'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  )
}
