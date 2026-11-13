/**
 * generate-view.tsx — 生成 PPT 视图
 *
 * 顶部展示剩余次数(0 时提示去兑换)
 * 表单:topic / preset / audience / tone / language / slideCount / customRequirements
 * 提交:uuid v4 → /api/generate → 成功后 openChat(taskId)
 *
 * 管线是原生链路的五个阶段:调研 → 规划 → 生成规格(Deck Spec) → 构建 PPTX → 校验,
 * 阶段文案由服务端 progressStage 推进,这里只做"链路预览"说明。
 *
 * 响应式:mobile-first,max-w-3xl 单栏
 */
'use client'

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { v4 as uuidv4 } from 'uuid'
import { motion } from 'framer-motion'
import {
  Sparkles,
  Coins,
  Loader2,
  Send,
  ArrowRight,
  Info,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { apiPost } from '@/lib/api-client'
import { useAppStore } from '@/store/app-store'
import { useCurrentUser, CURRENT_USER_QUERY_KEY } from '@/hooks/use-current-user'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// ----- 类型 -----
interface GenerateResponse {
  taskId: string
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'refunded' | 'cancelled'
}

// ----- 常量 -----
// 详细预设:每种带说明,让用户清楚知道每种风格的特征
const PRESET_OPTIONS = [
  {
    value: 'business',
    label: '商务专业',
    description: '白底深蓝/橙色点缀,简洁高效,适合汇报、商业计划书',
    emoji: '💼',
  },
  {
    value: 'tech',
    label: '深色科技',
    description: '深色背景 + 青色高光,科技感强,适合 AI/产品/技术分享',
    emoji: '🚀',
  },
  {
    value: 'education',
    label: '教育温暖',
    description: '米黄暖色 + 红色侧栏,亲和力强,适合教学/培训/招生',
    emoji: '📚',
  },
  {
    value: 'marketing',
    label: '营销活力',
    description: '玫粉色调,视觉冲击力强,适合营销/品牌/增长方案',
    emoji: '🎯',
  },
  {
    value: 'minimal',
    label: '极简白',
    description: '纯白底 + 黑色文字 + 单色强调,内容为王,适合学术/正式',
    emoji: '⚪',
  },
  {
    value: 'creative',
    label: '创意设计',
    description: '彩色渐变 + 几何块,版式自由,适合创意/品牌发布',
    emoji: '🎨',
  },
  {
    value: 'custom',
    label: '自定义风格',
    description: '描述你想要的风格,AI 按你的描述生成',
    emoji: '✨',
  },
] as const

const LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
] as const

/** 原生链路的阶段(与 GenerationTask.progressStage 文案一致) */
const NATIVE_STAGES = ['调研', '规划', '生成规格', '构建 PPTX', '校验'] as const

// 页数可选 6-25,预设 8 档方便选择
const SLIDE_COUNT_OPTIONS = [6, 8, 10, 12, 15, 18, 20, 25] as const
const MIN_SLIDES = 6
const MAX_SLIDES = 25
const MAX_CUSTOM_STYLE = 500
const MAX_CUSTOM_REQ = 2000

const generateSchema = z
  .object({
    topic: z
      .string()
      .trim()
      .min(3, '主题至少 3 个字符')
      .max(500, '主题最多 500 个字符'),
    preset: z.string(),
    customStyle: z.string().max(MAX_CUSTOM_STYLE, '自定义风格最多 500 字符'),
    customRequirements: z.string().max(MAX_CUSTOM_REQ, '额外要求最多 2000 字符'),
    audience: z.string().max(200, '受众描述过长'),
    tone: z.string().max(100, '语气描述过长'),
    language: z.string(),
    slideCount: z.number().int().min(MIN_SLIDES).max(MAX_SLIDES),
  })
  .superRefine((data, ctx) => {
    if (data.preset === 'custom' && data.customStyle.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['customStyle'],
        message: '请描述自定义风格',
      })
    }
  })

type GenerateFormValues = z.infer<typeof generateSchema>

// ----- 主组件 -----
export default function GenerateView() {
  const { data: user } = useCurrentUser()
  const setView = useAppStore((s) => s.setView)
  const openChat = useAppStore((s) => s.openChat)
  const queryClient = useQueryClient()

  const [submitting, setSubmitting] = React.useState(false)
  // 幂等 requestId(M-37):提交失败后重试复用同一 id(服务端按 requestId 幂等,
  // 避免响应丢失时重试变成第二个任务再扣一次);成功/重置表单/修改话题才换新
  const requestIdRef = React.useRef<string | null>(null)

  const form = useForm<GenerateFormValues>({
    resolver: zodResolver(generateSchema),
    defaultValues: {
      topic: '',
      preset: '',
      customStyle: '',
      customRequirements: '',
      audience: '',
      tone: '',
      language: 'zh-CN',
      slideCount: 8,
    },
  })

  // 监听 preset 值,判断是否显示自定义风格
  const presetValue = form.watch('preset')
  const isCustomStyle = presetValue === 'custom'
  // 自定义页数:下拉选项中若选择"custom"则启用 number input
  const slideCountValue = form.watch('slideCount')
  const isCustomSlideCount = !SLIDE_COUNT_OPTIONS.includes(slideCountValue as (typeof SLIDE_COUNT_OPTIONS)[number])

  // 话题被修改 = 新意图,丢弃上次失败提交占用的 requestId
  const topicValue = form.watch('topic')
  React.useEffect(() => {
    requestIdRef.current = null
  }, [topicValue])

  const remaining = user?.remainingCredits ?? 0
  const canSubmit = remaining >= 1 && !submitting

  // ----- 提交 -----
  const onSubmit = async (values: GenerateFormValues) => {
    if (remaining < 1) {
      toast.error('生成次数不足,请先兑换')
      setView('redeem')
      return
    }

    const requestId = requestIdRef.current ?? (requestIdRef.current = uuidv4())
    setSubmitting(true)
    const toastId = 'generate-task'
    toast.loading('正在提交生成请求…', { id: toastId })
    try {
      const res = await apiPost<GenerateResponse>('/api/generate', {
        requestId,
        topic: values.topic,
        audience: values.audience || undefined,
        tone: values.tone || undefined,
        // 'custom' 是前端标记,传到后端无意义,改为 undefined
        preset: values.preset && values.preset !== 'custom' ? values.preset : undefined,
        customStyle: isCustomStyle && values.customStyle ? values.customStyle : undefined,
        customRequirements: values.customRequirements || undefined,
        language: values.language,
        slideCount: values.slideCount,
      })
      // 立即失效当前用户缓存,让导航栏剩余次数徽章同步更新
      queryClient.invalidateQueries({ queryKey: CURRENT_USER_QUERY_KEY })
      // 提交成功:下一次生成换新 requestId
      requestIdRef.current = null
      toast.success('任务已创建,正在开始生成…', { id: toastId })
      openChat(res.taskId)
    } catch (e) {
      const err = e as Error & { code?: string }
      toast.error(err.message || '生成请求失败', { id: toastId })
      if (err.code === 'INSUFFICIENT_CREDITS') {
        setView('redeem')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8"
    >
      <div className="mb-6 flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-md bg-amber-500/15 text-amber-600">
          <Sparkles className="size-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            生成 PPT
          </h1>
          <p className="text-sm text-muted-foreground">
            输入主题,AI 自动完成调研与版式设计,产出原生可编辑的 .pptx
          </p>
          {/* 原生链路:阶段文案与服务端 progressStage 一致(调研/规划/生成规格/构建 PPTX/校验) */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <span className="opacity-70">原生链路</span>
            {NATIVE_STAGES.map((stage, i) => (
              <span key={stage} className="flex items-center gap-1">
                {i > 0 && <ArrowRight className="size-3 opacity-40" />}
                <span className="rounded bg-muted px-1.5 py-0.5">{stage}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 剩余次数提示 */}
      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'flex size-10 items-center justify-center rounded-full',
                remaining > 0
                  ? 'bg-amber-500/15 text-amber-600'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              <Coins className="size-5" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">当前剩余次数</p>
              <p className="text-2xl font-semibold tabular-nums">
                {remaining}
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  次
                </span>
              </p>
            </div>
          </div>
          {remaining < 1 ? (
            <Button
              variant="default"
              className="w-full sm:w-auto"
              onClick={() => setView('redeem')}
            >
              前往兑换
              <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Badge variant="secondary">每次生成消耗 1 次</Badge>
          )}
        </CardContent>
      </Card>

      {remaining < 1 && (
        <Alert variant="destructive" className="mb-4">
          <Info className="size-4" />
          <AlertTitle>生成次数已用完</AlertTitle>
          <AlertDescription>
            请前往「卡密兑换」页面输入卡密获取生成次数。
          </AlertDescription>
        </Alert>
      )}

      {/* 生成表单 */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">填写生成参数</CardTitle>
          <CardDescription>
            主题必填,其它参数可选,留空则使用默认值
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-5"
            aria-label="生成 PPT 表单"
          >
            {/* 主题 */}
            <div className="space-y-2">
              <Label htmlFor="topic">
                主题 <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="topic"
                placeholder="例如:Q4 产品策略汇报 / 人工智能在医疗领域的应用 / 公司入职培训"
                rows={3}
                maxLength={500}
                disabled={submitting}
                {...form.register('topic')}
              />
              <div className="flex items-center justify-between text-xs">
                {form.formState.errors.topic ? (
                  <span className="text-destructive">
                    {form.formState.errors.topic.message}
                  </span>
                ) : (
                  <span className="text-muted-foreground">3 - 500 字符</span>
                )}
                <span className="text-muted-foreground tabular-nums">
                  {(form.watch('topic') || '').length}/500
                </span>
              </div>
            </div>

            {/* 预设 + 语言 */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="preset">预设风格</Label>
                <Controller
                  control={form.control}
                  name="preset"
                  render={({ field }) => (
                    <Select
                      value={field.value || 'none'}
                      onValueChange={(v) => field.onChange(v === 'none' ? '' : v)}
                      disabled={submitting}
                    >
                      <SelectTrigger id="preset" className="w-full">
                        <SelectValue placeholder="自动选择" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">自动选择(根据主题推断)</SelectItem>
                        {PRESET_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            <span className="flex items-center gap-2">
                              <span>{o.emoji}</span>
                              <span className="font-medium">{o.label}</span>
                              <span className="text-xs text-muted-foreground truncate">· {o.description}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {/* 当前选中预设的详细说明 */}
                {presetValue && presetValue !== 'none' && presetValue !== 'custom' && (
                  <p className="text-xs text-muted-foreground">
                    {PRESET_OPTIONS.find(o => o.value === presetValue)?.emoji}{' '}
                    {PRESET_OPTIONS.find(o => o.value === presetValue)?.description}
                  </p>
                )}
                <p className="text-xs text-muted-foreground/80">
                  风格意向,由规划阶段映射到原生主题预设(配色/字体/间距)
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="language">输出语言</Label>
                <Controller
                  control={form.control}
                  name="language"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={submitting}
                    >
                      <SelectTrigger id="language" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LANGUAGE_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>

            {/* 自定义风格描述(仅当 preset = 'custom' 时显示) */}
            {isCustomStyle && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="space-y-2"
              >
                <Label htmlFor="customStyle">
                  自定义风格描述 <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="customStyle"
                  placeholder="用一段话描述你想要的 PPT 风格,例如:&#10;- 极简白色背景,黑色无衬线字体,适合科技公司发布会&#10;- 红色为主色,加大量数据图表,适合财报会议&#10;- 卡通插画风,适合幼儿园教学"
                  rows={4}
                  maxLength={MAX_CUSTOM_STYLE}
                  disabled={submitting}
                  {...form.register('customStyle')}
                />
                <div className="flex items-center justify-between text-xs">
                  {form.formState.errors.customStyle ? (
                    <span className="text-destructive">
                      {form.formState.errors.customStyle.message}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      AI 会根据你的描述生成对应风格的大纲(可包含配色、版式、语气等)
                    </span>
                  )}
                  <span className="text-muted-foreground tabular-nums">
                    {(form.watch('customStyle') || '').length}/{MAX_CUSTOM_STYLE}
                  </span>
                </div>
              </motion.div>
            )}

            {/* 受众 + 语气 */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="audience">受众(可选)</Label>
                <Input
                  id="audience"
                  placeholder="例如:管理层 / 技术团队 / 普通观众"
                  maxLength={200}
                  disabled={submitting}
                  {...form.register('audience')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tone">语气(可选)</Label>
                <Input
                  id="tone"
                  placeholder="例如:专业、简洁 / 生动、活泼"
                  maxLength={100}
                  disabled={submitting}
                  {...form.register('tone')}
                />
              </div>
            </div>

            {/* 张数 */}
            <div className="space-y-2">
              <Label htmlFor="slideCount">幻灯片张数</Label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Controller
                  control={form.control}
                  name="slideCount"
                  render={({ field }) => (
                    <Select
                      value={isCustomSlideCount ? 'custom' : String(field.value)}
                      onValueChange={(v) => {
                        if (v === 'custom') {
                          // 切到自定义,设为一个不在预设的值,触发 number input
                          field.onChange(7) // 默认值,介于 6 和 8 之间
                        } else {
                          field.onChange(parseInt(v, 10))
                        }
                      }}
                      disabled={submitting}
                    >
                      <SelectTrigger id="slideCount" className="w-full sm:w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SLIDE_COUNT_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n} 张
                          </SelectItem>
                        ))}
                        <SelectItem value="custom">自定义...</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
                {isCustomSlideCount && (
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={MIN_SLIDES}
                      max={MAX_SLIDES}
                      value={slideCountValue}
                      onChange={(e) => {
                        // 输入过程允许自由输入(12/15/20/25 逐位敲键不会被 clamp 吞掉)
                        const n = parseInt(e.target.value, 10)
                        if (Number.isFinite(n)) {
                          form.setValue('slideCount', n)
                        }
                      }}
                      onBlur={() => {
                        // 失焦时才 clamp 进合法范围(含输入被清空的情况回落到默认 8)
                        const n = Number(slideCountValue)
                        if (!Number.isFinite(n)) {
                          form.setValue('slideCount', 8)
                          return
                        }
                        form.setValue('slideCount', Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, n)))
                      }}
                      disabled={submitting}
                      className="w-20"
                    />
                    <span className="text-xs text-muted-foreground">
                      ({MIN_SLIDES}-{MAX_SLIDES})
                    </span>
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                可在 {MIN_SLIDES} - {MAX_SLIDES} 张之间选择,或自定义任意数字
              </p>
            </div>

            {/* 万能输入框:额外要求 */}
            <div className="space-y-2">
              <Label htmlFor="customRequirements" className="flex items-center gap-1.5">
                <Sparkles className="size-3.5" />
                额外要求(可选)
              </Label>
              <Textarea
                id="customRequirements"
                placeholder={'在这里告诉 AI 任何额外要求,例如:\n- 每页加一句金句\n- 数据要尽量用最新公开数据\n- 第 3 页做一个对比表格\n- 封面加副标题\n- 整体风格类似 Apple 发布会'}
                rows={4}
                maxLength={MAX_CUSTOM_REQ}
                disabled={submitting}
                {...form.register('customRequirements')}
              />
              <div className="flex items-center justify-between text-xs">
                {form.formState.errors.customRequirements ? (
                  <span className="text-destructive">
                    {form.formState.errors.customRequirements.message}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    AI 会按这些要求额外调整生成结果,可留空
                  </span>
                )}
                <span className="text-muted-foreground tabular-nums">
                  {(form.watch('customRequirements') || '').length}/{MAX_CUSTOM_REQ}
                </span>
              </div>
            </div>

            {/* 提交按钮 */}
            <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-end">
              <Button
                type="button"
                variant="ghost"
                className="sm:order-1"
                onClick={() => {
                  // 重置表单 = 放弃上次提交上下文,requestId 一并换新
                  requestIdRef.current = null
                  form.reset({
                    topic: '',
                    preset: '',
                    customStyle: '',
                    customRequirements: '',
                    audience: '',
                    tone: '',
                    language: 'zh-CN',
                    slideCount: 8,
                  })
                }}
                disabled={submitting}
              >
                重置
              </Button>
              <Button
                type="submit"
                size="lg"
                className="sm:order-2 sm:min-w-32"
                disabled={!canSubmit}
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    提交中
                  </>
                ) : (
                  <>
                    <Send className="size-4" />
                    立即生成
                  </>
                )}
              </Button>
            </div>
            {remaining < 1 && (
              <p className="text-right text-xs text-destructive">
                次数不足,无法生成
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </motion.div>
  )
}
