/**
 * 业务元数据(状态/原因/预设标签) —— 全站唯一定义。
 * 原先散落在 history-view / admin-users-view / profile-view /
 * admin-credit-changes-view / generate-view 等 5+ 处,文案互相漂移。
 */
import {
  Hourglass,
  Loader2,
  MessageCircleQuestion,
  CheckCircle2,
  XCircle,
  RefreshCcw,
  PauseCircle,
  Plus,
  Minus,
  RotateCcw,
  Settings2,
  type LucideIcon,
} from 'lucide-react'

export type TaskStatus =
  | 'pending'
  | 'starting'
  | 'question_pending'
  | 'answering'
  | 'generating'
  | 'stage1'
  | 'stage2'
  | 'stage3'
  | 'stage4'
  | 'finalizing'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'refunded'
  | 'cancelled'

export interface StatusMeta {
  label: string
  className: string
  icon: React.ComponentType<{ className?: string }>
}

/** 进行中(琥珀) / 成功(绿) / 失败(红) / 取消(灰) 四档配色 */
const ACTIVE = 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400'
const OK = 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
const BAD = 'border-transparent bg-destructive/15 text-destructive'
const IDLE = 'border-transparent bg-muted text-muted-foreground'

export const TASK_STATUS_META: Record<TaskStatus, StatusMeta> = {
  pending: { label: '排队中', className: ACTIVE, icon: Hourglass },
  starting: { label: '启动任务', className: ACTIVE, icon: Loader2 },
  question_pending: { label: '等待确认需求', className: 'border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400', icon: MessageCircleQuestion },
  answering: { label: '提交你的选择', className: ACTIVE, icon: Loader2 },
  generating: { label: 'AI 生成中', className: ACTIVE, icon: Loader2 },
  stage1: { label: '收集需求', className: ACTIVE, icon: Loader2 },
  stage2: { label: '搜索素材', className: ACTIVE, icon: Loader2 },
  stage3: { label: '规划布局', className: ACTIVE, icon: Loader2 },
  stage4: { label: '渲染幻灯片', className: ACTIVE, icon: Loader2 },
  finalizing: { label: '导出 PPTX', className: ACTIVE, icon: Loader2 },
  processing: { label: '生成中', className: ACTIVE, icon: Loader2 },
  succeeded: { label: '已完成', className: OK, icon: CheckCircle2 },
  failed: { label: '失败', className: BAD, icon: XCircle },
  refunded: { label: '已退款', className: BAD, icon: RefreshCcw },
  cancelled: { label: '已取消', className: IDLE, icon: PauseCircle },
}

/** 兼容:状态集合,判断任务是否进行中 */
export const ACTIVE_STATUSES: TaskStatus[] = [
  'pending',
  'starting',
  'question_pending',
  'answering',
  'generating',
  'stage1',
  'stage2',
  'stage3',
  'stage4',
  'finalizing',
  'processing',
]

export function isTaskActive(status: string): boolean {
  return ACTIVE_STATUSES.includes(status as TaskStatus)
}

export function statusMeta(status: string): StatusMeta {
  return (
    TASK_STATUS_META[status as TaskStatus] ?? {
      label: status,
      className: IDLE,
      icon: Loader2,
    }
  )
}

// ---------- 积分流水原因 ----------

export type CreditReason = 'redeem' | 'generate' | 'refund' | 'admin_adjust'

export interface ReasonMeta {
  label: string
  className: string
  icon: LucideIcon
}

export const CREDIT_REASON_META: Record<CreditReason, ReasonMeta> = {
  redeem: { label: '兑换', className: OK, icon: Plus },
  generate: { label: '生成消耗', className: 'border-transparent bg-primary/10 text-primary', icon: Minus },
  refund: { label: '退款', className: OK, icon: RotateCcw },
  admin_adjust: { label: '管理员调整', className: ACTIVE, icon: Settings2 },
}

export function reasonMeta(reason: string): ReasonMeta {
  return CREDIT_REASON_META[reason as CreditReason] ?? { label: reason, className: IDLE, icon: Settings2 }
}

// ---------- 预设/语言标签 ----------

/** 后端合法预设 → 短标签(与 generate-view 的 PRESET_OPTIONS 保持同名 value) */
export const PRESET_LABELS: Record<string, string> = {
  business: '商务',
  tech: '技术',
  education: '教育',
  marketing: '营销',
  minimal: '极简',
  creative: '创意',
  // 原生链路的第 7 个预设(色板见 pptx-prompts.ts 的 PRESET_THEMES):
  // 表单暂未铺开,API 直接传 preset=clay 时列表/详情页也要有名字可显示
  clay: '陶土',
}

export const LANGUAGE_LABELS: Record<string, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
  'ja-JP': '日本語',
}
