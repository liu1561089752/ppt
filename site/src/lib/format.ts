/**
 * 日期/时长格式化 —— 全站唯一定义(原先 6 处重复实现,文案各异)。
 */
import { format } from 'date-fns'

type DateLike = string | Date | null | undefined

export function formatDate(input: DateLike, pattern = 'yyyy-MM-dd HH:mm'): string {
  if (input == null) return '-'
  try {
    const d = input instanceof Date ? input : new Date(input)
    if (isNaN(d.getTime())) return '-'
    return format(d, pattern)
  } catch {
    return '-'
  }
}

/** 时长:毫秒 → "x 秒"/"x 分 y 秒" */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms} 毫秒`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} 秒`
  const m = Math.floor(s / 60)
  const rest = Math.round(s - m * 60)
  return `${m} 分 ${rest} 秒`
}

/** 相对时间:刚刚 / n 分钟前 / n 小时前 / n 天前,更久回退到绝对日期 */
export function formatRelative(input: DateLike): string {
  if (input == null) return '-'
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d.getTime())) return '-'
  const diff = Date.now() - d.getTime()
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / (24 * 60 * 60 * 1000))} 天前`
  return formatDate(d, 'yyyy-MM-dd')
}
