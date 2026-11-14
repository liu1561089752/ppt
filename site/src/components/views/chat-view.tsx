/**
 * chat-view.tsx — AI 生成对话页(仿 z.ai 交互)
 *
 * 数据流:
 * - 事件来源:GET /api/generate/[taskId]/events?since=N(1.5s 轮询增量,断线可续)
 * - 数据源:原生管线写入的对话事件(thinking/answer/tool_call/status/error)
 * - 轮询增量拉取,支持断线续传与刷新恢复
 * - 事件归一化为消息条目:用户输入 / 思考折叠条 / 工具活动行 /
 *   回答(markdown) / 澄清问答题卡 / 状态行 / 错误
 * - 完成后展示预览 + 下载(复用 ppt-preview 与 download-token)
 */
'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Terminal,
  FilePen,
  Eye,
  Users,
  ListChecks,
  FolderSearch,
  FolderOpen,
  Zap,
  Globe,
  Wrench,
  MessageCircleQuestion,
  CheckCircle2,
  XCircle,
  Download,
  ArrowLeft,
  Sparkles,
  History as HistoryIcon,
  Bot,
  Square,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { apiGet, apiPost } from '@/lib/api-client'
import { useAppStore } from '@/store/app-store'
import { NativeDeckPreviewDialog } from '@/components/ppt-preview'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

// ----- 类型 -----

interface StreamEvent {
  seq: number
  type: string
  payload: Record<string, unknown>
}

type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; open: boolean }
  | {
      kind: 'tool'
      id: string
      toolCallId: string
      name: string
      response: { status: string; text: string } | null
    }
  | { kind: 'answer'; id: string; text: string }
  | { kind: 'status'; id: string; stage: string; status: string }
  | { kind: 'error'; id: string; text: string }

interface TaskMeta {
  id: string
  topic: string
  status: string
  progress: number
  progressStage: string | null
  errorMessage: string | null
  slideCount: number
  hasResult: boolean
  promptTokens: number | null
  completionTokens: number | null
  durationMs: number | null
}

// ----- 工具图标 -----

function toolIcon(name: string): React.ComponentType<{ className?: string }> {
  if (/bash|shell|cmd/i.test(name)) return Terminal
  if (/write|edit|multiedit/i.test(name)) return FilePen
  if (/read/i.test(name)) return Eye
  if (/task|agent/i.test(name)) return Users
  if (/todo/i.test(name)) return ListChecks
  if (/glob/i.test(name)) return FolderSearch
  if (/ls\b|^ls$/i.test(name)) return FolderOpen
  if (/websearch|search/i.test(name)) return Globe
  if (/skill/i.test(name)) return Zap
  if (/askuser|question/i.test(name)) return MessageCircleQuestion
  return Wrench
}

// ----- 事件归并为展示条目(增量式,支持上万事件的任务) -----

function createFolder() {
  const items: Item[] = []
  const toolIndexByCallId = new Map<string, number>()

  const push = (it: Item) => {
    items.push(it)
    return items.length - 1
  }

  return {
    items,
    push(ev: StreamEvent) {
      const id = String(ev.seq)
      switch (ev.type) {
        case 'user_prompt': {
          push({ kind: 'user', id, text: String(ev.payload.text ?? '') })
          break
        }
        case 'thinking': {
          const text = String(ev.payload.text ?? '')
          const last = items[items.length - 1]
          if (last && last.kind === 'thinking') last.text += text
          else push({ kind: 'thinking', id, text, open: false })
          break
        }
        case 'answer': {
          const text = String(ev.payload.text ?? '')
          const last = items[items.length - 1]
          if (last && last.kind === 'answer') last.text += text
          else push({ kind: 'answer', id, text })
          break
        }
        case 'tool_call': {
          const toolCallId = String(ev.payload.toolCallId ?? '')
          const name = String(ev.payload.name ?? '')
          const idx = push({
            kind: 'tool',
            id,
            toolCallId,
            name,
            response: null,
          })
          if (toolCallId) toolIndexByCallId.set(toolCallId, idx)
          break
        }
        case 'tool_response': {
          const toolCallId = String(ev.payload.toolCallId ?? '')
          const matched = toolCallId ? toolIndexByCallId.get(toolCallId) : undefined
          const idx =
            matched !== undefined
              ? matched
              : // 找最后一个还没有响应的工具行
                (() => {
                  for (let i = items.length - 1; i >= 0; i--) {
                    const it = items[i]
                    if (it.kind === 'tool' && it.response === null) return i
                  }
                  return -1
                })()
          if (idx >= 0) {
            const it = items[idx]
            if (it.kind === 'tool') {
              it.response = {
                status: String(ev.payload.status ?? ''),
                text: String(ev.payload.text ?? ''),
              }
            }
          }
          break
        }
        case 'status': {
          const status = String(ev.payload.status ?? '')
          const stage = String(ev.payload.stage ?? status)
          // 合并连续状态行
          const last = items[items.length - 1]
          if (last && last.kind === 'status') {
            last.stage = stage
            last.status = status
          } else {
            push({ kind: 'status', id, stage, status })
          }
          break
        }
        case 'error': {
          push({ kind: 'error', id, text: String(ev.payload.message ?? '生成出错') })
          break
        }
        default:
          break
      }
    },
  }
}

// ----- 子组件 -----

function ThinkingBlock({ item, running }: { item: Extract<Item, { kind: 'thinking' }>; running: boolean }) {
  const [open, setOpen] = React.useState(false)
  const isLast = running
  return (
    <div className="rounded-lg border bg-muted/40 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {isLast && !open ? (
          <span className="flex items-center gap-2">
            <Loader2 className="size-3 animate-spin" />
            思考中…
          </span>
        ) : (
          <span>思考过程</span>
        )}
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {item.text}
        </div>
      )}
    </div>
  )
}

function ToolRow({ item }: { item: Extract<Item, { kind: 'tool' }>; running?: boolean }) {
  const [open, setOpen] = React.useState(false)
  // toolIcon 返回模块级图标组件的引用,并非渲染期新建组件
  const Icon = toolIcon(item.name)
  const pending = item.response === null
  const isError = item.response?.status === 'error'
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-muted-foreground hover:bg-muted/50"
      >
        {/* toolIcon 返回模块级图标组件引用,非渲染期新建,规则误报 */}
        {/* eslint-disable-next-line react-hooks/static-components */}
        <Icon className={cn('size-3.5 shrink-0', pending && 'animate-pulse')} />
        <span className="font-medium text-foreground/80">{item.name}</span>
        {pending ? (
          <span className="flex items-center gap-1 text-xs">
            <Loader2 className="size-3 animate-spin" />
            执行中
          </span>
        ) : isError ? (
          <span className="text-xs text-destructive">失败</span>
        ) : (
          <CheckCircle2 className="size-3 text-emerald-500" />
        )}
      </button>
      {open && item.response?.text && (
        <div className="ml-6 mt-0.5 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
          {item.response.text}
        </div>
      )}
    </div>
  )
}

// ----- 主组件 -----

export default function ChatView() {
  const activeTaskId = useAppStore((s) => s.activeTaskId)
  const setView = useAppStore((s) => s.setView)

  const [previewOpen, setPreviewOpen] = React.useState(false)
  // 展示条目(由事件增量折叠而来)
  const [items, setItems] = React.useState<Item[]>([])

  const lastSeqRef = React.useRef(0)
  const scrollRef = React.useRef<HTMLDivElement>(null)
  // 大任务(上万事件)优化:事件先入缓冲区,定时批量增量折叠,避免逐条重渲染
  const folderRef = React.useRef<ReturnType<typeof createFolder> | null>(null)
  const pendingRef = React.useRef<StreamEvent[]>([])
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // 任务元信息(进行中每 4s 轮询)
  const {
    data: task,
    refetch: refetchTask,
    isError: taskMetaError,
    error: taskMetaErrorObj,
  } = useQuery<TaskMeta>({
    queryKey: ['task', activeTaskId],
    enabled: !!activeTaskId,
    queryFn: () => apiGet<TaskMeta>(`/api/tasks/${activeTaskId}`),
    refetchInterval: (q) => {
      const st = q.state.data?.status
      return st && ['succeeded', 'failed', 'refunded', 'cancelled'].includes(st) ? false : 4000
    },
  })

  const isActive = !!task && !['succeeded', 'failed', 'refunded', 'cancelled'].includes(task.status)

  // 任务切换时重置
  React.useEffect(() => {
    lastSeqRef.current = 0
    folderRef.current = createFolder()
    pendingRef.current = []
// eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开/对象切换时重置本地状态(既定模式,一次性渲染开销,非派生状态)
    setItems([])
    return () => {
      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
    }
  }, [activeTaskId])

  // 事件入缓冲区 + 定时批量折叠
  const queueEvents = React.useCallback((list: StreamEvent[]) => {
    if (list.length === 0) return
    pendingRef.current.push(...list)
    if (flushTimerRef.current != null) return
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      const batch = pendingRef.current
      if (batch.length === 0) return
      pendingRef.current = []
      const folder = folderRef.current ?? (folderRef.current = createFolder())
      for (const ev of batch) folder.push(ev)
      setItems([...folder.items])
    }, 350)
  }, [])

  const flushNow = React.useCallback(() => {
    if (flushTimerRef.current != null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    const batch = pendingRef.current
    if (batch.length === 0) return
    pendingRef.current = []
    const folder = folderRef.current ?? (folderRef.current = createFolder())
    for (const ev of batch) folder.push(ev)
    setItems([...folder.items])
  }, [])

  // 数据通道:react-query 轮询增量拉取(流式响应会被各类代理/隧道缓冲,轮询最稳)。
  // 后台标签页自动暂停(refetchIntervalInBackground 默认 false),不再空转打点。
  // question_pending 期间也继续轮询,以便自动感知状态流转。
  const eventsQuery = useQuery<{
    events: StreamEvent[]
    status: string
    errorMessage: string | null
  }>({
    queryKey: ['task-events', activeTaskId],
    enabled: !!activeTaskId,
    queryFn: () => apiGet(`/api/generate/${activeTaskId}/events?since=${lastSeqRef.current}`),
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (q) => {
      const st = q.state.data?.status
      return st && ['succeeded', 'failed', 'refunded', 'cancelled'].includes(st) ? false : 1500
    },
  })

  // 新事件到达 → 入缓冲区折叠;到达终态 → 立即冲刷并刷新任务元信息
  React.useEffect(() => {
    const res = eventsQuery.data
    if (!res || !activeTaskId) return
    if (res.events.length > 0) {
      lastSeqRef.current = res.events[res.events.length - 1].seq
      queueEvents(res.events)
    }
    if (['succeeded', 'failed', 'refunded', 'cancelled'].includes(res.status)) {
      flushNow()
      refetchTask()
    }
  }, [eventsQuery.data, activeTaskId, queueEvents, flushNow, refetchTask])

  // 自动滚动(仅在接近底部时跟随,避免回看历史被强行拉底)
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [items, task?.status])

  const handleDownload = async () => {
    if (!activeTaskId) return
    try {
      const res = await apiPost<{ downloadUrl: string }>(
        `/api/tasks/${activeTaskId}/create-download-token`,
        {},
      )
      const a = document.createElement('a')
      a.href = res.downloadUrl
      a.download = 'chatppt.pptx'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (e) {
      toast.error((e as Error).message || '下载失败')
    }
  }

  // 生成中手动取消(M-18):调 cancel 路由,成功后刷新任务元信息与事件流
  const [cancelling, setCancelling] = React.useState(false)
  const handleCancel = async () => {
    if (!activeTaskId || !task) return
    if (!window.confirm(`确定停止「${task.topic.slice(0, 30)}」吗?消耗的次数会退回。`)) return
    setCancelling(true)
    try {
      await apiPost(`/api/tasks/${activeTaskId}/cancel`, {})
      toast.success('任务已停止,次数已退回')
      refetchTask()
    } catch (e) {
      toast.error((e as Error).message || '取消失败')
    } finally {
      setCancelling(false)
    }
  }

  // ----- 空状态 -----
  if (!activeTaskId) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-4 py-16 text-center">
        <Bot className="size-10 text-muted-foreground" />
        <p className="text-muted-foreground">还没有进行中的生成对话</p>
        <Button onClick={() => setView('generate')} className="gap-1.5">
          <Sparkles className="size-4" />
          去生成 PPT
        </Button>
      </div>
    )
  }

  const lastItem = items[items.length - 1]
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="mx-auto flex h-[calc(100vh-9rem)] w-full max-w-3xl flex-col px-4 py-4 sm:px-6"
    >
      {/* 头部 */}
      <div className="mb-3 flex items-center gap-3">
        <Button size="icon" variant="ghost" className="size-8 shrink-0" onClick={() => setView('history')}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold sm:text-lg">{task?.topic ?? '加载中…'}</h1>
          <p className="text-xs text-muted-foreground">
            {task?.progressStage ?? ''}
            {/* 进度百分比(M-07):progress 字段已在 TaskMeta,生成中才有意义 */}
            {task && isActive ? ` · ${task.progress}%` : ''}
            {task?.promptTokens ? ` · 累计 ${(task.promptTokens + (task.completionTokens ?? 0)).toLocaleString()} tokens` : ''}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 gap-1"
          onClick={() => setView('history')}
        >
          <HistoryIcon className="size-3.5" />
          任务列表
        </Button>
      </div>

      {/* 对话流 */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto rounded-lg border bg-card p-3 sm:p-4">
        {taskMetaError && !task ? (
          <Card>
            <CardContent className="flex flex-col items-start gap-3 px-4 py-6">
              <div className="flex items-center gap-2 text-destructive">
                <XCircle className="size-4" />
                <span className="font-medium">加载失败</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {taskMetaErrorObj?.message || '任务信息加载失败,请稍后重试'}
              </p>
              <Button variant="outline" size="sm" onClick={() => refetchTask()}>
                重试
              </Button>
            </CardContent>
          </Card>
        ) : !task && (
          <div className="space-y-3">
            <Skeleton className="h-16 w-3/4" />
            <Skeleton className="h-10 w-1/2" />
          </div>
        )}

        {items.map((item) => {
          switch (item.kind) {
            case 'user':
              return (
                <div key={item.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
                    {item.text}
                  </div>
                </div>
              )
            case 'thinking':
              return <ThinkingBlock key={item.id} item={item} running={lastItem === item && isActive} />
            case 'tool':
              return <ToolRow key={item.id} item={item} running={isActive} />
            case 'answer':
              return (
                <div key={item.id} className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
                  <ReactMarkdown>{item.text}</ReactMarkdown>
                </div>
              )
            case 'status':
              return (
                <div key={item.id} className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {item.stage}
                </div>
              )
            case 'error':
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <XCircle className="size-4 shrink-0" />
                  {item.text}
                </div>
              )
            default:
              return null
          }
        })}

        {/* 生成中:时间线尾部"停止生成"(M-18) */}
        {isActive && (
          <div className="flex justify-center pt-2">
            <Button
              size="sm"
              variant="outline"
              disabled={cancelling}
              onClick={handleCancel}
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {cancelling ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Square className="size-3.5" />
              )}
              停止生成
            </Button>
          </div>
        )}

        {/* 完成卡片 */}
        {task?.status === 'succeeded' && (
          <Card className="border-emerald-500/30 bg-emerald-500/[0.06]">
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="size-5 shrink-0 text-emerald-500" />
                <div>
                  <p className="text-sm font-medium">PPT 生成完成</p>
                  <p className="text-xs text-muted-foreground">
                    {task.durationMs ? `耗时 ${Math.round(task.durationMs / 60000)} 分钟 · ` : ''}
                    可在线预览或下载 .pptx
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {/* 预览数据来自 deckSpec(GET /api/tasks/[id]/spec);旧任务没有 spec 时
                    弹窗内显示"该任务无预览数据"——不再依赖磁盘上的幻灯片目录 */}
                {task.hasResult && (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setPreviewOpen(true)}>
                    <Eye className="size-4" />
                    在线预览
                  </Button>
                )}
                {task.status === 'succeeded' && task.hasResult && (
                  <Button size="sm" className="gap-1.5" onClick={handleDownload}>
                    <Download className="size-4" />
                    下载 PPT
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}
        {(task?.status === 'refunded' || task?.status === 'failed' || task?.status === 'cancelled') && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm">
            <XCircle className="size-4 shrink-0 text-destructive" />
            <span>
              {task?.status === 'cancelled'
                ? '任务已手动取消，消耗的次数已退回'
                : `生成失败${task?.errorMessage ? `：${task.errorMessage}` : ''}（消耗的次数已自动退回）`}
            </span>
          </div>
        )}
      </div>

      {/* 预览弹窗 */}
      <NativeDeckPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        topic={task?.topic ?? 'PPT'}
        taskId={activeTaskId}
        downloadFilename={`${(task?.topic ?? 'chatppt').slice(0, 40)}.pptx`}
      />
      {/* downloadToken 预留(下载走 create-download-token) */}
    </motion.div>
  )
}
