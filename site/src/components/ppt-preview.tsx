/**
 * ppt-preview.tsx — 原生 Deck Spec 预览(纸卡)
 *
 * 数据源:`GET /api/tasks/[id]/spec` → `{ spec, engineReport, pages }`
 *
 * 几何来源(优先级):
 *  1. `engineReport.layout` —— 引擎构建时算出的**最终几何**(cli `--layout-out` 的产物:
 *     container 已展开、换行已定、坐标/字号/颜色齐全)。spec 是流式布局,文本元素多数没有
 *     x/y/w/h,靠引擎 layoutSlide 堆叠才成型,所以这才是"所见即所得"的那份数据。
 *  2. 降级:`spec.slides[i].elements` —— 没有 layout(历史任务/报告解析失败)时,
 *     按元素顺序做一遍**保守的纵向堆叠**(只为了不空卡),并在要点条里标注"降级渲染"。
 *
 * 渲染:固定逻辑画布(96 px/英寸;wide → 1280×720,standard → 960×720)+ ResizeObserver
 * 量宽后等比 scale。文字/形状/线段/表格/图表/图片占位全部是 React 元素 + inline style:
 * 不拼 HTML 字符串、不注入 CSS、不引 CDN,也没有任何内嵌页面框架。
 *
 * 用法:
 *   <NativeDeckPreviewDialog open onOpenChange={...} topic="主题" taskId="任务 id" />
 */
'use client'

import * as React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronLeft,
  ChevronRight,
  Grid3x3,
  Maximize2,
  X as XIcon,
  Download,
  Loader2,
  FileText,
  Image as ImageIcon,
  BarChart3,
  Table2,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { apiPost, apiGet } from '@/lib/api-client'

// ============ 数据结构(只声明预览要读的字段,其余忽略) ============

interface SpecCredit {
  subject?: string
  author?: string
  licence?: string
}

interface SpecSeries {
  name?: string
  labels?: Array<string | number>
  values?: number[]
}

interface SpecTableCell {
  text?: string
  options?: { bold?: boolean; color?: string; fill?: string | { color?: string }; align?: string }
}

interface SpecElement {
  type?: string
  x?: number
  y?: number
  w?: number
  h?: number
  text?: string
  role?: string
  fontSize?: number
  fontFace?: string
  color?: string
  bold?: boolean
  italic?: boolean
  align?: string
  valign?: string
  fill?: string | { color?: string } | null
  lineColor?: string
  lineWidth?: number
  radius?: number
  rotate?: number
  chartType?: string
  chartColors?: string[]
  data?: SpecSeries[]
  showLegend?: boolean
  showValue?: boolean
  rows?: Array<Array<SpecTableCell | string>>
  options?: { fontSize?: number; valign?: string; colW?: number[]; chartColors?: string[] }
  credit?: SpecCredit
  altText?: string
  /** 引擎 layout 里图片只给这个标记(路径是本机绝对路径,浏览器读不到) */
  hasImage?: boolean
  path?: string
  children?: SpecElement[]
  [key: string]: unknown
}

interface SpecSlide {
  /** 原生模板名:cover/section/hero/content/editorial/kpi/comparison/process/quote/bento/table/credits */
  template?: string
  background?:
    | string
    | { color?: string; gradient?: { angle?: number; stops?: Array<{ color?: string; position?: number }> } }
  elements?: SpecElement[]
  notes?: string
}

interface DeckSpec {
  title?: string
  author?: string
  language?: string
  pageSize?: string | { width?: number; height?: number }
  theme?: {
    name?: string
    colors?: Record<string, string>
    sizes?: Record<string, number>
    spacing?: { pageX?: number; pageY?: number }
    layouts?: { pageMarginX?: number; pageMarginY?: number }
    lineSpacingMultiple?: number
  }
  slides?: SpecSlide[]
}

/** engineReport.layout:引擎写进 pptx 的最终几何 */
interface LayoutPage {
  elements?: SpecElement[]
}

interface LayoutDoc {
  pageSize?: { width?: number; height?: number }
  /** pipeline 落库时用的键 */
  layout?: LayoutPage[]
  /** 引擎 cli --layout-out 原生输出的键(两者都兼容) */
  slides?: LayoutPage[]
  objects?: Record<string, number>
  warnings?: number | unknown[]
  bytes?: number
  ok?: boolean
}

interface SpecApiResponse {
  spec: DeckSpec
  engineReport: unknown
  pages: number
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; spec: DeckSpec; engineReport: unknown; pages: number }
  | { status: 'nospec'; message: string }
  | { status: 'error'; message: string }

// ============ 基础换算 ============

/** 引擎的 PX_PER_IN(core/units.js) */
const PX_PER_IN = 96
/** 1 pt = 1/72 英寸 */
const PT_TO_PX = PX_PER_IN / 72

function pageDims(pageSize: unknown): { widthIn: number; heightIn: number } {
  if (pageSize && typeof pageSize === 'object') {
    const w = Number((pageSize as { width?: unknown }).width)
    const h = Number((pageSize as { height?: unknown }).height)
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { widthIn: w, heightIn: h }
  }
  if (pageSize === 'standard' || pageSize === '4:3') return { widthIn: 10, heightIn: 7.5 }
  return { widthIn: 13.333, heightIn: 7.5 }
}

/** 'F7F7F4' / '#F7F7F4' / 'rgba(...)' → 可用的 CSS 颜色 */
function cssColor(raw?: string | null): string | undefined {
  if (!raw) return undefined
  const v = String(raw).trim()
  if (!v) return undefined
  if (v.startsWith('#') || v.startsWith('rgb') || v.startsWith('hsl')) return v
  if (/^[0-9a-fA-F]{3,8}$/.test(v)) return `#${v}`
  return v
}

function fillColor(fill: SpecElement['fill']): string | undefined {
  if (!fill) return undefined
  if (typeof fill === 'string') return cssColor(fill)
  return cssColor(fill.color)
}

function slideBackground(slide: SpecSlide | undefined, themeColors: Record<string, string>): string {
  const bg = slide?.background
  if (typeof bg === 'string') return cssColor(bg) ?? cssColor(themeColors.background) ?? '#ffffff'
  if (bg && bg.gradient) {
    const stops = (bg.gradient.stops ?? [])
      .map((s) => `${cssColor(s.color) ?? 'transparent'} ${Number(s.position) * 100}%`)
      .join(', ')
    if (stops) return `linear-gradient(${Number(bg.gradient.angle) || 135}deg, ${stops})`
  }
  if (bg && bg.color) return cssColor(bg.color) ?? '#ffffff'
  return cssColor(themeColors.background) ?? '#ffffff'
}

function finite(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function has(v: unknown): boolean {
  return Number.isFinite(Number(v))
}

function truncate(text: string, max: number): string {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function basename(path?: string): string {
  if (!path) return ''
  const parts = String(path).split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

// ============ 降级几何:给没有坐标的元素做保守纵向堆叠 ============

/**
 * 只在 `engineReport.layout` 缺失时使用。引擎的堆叠规则复杂(实测文本宽、行距、
 * 分栏),这里不做还原,只保证"文字能按顺序看见":页边距内从上往下排,
 * 行高按字号 × 行距 × 估算行数。
 */
function withFallbackGeometry(elements: SpecElement[], spec: DeckSpec): SpecElement[] {
  const { widthIn } = pageDims(spec.pageSize)
  const marginX = finite(spec.theme?.layouts?.pageMarginX ?? spec.theme?.spacing?.pageX, 0.72)
  const marginY = finite(spec.theme?.layouts?.pageMarginY ?? spec.theme?.spacing?.pageY, 0.52)
  const contentW = Math.max(1, widthIn - marginX * 2)
  const lineSpacing = finite(spec.theme?.lineSpacingMultiple, 1.3)
  const bodySize = finite(spec.theme?.sizes?.body, 14)

  let cursor = marginY
  return elements.map((el) => {
    if (has(el.x) && has(el.y)) return el
    const type = String(el.type ?? '')
    if (type === 'container') {
      const children = Array.isArray(el.children) ? withFallbackGeometry(el.children, spec) : []
      return { ...el, children }
    }
    const fontSizePt = finite(el.fontSize, bodySize)
    const fontSizeIn = fontSizePt / 72
    const text = String(el.text ?? '')
    const charsPerLine = Math.max(6, Math.floor(contentW / Math.max(0.04, fontSizeIn * 0.72)))
    const lines = Math.max(1, Math.ceil((text.length || 1) / charsPerLine))
    const hIn = type === 'text' ? fontSizeIn * lineSpacing * lines : finite(el.h, 0.3)
    const placed: SpecElement = {
      ...el,
      x: marginX,
      y: cursor,
      w: has(el.w) ? el.w : contentW,
      h: has(el.h) ? el.h : hIn,
    }
    cursor += hIn + 0.14
    return placed
  })
}

function layoutPagesOf(report: unknown): LayoutPage[] {
  if (!report || typeof report !== 'object') return []
  const doc = report as LayoutDoc
  // pipeline 存的是 `layout`;引擎 cli --layout-out 原生写的是 `slides` —— 两个键都认
  const pages = Array.isArray(doc.layout) ? doc.layout : Array.isArray(doc.slides) ? doc.slides : null
  return pages ? pages.filter((p): p is LayoutPage => !!p && typeof p === 'object') : []
}

// ============ 单页画布 ============

interface RenderCtx {
  mode: 'full' | 'thumb'
  colors: { foreground: string; primary: string; accent: string; muted: string; border: string; surface: string }
  lineSpacing: number
  defaultFontSize: number
}

interface SlideCanvasProps {
  spec: DeckSpec
  slide?: SpecSlide
  elements: SpecElement[]
  mode?: 'full' | 'thumb'
}

function SlideCanvas({ spec, slide, elements, mode = 'full' }: SlideCanvasProps) {
  const themeColors = spec.theme?.colors ?? {}
  const { widthIn, heightIn } = pageDims(spec.pageSize)
  const canvasW = Math.round(widthIn * PX_PER_IN)
  const canvasH = Math.round(heightIn * PX_PER_IN)

  const ctx: RenderCtx = {
    mode,
    colors: {
      foreground: cssColor(themeColors.foreground) ?? '#202321',
      primary: cssColor(themeColors.primary) ?? '#1f4b45',
      accent: cssColor(themeColors.accent) ?? '#d36b45',
      muted: cssColor(themeColors.muted) ?? '#6b7470',
      border: cssColor(themeColors.border) ?? '#dce2de',
      surface: cssColor(themeColors.surface) ?? '#ffffff',
    },
    lineSpacing: finite(spec.theme?.lineSpacingMultiple, 1.3),
    defaultFontSize: finite(spec.theme?.sizes?.body, 14),
  }

  return (
    <div
      className="relative overflow-hidden"
      style={{ width: canvasW, height: canvasH, background: slideBackground(slide, themeColors) }}
    >
      {elements.map((el, i) => renderElement(el, i, ctx))}
    </div>
  )
}

/** 元素的像素矩形(英寸 → 画布 px) */
function pxBox(el: SpecElement): { left: number; top: number; width: number; height: number } {
  return {
    left: Math.round(finite(el.x) * PX_PER_IN),
    top: Math.round(finite(el.y) * PX_PER_IN),
    width: Math.max(0, Math.round(finite(el.w) * PX_PER_IN)),
    height: Math.max(0, Math.round(finite(el.h) * PX_PER_IN)),
  }
}

function box(el: SpecElement): React.CSSProperties {
  const rect = pxBox(el)
  const rotate = finite(el.rotate)
  return {
    position: 'absolute',
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    transform: rotate ? `rotate(${rotate}deg)` : undefined,
  }
}

function renderElement(el: SpecElement | null | undefined, key: number, ctx: RenderCtx): React.ReactNode {
  if (!el || typeof el !== 'object') return null
  const type = String(el.type ?? '')
  const base = box(el)
  const rect = pxBox(el)
  const isThumb = ctx.mode === 'thumb'

  switch (type) {
    case 'shape': {
      const radius = finite(el.radius) * PX_PER_IN
      const lw = finite(el.lineWidth) * PT_TO_PX
      return (
        <div
          key={key}
          style={{
            ...base,
            background: fillColor(el.fill) ?? 'transparent',
            border:
              lw > 0 && el.lineColor ? `${Math.max(1, lw)}px solid ${cssColor(el.lineColor)}` : undefined,
            borderRadius: radius > 0 ? Math.min(radius, rect.height > 0 ? rect.height / 2 : radius) : undefined,
          }}
        />
      )
    }

    case 'line': {
      const lw = Math.max(1, finite(el.lineWidth, 1) * PT_TO_PX)
      const vertical = finite(el.h) > finite(el.w)
      return (
        <div
          key={key}
          style={{
            ...base,
            width: vertical ? lw : Math.max(1, rect.width || 1),
            height: vertical ? Math.max(1, rect.height || 1) : lw,
            background: cssColor(el.lineColor) ?? ctx.colors.border,
          }}
        />
      )
    }

    case 'text': {
      const fontSize = finite(el.fontSize, ctx.defaultFontSize) * PT_TO_PX
      const color = cssColor(el.color) ?? ctx.colors.foreground
      // 引擎 layout 里最终换行文本在 text(部分版本另存 _renderText),两者都取
      const rawText = el.text ?? (el as { _renderText?: string })._renderText
      const text = String(rawText ?? '').replace(/\\n/g, '\n')
      if (isThumb) {
        // 缩略图里正文字号只剩 1-3 px:化成同色块,保留版式密度的观感
        const lines = Math.min(3, Math.max(1, Math.ceil(text.length / 40)))
        const blockH = Math.min(rect.height > 0 ? rect.height : Infinity, fontSize * 1.15 * lines)
        return (
          <div
            key={key}
            style={{
              ...base,
              height: Number.isFinite(blockH) ? blockH : rect.height,
              background: color,
              opacity: fontSize >= 20 ? 0.85 : 0.45,
              borderRadius: 1,
            }}
          />
        )
      }
      return (
        <div
          key={key}
          style={{
            ...base,
            display: 'flex',
            alignItems: alignToFlex(el.valign),
            justifyContent: justifyToFlex(el.align),
            color,
            fontSize,
            fontWeight: el.bold ? 700 : 400,
            fontStyle: el.italic ? 'italic' : undefined,
            lineHeight: ctx.lineSpacing,
            textAlign: normalizeAlign(el.align),
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflow: 'hidden',
          }}
        >
          <span style={{ width: '100%' }}>{text}</span>
        </div>
      )
    }

    case 'image': {
      if (isThumb) {
        return (
          <div
            key={key}
            style={{
              ...base,
              background: '#e8ebe9',
              border: `1px solid ${ctx.colors.border}`,
              borderRadius: 2,
            }}
          />
        )
      }
      const credit = el.credit
      const caption = credit?.subject || el.altText || basename(el.path) || '图片'
      const creditLine = [credit?.author, credit?.licence].filter(Boolean).join(' · ')
      return (
        <div
          key={key}
          style={{
            ...base,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            padding: 6,
            background: 'rgba(15,23,20,0.04)',
            border: `1px dashed ${ctx.colors.border}`,
            borderRadius: 6,
            color: ctx.colors.muted,
            fontSize: 11,
            textAlign: 'center',
          }}
        >
          <ImageIcon style={{ width: 18, height: 18, opacity: 0.7 }} />
          <div style={{ fontWeight: 600, color: ctx.colors.foreground, opacity: 0.8 }}>
            {truncate(caption, 40)}
          </div>
          <div style={{ opacity: 0.75 }}>{creditLine || '图片占位'}</div>
        </div>
      )
    }

    case 'chart': {
      if (isThumb) {
        return (
          <div
            key={key}
            style={{
              ...base,
              border: `1px solid ${ctx.colors.border}`,
              borderRadius: 2,
              background: 'rgba(15,23,20,0.03)',
            }}
          />
        )
      }
      return <ChartBlock key={key} el={el} base={base} ctx={ctx} />
    }

    case 'table': {
      if (isThumb) {
        return (
          <div
            key={key}
            style={{
              ...base,
              border: `1px solid ${ctx.colors.border}`,
              borderRadius: 2,
              background: 'rgba(15,23,20,0.05)',
            }}
          />
        )
      }
      return <TableBlock key={key} el={el} base={base} ctx={ctx} />
    }

    case 'container': {
      const children = Array.isArray(el.children) ? el.children : []
      return (
        <React.Fragment key={key}>
          {children.map((child, i) => renderElement(child, i, ctx))}
        </React.Fragment>
      )
    }

    default:
      return null
  }
}

function normalizeAlign(v?: string): React.CSSProperties['textAlign'] {
  if (v === 'center') return 'center'
  if (v === 'right') return 'right'
  return 'left'
}

function alignToFlex(v?: string): React.CSSProperties['alignItems'] {
  if (v === 'middle' || v === 'center') return 'center'
  if (v === 'bottom') return 'flex-end'
  return 'flex-start'
}

function justifyToFlex(v?: string): React.CSSProperties['justifyContent'] {
  if (v === 'center') return 'center'
  if (v === 'right') return 'flex-end'
  return 'flex-start'
}

function ChartBlock({ el, base, ctx }: { el: SpecElement; base: React.CSSProperties; ctx: RenderCtx }) {
  const series = Array.isArray(el.data) ? el.data : []
  const rawColors = el.chartColors ?? el.options?.chartColors ?? []
  const chartColors = rawColors.map((c) => cssColor(c) ?? ctx.colors.primary)
  const palette = [ctx.colors.primary, ctx.colors.accent, ctx.colors.muted, ctx.colors.foreground]
  const values = series
    .flatMap((s) => (Array.isArray(s.values) ? s.values : []))
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
  const max = values.length ? Math.max(...values) : 0
  // 引擎 layout 的 labels 可能多套一层([["A","B"]]),展平一级再用
  const rawLabels = Array.isArray(series[0]?.labels) ? series[0]!.labels! : []
  const labels: Array<string | number> = (rawLabels as unknown[]).flatMap((l) =>
    Array.isArray(l) ? (l as Array<string | number>) : [l as string | number],
  )
  const height = finite(el.h) * PX_PER_IN
  const plotH = Math.max(40, height - 46)

  return (
    <div
      style={{
        ...base,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        padding: '8px 10px',
        border: `1px solid ${ctx.colors.border}`,
        borderRadius: 6,
        background: ctx.colors.surface,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: plotH }}>
        {labels.slice(0, 10).map((label, li) => (
          <div
            key={li}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', gap: 2 }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: '100%' }}>
              {series.slice(0, 4).map((s, si) => {
                const value = Number(s.values?.[li] ?? 0)
                const ratio = max > 0 ? Math.max(0.02, value / max) : 0
                return (
                  <div
                    key={si}
                    style={{
                      flex: 1,
                      height: `${ratio * 100}%`,
                      background: chartColors[si] ?? palette[si % palette.length],
                      borderRadius: '2px 2px 0 0',
                      position: 'relative',
                    }}
                    title={`${s.name ?? ''} ${label}: ${value}`}
                  >
                    {el.showValue && (
                      <span
                        style={{
                          position: 'absolute',
                          top: -13,
                          left: 0,
                          right: 0,
                          textAlign: 'center',
                          fontSize: 9,
                          color: ctx.colors.muted,
                        }}
                      >
                        {formatNumber(value)}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            <div
              style={{
                fontSize: 9.5,
                color: ctx.colors.muted,
                textAlign: 'center',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {String(label)}
            </div>
          </div>
        ))}
      </div>
      {el.showLegend && series.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
          {series.slice(0, 4).map((s, si) => (
            <span key={si} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9.5, color: ctx.colors.muted }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: chartColors[si] ?? palette[si % palette.length],
                }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return ''
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  return String(Math.round(v * 100) / 100)
}

function TableBlock({ el, base, ctx }: { el: SpecElement; base: React.CSSProperties; ctx: RenderCtx }) {
  const rows = Array.isArray(el.rows) ? el.rows : []
  const fontSize = Math.max(7, finite(el.options?.fontSize, 11) * PT_TO_PX * 0.78)
  const colW = el.options?.colW
  const colWSum = Array.isArray(colW) ? colW.reduce((a, b) => a + finite(b), 0) : 0

  return (
    <div style={{ ...base, overflow: 'hidden' }}>
      <table
        style={{
          width: '100%',
          height: '100%',
          borderCollapse: 'collapse',
          tableLayout: 'fixed',
          fontSize,
          color: ctx.colors.foreground,
        }}
      >
        {Array.isArray(colW) && colW.length > 0 && colWSum > 0 && (
          <colgroup>
            {colW.map((w, i) => (
              <col key={i} style={{ width: `${(finite(w) / colWSum) * 100}%` }} />
            ))}
          </colgroup>
        )}
        <tbody>
          {rows.slice(0, 20).map((row, ri) => (
            <tr key={ri}>
              {(Array.isArray(row) ? row : []).slice(0, 12).map((cell, ci) => {
                const c: SpecTableCell = typeof cell === 'string' ? { text: cell } : cell ?? {}
                const opts = c.options ?? {}
                return (
                  <td
                    key={ci}
                    style={{
                      border: `1px solid ${ctx.colors.border}`,
                      padding: '3px 5px',
                      verticalAlign: 'middle',
                      fontWeight: opts.bold || ri === 0 ? 700 : 400,
                      color: cssColor(opts.color) ?? ctx.colors.foreground,
                      background:
                        (typeof opts.fill === 'string' ? cssColor(opts.fill) : cssColor(opts.fill?.color)) ?? undefined,
                      textAlign: opts.align === 'center' ? 'center' : opts.align === 'right' ? 'right' : 'left',
                      overflow: 'hidden',
                    }}
                  >
                    {String(c.text ?? '')}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ============ 单页要点(模板名 / 标题 / 要点 / KPI / 图片 credit) ============

interface SlideOverview {
  templateLabel: string
  templateGuessed: boolean
  title: string
  bullets: string[]
  kpis: string[]
  images: Array<{ caption: string; credit: string }>
}

const NUMERIC_RE = /^[\s\-–—~〜+]?[0-9][0-9.,%\u00d7xX/\s\-–—~〜+]*$/

function inferLayoutLabel(elements: SpecElement[]): string {
  const types = elements.map((el) => String(el?.type ?? ''))
  if (types.includes('table')) return '表格版式'
  if (types.includes('chart')) return '图表版式'
  if (types.includes('image')) return '图文版式'
  const shapes = types.filter((t) => t === 'shape').length
  if (shapes >= 6) return '多卡片版式'
  if (shapes >= 2) return '双栏版式'
  const texts = elements.filter((el) => el.type === 'text' && String(el.text ?? '').trim())
  if (texts.length <= 3) return '标题版式'
  return '正文版式'
}

function overviewOf(slide: SpecSlide | undefined, elements: SpecElement[]): SlideOverview {
  const template = typeof slide?.template === 'string' ? slide.template.trim() : ''
  const texts = elements.filter((el) => el.type === 'text' && String(el.text ?? '').trim())
  const titleEl =
    texts.find((el) => String(el.role ?? '') === 'title') ??
    [...texts].sort((a, b) => finite(b.fontSize) - finite(a.fontSize))[0]

  const title = titleEl ? truncate(String(titleEl.text), 90) : ''
  const kpis: string[] = []
  const bullets: string[] = []

  for (const el of texts) {
    if (el === titleEl) continue
    const t = String(el.text ?? '').trim()
    if (!t) continue
    if (NUMERIC_RE.test(t) && t.length <= 18) {
      if (!kpis.includes(t) && kpis.length < 5) kpis.push(t)
      continue
    }
    if (!bullets.includes(t) && bullets.length < 5) bullets.push(t)
  }

  const images = elements
    .filter((el) => el.type === 'image')
    .slice(0, 4)
    .map((el) => ({
      caption: truncate(el.credit?.subject || el.altText || basename(el.path) || '图片', 36),
      credit: [el.credit?.author, el.credit?.licence].filter(Boolean).join(' · '),
    }))

  return { templateLabel: template || inferLayoutLabel(elements), templateGuessed: !template, title, bullets, kpis, images }
}

// ============ 引擎报告摘要 ============

interface ReportSummary {
  warnings: number | null
  objects: number | null
  bytes: number | null
  details: Array<{ slide?: number; code?: string; message?: string }>
}

function reportSummary(report: unknown): ReportSummary {
  if (!report || typeof report !== 'object') return { warnings: null, objects: null, bytes: null, details: [] }
  const o = report as Record<string, unknown>

  const rawWarn = o.warnings
  const warnings =
    typeof rawWarn === 'number'
      ? rawWarn
      : Array.isArray(rawWarn)
        ? rawWarn.length
        : typeof o.warningCount === 'number'
          ? (o.warningCount as number)
          : null

  let objects: number | null = null
  if (o.objects && typeof o.objects === 'object' && !Array.isArray(o.objects)) {
    objects = Object.values(o.objects as Record<string, unknown>).reduce<number>(
      (sum, v) => sum + (Number.isFinite(Number(v)) ? Number(v) : 0),
      0,
    )
  } else if (typeof o.objects === 'number') {
    objects = o.objects
  }

  const bytes = typeof o.bytes === 'number' ? o.bytes : typeof o.sizeBytes === 'number' ? (o.sizeBytes as number) : null

  const rawDetails = o.warningDetails
  const details = Array.isArray(rawDetails)
    ? (rawDetails as Array<Record<string, unknown>>)
        .slice(0, 3)
        .map((d) => ({
          slide: Number.isFinite(Number(d.slide)) ? Number(d.slide) : undefined,
          code: typeof d.code === 'string' ? d.code : undefined,
          message: typeof d.message === 'string' ? d.message : undefined,
        }))
    : []

  return { warnings, objects, bytes, details }
}

function formatBytes(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ============ 容器尺寸测量 ============

function useMeasuredBox<T extends HTMLElement>() {
  const [node, setNode] = React.useState<T | null>(null)
  const [size, setSize] = React.useState({ width: 0, height: 0 })

  React.useLayoutEffect(() => {
    if (!node) return
    // ResizeObserver 挂上时会立刻推一次初始尺寸,所以不必在 effect 体内同步 setState。
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) setSize({ width: rect.width, height: rect.height })
    })
    ro.observe(node)
    return () => ro.disconnect()
  }, [node])

  return [setNode, size] as const
}

function useMeasuredWidth<T extends HTMLElement>() {
  // 用「回调 ref + state」而不是 useRef:被测量的卡片只在 spec 取回后才挂载,
  // 用 useRef 时挂载期 effect 里 ref.current 还是 null,ResizeObserver 从未挂上,
  // 宽度恒为 0 → scale=0 → 画布渲染成空白(实测现象:预览只剩要点条,没有内容)。
  const [node, setNode] = React.useState<T | null>(null)
  const [width, setWidth] = React.useState(0)

  React.useLayoutEffect(() => {
    if (!node) return
    // 同上:依赖 ResizeObserver 的初始通知,不在 effect 体内同步 setState。
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0))
    ro.observe(node)
    return () => ro.disconnect()
  }, [node])

  return [setNode, width] as const
}

// ============ 弹窗 ============

interface NativeDeckPreviewDialogProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  topic: string
  taskId?: string
  downloadFilename?: string
}

export function NativeDeckPreviewDialog({
  open,
  onOpenChange,
  topic,
  taskId,
  downloadFilename,
}: NativeDeckPreviewDialogProps) {
  const [state, setState] = React.useState<LoadState>({ status: 'idle' })
  const [current, setCurrent] = React.useState(0)
  const [showThumbnails, setShowThumbnails] = React.useState(false)
  const [downloading, setDownloading] = React.useState(false)
  const [cardRef, cardWidth] = useMeasuredWidth<HTMLDivElement>()
  const [stageRef, stageSize] = useMeasuredBox<HTMLDivElement>()
  const [outlineRef, outlineSize] = useMeasuredBox<HTMLDivElement>()

  React.useEffect(() => {
    if (!open || !taskId) return
    let alive = true

    // 取数放进异步函数:进入 loading 与落地都发生在微任务里,
    // 避免在 effect 体内同步 setState(react-hooks/set-state-in-effect)。
    const load = async () => {
      setState({ status: 'loading' })
      try {
        const data = await apiGet<SpecApiResponse>(`/api/tasks/${taskId}/spec`)
        if (!alive) return
        setCurrent(0)
        setState({
          status: 'ready',
          spec: data.spec ?? {},
          engineReport: data.engineReport ?? null,
          pages: Number(data.pages) || (Array.isArray(data.spec?.slides) ? data.spec.slides.length : 0),
        })
      } catch (e) {
        if (!alive) return
        const err = e as Error & { status?: number }
        if (err.status === 404) setState({ status: 'nospec', message: err.message || '该任务无预览数据' })
        else setState({ status: 'error', message: err.message || '加载失败' })
      }
    }

    void load()
    return () => {
      alive = false
    }
  }, [open, taskId])

  const spec = state.status === 'ready' ? state.spec : undefined
  const layoutPages = React.useMemo(
    () => (state.status === 'ready' ? layoutPagesOf(state.engineReport) : []),
    [state],
  )
  const slides = React.useMemo<SpecSlide[]>(() => (Array.isArray(spec?.slides) ? spec!.slides! : []), [spec])
  const total = slides.length
  const safeCurrent = total > 0 ? Math.min(current, total - 1) : 0

  /** 单页元素:engineReport.layout 优先(引擎最终几何),否则降级堆叠 */
  const elementsFor = React.useCallback(
    (index: number): SpecElement[] => {
      const fromLayout = layoutPages[index]?.elements
      if (Array.isArray(fromLayout) && fromLayout.length > 0) return fromLayout
      const slideElements = slides[index]?.elements
      if (!Array.isArray(slideElements)) return []
      return withFallbackGeometry(slideElements, spec ?? {})
    },
    [layoutPages, slides, spec],
  )

  const pageElements = React.useMemo(() => elementsFor(safeCurrent), [elementsFor, safeCurrent])
  const slide = slides[safeCurrent]
  const overview = React.useMemo(
    () => (slide ? overviewOf(slide, pageElements) : null),
    [slide, pageElements],
  )

  const usingLayout = Array.isArray(layoutPages[safeCurrent]?.elements) && (layoutPages[safeCurrent]?.elements?.length ?? 0) > 0
  const report = state.status === 'ready' ? reportSummary(state.engineReport) : reportSummary(null)

  const { widthIn, heightIn } = pageDims((state.status === 'ready' && (state.engineReport as LayoutDoc)?.pageSize) || spec?.pageSize)
  const canvasW = Math.round(widthIn * PX_PER_IN)
  const canvasH = Math.round(heightIn * PX_PER_IN)
  // 同时受宽和高约束:只看宽度会让 16:9 的画布在窄高窗口里把要点条挤出弹窗(实测被裁掉)。
  const widthScale = cardWidth > 0 ? cardWidth / canvasW : 0
  const heightBudget = stageSize.height > 0 ? stageSize.height - outlineSize.height - 12 : 0
  const heightScale = heightBudget > 0 ? heightBudget / canvasH : 0
  const scale =
    widthScale > 0 && heightScale > 0 ? Math.min(widthScale, heightScale) : widthScale || heightScale

  // 画布尺寸以"解析后的英寸"为准,回灌进 spec 再往下传:
  // 保证主卡、缩略图、要点条三者用的是同一个画布,不会因 pageSize 写法不同而错位。
  const canvasSpec = React.useMemo<DeckSpec>(
    () => ({ ...(spec ?? {}), pageSize: { width: widthIn, height: heightIn } }),
    [spec, widthIn, heightIn],
  )

  const canPrev = safeCurrent > 0
  const canNext = safeCurrent < total - 1
  const goPrev = React.useCallback(() => setCurrent((c) => Math.max(0, c - 1)), [])
  const goNext = React.useCallback(() => setCurrent((c) => Math.min(total - 1, c + 1)), [total])

  React.useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === 'ArrowRight') goNext()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, goPrev, goNext])

  const handleDownload = async () => {
    if (!taskId) return
    setDownloading(true)
    try {
      const data = await apiPost<{ downloadUrl: string }>(`/api/tasks/${taskId}/create-download-token`, {})
      const a = document.createElement('a')
      a.href = data.downloadUrl
      a.download = downloadFilename || `${topic.slice(0, 40) || 'chatppt'}.pptx`
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (e) {
      toast.error((e as Error).message || '下载失败,请稍后重试')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid min-w-0 max-h-[95vh] max-w-[95vw] gap-0 overflow-hidden p-0 [grid-template-columns:minmax(0,1fr)] sm:max-w-[min(1280px,95vw)]"
        showCloseButton={false}
      >
        {/* 顶部工具栏 */}
        <div className="flex min-w-0 items-center justify-between gap-2 overflow-hidden border-b bg-card px-3 py-2 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="min-w-0 truncate text-sm font-medium sm:text-base">
              在线预览 · {topic}
            </DialogTitle>
            {total > 0 && (
              <Badge variant="secondary" className="shrink-0 tabular-nums">
                {safeCurrent + 1} / {total}
              </Badge>
            )}
            {overview && (
              <Badge
                variant="outline"
                className="hidden shrink-0 gap-1 sm:inline-flex"
                title={overview.templateGuessed ? 'Spec 未标注模板名,按元素构成推测' : '原生模板名'}
              >
                {overview.templateGuessed ? '版式 · ' : '模板 · '}
                {overview.templateLabel}
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowThumbnails((v) => !v)}
              aria-label="切换缩略图"
              title="缩略图(桌面端;移动端用下方页条)"
              className="hidden sm:inline-flex"
            >
              <Grid3x3 className="size-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} aria-label="关闭" className="gap-1">
              <XIcon className="size-4" />
              <span className="hidden sm:inline">关闭</span>
            </Button>
          </div>
        </div>

        <div className="flex h-[80vh] min-h-0 flex-col overflow-y-auto sm:h-[85vh]">
          <div className="flex min-h-0 flex-1">
            {/* 移动端页条(<640px):侧栏在 sm 以下隐藏,这是移动端唯一的跳页入口 */}
            <div className="flex w-full shrink-0 gap-2 overflow-x-auto border-b bg-muted/20 px-2 py-2 sm:hidden">
              {slides.map((s, i) => {
                const thumbW = 64
                const thumbScale = thumbW / canvasW
                return (
                  <button
                    key={i}
                    onClick={() => setCurrent(i)}
                    className={cn(
                      'shrink-0 overflow-hidden rounded-md border',
                      safeCurrent === i ? 'border-primary ring-1 ring-primary' : 'border-transparent hover:border-border',
                    )}
                    aria-label={`跳到第 ${i + 1} 页`}
                  >
                    <ThumbCard
                      spec={canvasSpec}
                      slide={s}
                      elements={elementsFor(i)}
                      scale={thumbScale}
                      width={thumbW}
                      height={Math.round(canvasH * thumbScale)}
                    />
                  </button>
                )
              })}
            </div>

            {/* 缩略图侧栏 */}
            {showThumbnails && (
              <aside className="hidden w-[180px] shrink-0 border-r bg-muted/30 sm:block">
                <ScrollArea className="h-full">
                  <div className="space-y-2 p-2">
                    {slides.map((s, i) => {
                      const thumbW = 152
                      const thumbScale = thumbW / canvasW
                      return (
                        <button
                          key={i}
                          onClick={() => setCurrent(i)}
                          className={cn(
                            'w-full overflow-hidden rounded-md border transition',
                            safeCurrent === i ? 'border-primary ring-1 ring-primary' : 'border-transparent hover:border-border',
                          )}
                        >
                          <ThumbCard
                            spec={canvasSpec}
                            slide={s}
                            elements={elementsFor(i)}
                            scale={thumbScale}
                            width={thumbW}
                            height={Math.round(canvasH * thumbScale)}
                          />
                          <div
                            className={cn(
                              'px-1 py-0.5 text-center text-[10px] tabular-nums',
                              safeCurrent === i ? 'font-medium text-foreground' : 'text-muted-foreground',
                            )}
                          >
                            {i + 1}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </ScrollArea>
              </aside>
            )}

            {/* 主预览区 */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden bg-muted/40 p-4 sm:p-6">
                {state.status === 'loading' && (
                  <div className="flex flex-col items-center gap-3 text-muted-foreground">
                    <Loader2 className="size-6 animate-spin" />
                    <p className="text-sm">加载 Deck Spec…</p>
                  </div>
                )}

                {state.status === 'nospec' && (
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <FileText className="size-12" />
                    <p className="text-sm">该任务无预览数据</p>
                    <p className="max-w-sm text-center text-xs opacity-80">{state.message}</p>
                  </div>
                )}

                {state.status === 'error' && (
                  <div className="flex flex-col items-center gap-2 text-destructive">
                    <FileText className="size-12" />
                    <p className="text-sm">预览加载失败:{state.message}</p>
                  </div>
                )}

                {state.status === 'ready' && total === 0 && (
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <FileText className="size-12" />
                    <p className="text-sm">该任务无预览数据</p>
                  </div>
                )}

                {state.status === 'ready' && total > 0 && overview && (
                  <div ref={stageRef} className="flex w-full min-h-0 flex-1 flex-col items-center justify-center gap-3">
                    <div ref={cardRef} className="w-full max-w-[1120px]">
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={safeCurrent}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="mx-auto overflow-hidden rounded-lg bg-white shadow-2xl"
                          style={
                            scale > 0
                              ? { width: canvasW * scale, height: canvasH * scale }
                              : undefined
                          }
                        >
                          {scale > 0 && (
                            <div
                              style={{
                                width: canvasW,
                                height: canvasH,
                                transform: `scale(${scale})`,
                                transformOrigin: '0 0',
                              }}
                            >
                              <SlideCanvas spec={canvasSpec} slide={slide} elements={pageElements} />
                            </div>
                          )}
                        </motion.div>
                      </AnimatePresence>
                    </div>

                    <div ref={outlineRef} className="w-full max-w-[1120px]">
                      <SlideOutline
                        overview={overview}
                        elements={pageElements}
                        report={report}
                        usingLayout={usingLayout}
                      />
                    </div>
                  </div>
                )}

                {state.status === 'ready' && total > 0 && (
                  <>
                    <Button
                      variant="secondary"
                      size="icon"
                      disabled={!canPrev}
                      onClick={goPrev}
                      className="absolute left-2 top-1/2 size-9 -translate-y-1/2 rounded-full shadow-md sm:left-3"
                      aria-label="上一张"
                    >
                      <ChevronLeft className="size-5" />
                    </Button>
                    <Button
                      variant="secondary"
                      size="icon"
                      disabled={!canNext}
                      onClick={goNext}
                      className="absolute right-2 top-1/2 size-9 -translate-y-1/2 rounded-full shadow-md sm:right-3"
                      aria-label="下一张"
                    >
                      <ChevronRight className="size-5" />
                    </Button>
                  </>
                )}
              </div>

              {/* 底部工具栏 */}
              <div className="flex items-center justify-between gap-2 border-t bg-card px-3 py-2 sm:px-4">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canPrev || state.status !== 'ready'}
                    onClick={goPrev}
                    className="gap-1 px-2 sm:px-3"
                    aria-label="上一张"
                  >
                    <ChevronLeft className="size-4" />
                    <span className="hidden sm:inline">上一张</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canNext || state.status !== 'ready'}
                    onClick={goNext}
                    className="gap-1 px-2 sm:px-3"
                    aria-label="下一张"
                  >
                    <span className="hidden sm:inline">下一张</span>
                    <ChevronRight className="size-4" />
                  </Button>
                  {total > 0 && (
                    <span className="ml-1 hidden text-xs tabular-nums text-muted-foreground sm:inline">
                      {safeCurrent + 1} / {total}
                    </span>
                  )}
                </div>
                <div className="flex min-w-0 items-center gap-1.5">
                  {taskId && (
                    <Button size="sm" onClick={handleDownload} disabled={downloading} className="gap-1 px-2 sm:px-3">
                      {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                      <span className="hidden sm:inline">下载 PPT</span>
                      <span className="sm:hidden">下载</span>
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="gap-1 px-2 sm:px-3">
                    <Maximize2 className="size-4" />
                    <span className="hidden sm:inline">完成</span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ============ 缩略图 ============

function ThumbCard({
  spec,
  slide,
  elements,
  scale,
  width,
  height,
}: {
  spec: DeckSpec
  slide: SpecSlide
  elements: SpecElement[]
  scale: number
  width: number
  height: number
}) {
  const { widthIn, heightIn } = pageDims(spec.pageSize)
  const canvasW = Math.round(widthIn * PX_PER_IN)
  const canvasH = Math.round(heightIn * PX_PER_IN)
  return (
    <div className="relative overflow-hidden bg-white" style={{ width, height }}>
      <div style={{ width: canvasW, height: canvasH, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
        <SlideCanvas spec={spec} slide={slide} elements={elements} mode="thumb" />
      </div>
    </div>
  )
}

// ============ 本页要点条 ============

function SlideOutline({
  overview,
  elements,
  report,
  usingLayout,
}: {
  overview: SlideOverview
  elements: SpecElement[]
  report: ReportSummary
  usingLayout: boolean
}) {
  const hasChart = elements.some((el) => el?.type === 'chart')
  const hasTable = elements.some((el) => el?.type === 'table')
  const size = formatBytes(report.bytes)

  return (
    <div className="w-full max-w-[1120px] rounded-lg border bg-card/80 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">
          {overview.templateGuessed ? '推测版式' : '模板'}:{overview.templateLabel}
        </span>
        {hasChart && (
          <span className="flex items-center gap-1">
            <BarChart3 className="size-3" />
            图表
          </span>
        )}
        {hasTable && (
          <span className="flex items-center gap-1">
            <Table2 className="size-3" />
            表格
          </span>
        )}
        {report.warnings != null && (
          <span className={cn('flex items-center gap-1', report.warnings > 0 && 'text-amber-600')}>
            <AlertTriangle className="size-3" />
            引擎警告 {report.warnings}
          </span>
        )}
        {report.objects != null && <span>原生对象 {report.objects}</span>}
        {size && <span>{size}</span>}
        {!usingLayout && <span className="text-amber-600">降级渲染(无引擎几何,按元素顺序堆叠)</span>}
      </div>

      {overview.title && (
        <div className="mt-1 truncate text-[13px] font-medium text-foreground">{overview.title}</div>
      )}

      {(overview.kpis.length > 0 || overview.bullets.length > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {overview.kpis.map((k) => (
            <Badge key={k} variant="secondary" className="tabular-nums">
              {k}
            </Badge>
          ))}
          {overview.bullets.slice(0, 3).map((b) => (
            <span key={b} className="max-w-[320px] truncate rounded bg-muted px-1.5 py-0.5">
              {b}
            </span>
          ))}
        </div>
      )}

      {overview.images.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {overview.images.map((img, i) => (
            <span key={i} className="flex items-center gap-1">
              <ImageIcon className="size-3" />
              {img.caption}
              {img.credit ? ` · ${img.credit}` : ' · 未标注来源'}
            </span>
          ))}
        </div>
      )}

      {report.details.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-amber-600">
          {report.details.map((d, i) => (
            <span key={i} className="truncate">
              第 {d.slide ?? '?'} 页 {d.code ? `[${d.code}] ` : ''}
              {d.message ?? ''}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
