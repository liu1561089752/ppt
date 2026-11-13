/**
 * pipeline/types.ts — 管线共享类型
 *
 * 原生链路(S2 调研 → S3 大纲 → S4 Deck Spec → S5 引擎构建)的类型契约。
 * HTML 时代的常量(转换超时、转换并发、单页渲染重试上限)随旧链路一起删除:
 * 它们只被已下线的渲染/转换模块引用。
 */

export interface GenerateInput {
  taskId: string
  userId: string
  topic: string
  audience?: string | null
  tone?: string | null
  preset?: string | null
  customStyle?: string | null
  customRequirements?: string | null
  language: string
  slideCount: number
}

/** 任务终态(退款/取消/超时判定共用;终态后不再写入进度/事件) */
export const FINAL_STATUSES = ['succeeded', 'failed', 'refunded', 'cancelled']

// ── S3 大纲 ────────────────────────────────────────────────────────────────

/** 一页的大纲:标题 + 页面原型(引擎模板名) + 内容要点 */
export interface PageOutline {
  title: string
  template: string
  brief: string
  /** 页面核心结论,供规格阶段保持信息焦点 */
  keyMessage?: string
  /** 视觉表达意图,描述应该让观众看到/比较/理解什么 */
  visualIntent?: string
  /** 对应研究来源标题或 URL,只引用真实证据 */
  evidenceRefs?: string[]
}

/** S3 产物:只在"讲什么"层面做决定,不产出任何样式/坐标 */
export interface OutlinePlan {
  title: string
  styleName: string
  /** 引擎主题预设名(ink / sand / sage / clay),见 themes/presets.js */
  preset: string
  pages: PageOutline[]
}

// ── S4 Deck Spec(引擎 core/schema.js 的真值)────────────────────────────────

/**
 * Deck Spec 的元素。字段随 type 而变,真值在引擎 core/schema.js;
 * 这里只钉住 type,其余按引擎契约透传(不做二次建模,免得两处漂移)。
 */
export type DeckElement = { type: string } & Record<string, unknown>

/** 一页。`template` 是给站点预览用的页面原型名,引擎不校验也不读它。 */
export interface DeckSlide {
  template?: string
  background?: string
  notes?: string
  margin?: number
  startY?: number
  gap?: number
  elements: DeckElement[]
}

export interface DeckTheme {
  name?: string
  colors: Record<string, string>
  fonts: { heading: string; body: string; numeric?: string }
  sizes?: Record<string, number>
  spacing?: Record<string, number>
  radii?: Record<string, number>
  [key: string]: unknown
}

/** 交给引擎的整份 Deck Spec(--check 接受的最小真值是 slides[]) */
export interface DeckSpecJson {
  title: string
  author?: string
  language?: string
  pageSize?: 'wide' | 'standard' | { width: number; height: number }
  theme: DeckTheme
  slides: DeckSlide[]
}

// ── S5 引擎桥 ──────────────────────────────────────────────────────────────

/**
 * 预览用的最终几何:引擎 `--layout-out` 里那一份"写入器真正用过的盒子"，
 * 裁到显示所需的白名单字段。站点预览按它渲染,不按 deckSpec 猜坐标
 * (流式 spec 的 text 元素没有 x/y,坐标只有构建期才存在)。
 */
export interface PreviewElement {
  type: string
  x: number
  y: number
  w: number
  h: number
  text?: string
  fontSize?: number
  fontFace?: string
  bold?: boolean
  italic?: boolean
  color?: string
  align?: string
  valign?: string
  fill?: string | null
  lineColor?: string | null
  lineWidth?: number
  radius?: number
  rotate?: number
  gradient?: { angle?: number; stops: Array<{ color: string; position: number }> }
  rows?: string[][]
  chartType?: string
  data?: Array<{ name?: string; labels: unknown[]; values: number[] }>
  chartColors?: string[]
  hasImage?: true
}

export interface PreviewSlide {
  elements: PreviewElement[]
}

/** 引擎构建结果(§5 合同字段在前,附加字段一律可选) */
export interface NativeBuildResult {
  ok: boolean
  warnings: number
  bytes: number
  objects: Record<string, number>
  /** 完整构建报告 JSON(字符串):stdout JSON + warningDetails + stderr + 耗时 */
  report: string
  slides?: number
  warningsByCode?: Record<string, number>
  warningDetails?: Array<{ slide?: number | null; code: string; message: string }>
  layout?: PreviewSlide[]
  pageSize?: { width: number; height: number }
  ms?: number
  /** 失败原因(已含引擎 stderr 原文) */
  error?: string
}

/** `--check` 结果 */
export interface SpecCheckResult {
  ok: boolean
  errors: string[]
  slides?: number
}

/** 引擎就绪探测结果 */
export interface EngineDoctorResult {
  ok: boolean
  root: string
  version?: string
  message: string
}

// ── 常量 ──────────────────────────────────────────────────────────────────

/** 单次引擎构建超时(毫秒):--strict 全量测量 + OOXML 写入,180s 足够 25 页 */
export const ENGINE_BUILD_TIMEOUT_MS = 180_000

/** `--check` 只做 schema 校验,给短超时 */
export const ENGINE_CHECK_TIMEOUT_MS = 30_000

/** S4 规格被引擎拒绝时,带错误重试的最大轮次(总尝试 = 1 + 该值) */
export const SPEC_MAX_REPAIRS = 3

/** 构建有 warnings 时,带 warning 反馈重写规格的最大轮次(仍超标则照常交付并记 qcWarnings) */
export const BUILD_MAX_REPAIRS = 2

/**
 * 版面稀疏(内容只占上半屏)时,追加一轮"补内容"重写的上限。
 * 这一轮要重新生成整份 spec(25 页 ≈ 60k completion tokens / +1.5~2 分钟),
 * 赶时间可以 NATIVE_DENSITY_REPAIR=0 关掉 —— 只影响版面充实度,不影响成品的合法性。
 */
export const DENSITY_MAX_REPAIRS = 1

/** 密度补写开关(默认开;NATIVE_DENSITY_REPAIR=0 关闭) */
export function isDensityRepairEnabled(): boolean {
  const raw = (process.env.NATIVE_DENSITY_REPAIR || '').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

/** 无密钥端到端自测开关:1 时 S2/S3/S4 全部返回确定性 fixture */
export const MOCK_LLM_ENV = 'NATIVE_MOCK_LLM'
