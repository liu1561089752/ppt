/**
 * admin-announcements-view.tsx — Task 4-c 管理员后台 · 公告管理
 *
 * 单栏布局:
 * 1) 顶部"新建公告"按钮 → Dialog(title / content textarea / type Select / pinned Switch)
 * 2) 公告列表卡片:title / type Badge / pinned / content 截断 / 创建时间
 * 3) 行操作:编辑(同 Dialog) / 删除(AlertDialog 确认) / 置顶切换
 * 4) 不分页(通常很少),最多 100 条
 *
 * 响应式:卡片网格 grid-cols-1 md:grid-cols-2
 */
'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import {
  Megaphone,
  Plus,
  Pencil,
  Trash2,
  Pin,
  PinOff,
  Loader2,
  Info,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api-client'
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
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

// ----- 类型 -----
type AnnType = 'info' | 'warning' | 'success'

interface Announcement {
  id: string
  title: string
  content: string
  type: string
  pinned: boolean
  active: boolean
  createdAt: string
  updatedAt: string
}

interface AnnouncementsResponse {
  items: Announcement[]
  total: number
  page: number
  pageSize: number
}

// ----- 类型徽章 -----
const TYPE_META: Record<
  AnnType,
  { label: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  info: {
    label: '信息',
    className: 'border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400',
    icon: Info,
  },
  warning: {
    label: '警告',
    className: 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400',
    icon: AlertTriangle,
  },
  success: {
    label: '成功',
    className: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    icon: CheckCircle2,
  },
}

// ----- 公告卡片 -----
interface AnnouncementCardProps {
  announcement: Announcement
  onEdit: (a: Announcement) => void
  onDelete: (a: Announcement) => void
  onTogglePin: (a: Announcement) => void
}

function AnnouncementCard({
  announcement,
  onEdit,
  onDelete,
  onTogglePin,
}: AnnouncementCardProps) {
  const typeKey = (announcement.type as AnnType) in TYPE_META
    ? (announcement.type as AnnType)
    : 'info'
  const meta = TYPE_META[typeKey]
  const TypeIcon = meta.icon
  return (
    <Card className={cn(announcement.pinned && 'border-amber-500/40')}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <Badge className={meta.className}>
                <TypeIcon className="size-3" />
                {meta.label}
              </Badge>
              {announcement.pinned && (
                <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
                  <Pin className="size-3" />
                  置顶
                </Badge>
              )}
              {!announcement.active && (
                <Badge variant="secondary">已下线</Badge>
              )}
            </div>
            <CardTitle className="line-clamp-2 text-base">
              {announcement.title}
            </CardTitle>
            <CardDescription className="mt-1 text-xs">
              {formatDate(announcement.createdAt)} · 更新于{' '}
              {formatDate(announcement.updatedAt)}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="mb-3 line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">
          {announcement.content}
        </p>
        <div className="flex items-center justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              'h-8 gap-1.5',
              announcement.pinned
                ? 'text-amber-600 hover:bg-amber-500/10'
                : 'text-muted-foreground hover:bg-muted',
            )}
            onClick={() => onTogglePin(announcement)}
          >
            {announcement.pinned ? (
              <>
                <PinOff className="size-3.5" />
                取消置顶
              </>
            ) : (
              <>
                <Pin className="size-3.5" />
                置顶
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5"
            onClick={() => onEdit(announcement)}
          >
            <Pencil className="size-3.5" />
            编辑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 text-rose-600 hover:bg-rose-500/10"
            onClick={() => onDelete(announcement)}
          >
            <Trash2 className="size-3.5" />
            删除
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ----- 编辑/新建 Dialog -----
interface EditDialogProps {
  mode: 'create' | 'edit'
  announcement: Announcement | null
  open: boolean
  onClose: () => void
}

function EditDialog({ mode, announcement, open, onClose }: EditDialogProps) {
  const qc = useQueryClient()
  const [title, setTitle] = React.useState('')
  const [content, setContent] = React.useState('')
  const [type, setType] = React.useState<AnnType>('info')
  const [pinned, setPinned] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [errors, setErrors] = React.useState<Record<string, string>>({})

  React.useEffect(() => {
    if (open) {
// eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开/对象切换时重置本地状态(既定模式,一次性渲染开销,非派生状态)
      setTitle(announcement?.title || '')
      setContent(announcement?.content || '')
      setType((announcement?.type as AnnType) || 'info')
      setPinned(announcement?.pinned || false)
      setErrors({})
    }
  }, [open, announcement])

  const handleSubmit = async () => {
    const next: Record<string, string> = {}
    if (!title.trim()) next.title = '请输入标题'
    else if (title.trim().length > 200) next.title = '标题最多 200 字'
    if (!content.trim()) next.content = '请输入内容'
    else if (content.trim().length > 5000) next.content = '内容最多 5000 字'
    setErrors(next)
    if (Object.keys(next).length > 0) return

    setSubmitting(true)
    try {
      if (mode === 'create') {
        await apiPost<Announcement>('/api/admin/announcements', {
          title: title.trim(),
          content: content.trim(),
          type,
          pinned,
        })
        toast.success('公告已创建')
      } else if (announcement) {
        await apiPut<Announcement>(
          `/api/admin/announcements/${announcement.id}`,
          {
            title: title.trim(),
            content: content.trim(),
            type,
            pinned,
          },
        )
        toast.success('公告已更新')
      }
      qc.invalidateQueries({ queryKey: ['admin', 'announcements'] })
      // 同步刷新公开的公告列表(landing 用)
      qc.invalidateQueries({ queryKey: ['announcements'] })
      onClose()
    } catch (e) {
      const err = e as Error
      toast.error(err.message || '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === 'create' ? (
              <>
                <Plus className="size-4 text-emerald-600" />
                新建公告
              </>
            ) : (
              <>
                <Pencil className="size-4 text-sky-600" />
                编辑公告
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? '新建后即时对所有用户可见'
              : '更新后,前台用户刷新即可看到新内容'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="ann-title">标题</Label>
            <Input
              id="ann-title"
              placeholder="如:系统维护通知 / 新版本发布"
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
            />
            {errors.title && (
              <p className="text-xs text-destructive">{errors.title}</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ann-content">内容</Label>
            <Textarea
              id="ann-content"
              placeholder="公告正文(支持换行)…"
              maxLength={5000}
              rows={6}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={submitting}
            />
            <div className="flex items-center justify-between">
              {errors.content ? (
                <p className="text-xs text-destructive">{errors.content}</p>
              ) : (
                <span />
              )}
              <span className="text-xs text-muted-foreground tabular-nums">
                {content.length} / 5000
              </span>
            </div>
          </div>

          <div className="flex items-end gap-4">
            <div className="grid flex-1 gap-1.5">
              <Label>类型</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as AnnType)}
                disabled={submitting}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">信息</SelectItem>
                  <SelectItem value="warning">警告</SelectItem>
                  <SelectItem value="success">成功</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch
                id="ann-pinned"
                checked={pinned}
                onCheckedChange={setPinned}
                disabled={submitting}
              />
              <Label htmlFor="ann-pinned" className="text-sm">
                置顶
              </Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                保存中
              </>
            ) : mode === 'create' ? (
              <>
                <Plus className="size-4" />
                创建公告
              </>
            ) : (
              <>
                <Pencil className="size-4" />
                保存
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ----- 主组件 -----
const ANN_PAGE_SIZE = 20

export default function AdminAnnouncementsView() {
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Announcement | null>(null)
  const [deleting, setDeleting] = React.useState<Announcement | null>(null)
  const [deletingSubmitting, setDeletingSubmitting] = React.useState(false)
  const [pinningId, setPinningId] = React.useState<string | null>(null)
  // 真分页(M-109):此前 pageSize=100 一次拉全量,公告多时丢数据
  const [page, setPage] = React.useState(1)

  const query = useQuery<AnnouncementsResponse, Error>({
    queryKey: ['admin', 'announcements', page],
    queryFn: () =>
      apiGet<AnnouncementsResponse>(
        `/api/admin/announcements?page=${page}&pageSize=${ANN_PAGE_SIZE}`,
      ),
    staleTime: 30_000,
    placeholderData: (prev) => prev, // 翻页保留旧数据避免闪烁
  })

  const handleTogglePin = async (a: Announcement) => {
    setPinningId(a.id)
    try {
      await apiPut<Announcement>(`/api/admin/announcements/${a.id}`, {
        pinned: !a.pinned,
      })
      toast.success(a.pinned ? '已取消置顶' : '已置顶', {
        description: a.title,
      })
      qc.invalidateQueries({ queryKey: ['admin', 'announcements'] })
      qc.invalidateQueries({ queryKey: ['announcements'] })
    } catch (e) {
      const err = e as Error
      toast.error(err.message || '操作失败')
    } finally {
      setPinningId(null)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleting) return
    setDeletingSubmitting(true)
    try {
      await apiDelete(`/api/admin/announcements/${deleting.id}`)
      toast.success('公告已删除', { description: deleting.title })
      qc.invalidateQueries({ queryKey: ['admin', 'announcements'] })
      qc.invalidateQueries({ queryKey: ['announcements'] })
      setDeleting(null)
    } catch (e) {
      const err = e as Error
      toast.error(err.message || '删除失败')
    } finally {
      setDeletingSubmitting(false)
    }
  }

  const items = query.data?.items || []

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
            <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Megaphone className="size-5" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              公告管理
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            维护公告内容、置顶、类型;新建后即时对所有用户可见
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className="w-full sm:w-auto"
        >
          <Plus className="size-4" />
          新建公告
        </Button>
      </div>

      {query.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : query.isError ? (
        <Card>
          <CardContent className="flex items-center gap-2 px-4 py-6 text-sm text-destructive">
            <XCircle className="size-4" />
            {query.error?.message || '加载失败'}
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Megaphone className="size-7" />
            </div>
            <CardTitle className="text-lg">暂无公告</CardTitle>
            <CardDescription className="max-w-sm">
              新建第一条公告,告知用户系统更新或运营信息
            </CardDescription>
            <Button
              className="mt-2 w-full sm:w-auto"
              size="lg"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-4" />
              新建公告
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((a) => (
            <AnnouncementCard
              key={a.id}
              announcement={a}
              onEdit={(ann) => setEditing(ann)}
              onDelete={(ann) => setDeleting(ann)}
              onTogglePin={(ann) => handleTogglePin(ann)}
            />
          ))}
        </div>
      )}

      {!query.isLoading && items.length > 0 && (
        <div className="mt-4 space-y-2">
          {/* 分页(M-109):真分页 + 服务端 total */}
          <div className="text-center text-xs text-muted-foreground">
            共 {query.data?.total ?? items.length} 条公告
            {pinningId && ' · 处理中…'}
          </div>
          {(query.data?.total ?? 0) > ANN_PAGE_SIZE && (
            <PaginationFooter
              page={page}
              pageSize={ANN_PAGE_SIZE}
              total={query.data?.total ?? items.length}
              onPageChange={setPage}
            />
          )}
        </div>
      )}

      {/* 新建 Dialog */}
      <EditDialog
        mode="create"
        announcement={null}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />

      {/* 编辑 Dialog */}
      <EditDialog
        mode="edit"
        announcement={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
      />

      {/* 删除确认 */}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="size-5 text-rose-600" />
              确认删除公告
            </AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除公告「{deleting?.title}」,此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingSubmitting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={deletingSubmitting}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {deletingSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  处理中
                </>
              ) : (
                '确认删除'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  )
}
