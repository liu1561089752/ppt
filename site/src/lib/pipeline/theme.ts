/**
 * pipeline/theme.ts — 主题预设(站点侧取色唯一入口)
 *
 * 配色不再由 LLM 写 CSS,而是从引擎自带的四套预设里选一套(ink / sand / sage / clay,
 * 见 pptx/native/themes/presets.js)。这四套不只是好看:引擎测试断言过每套都满足
 * surface≠background、文字在两种底色上都可读 —— 让 LLM 自己发明十六进制值,
 * 只会把这两条保证丢掉。
 *
 * 色值真源在 @/lib/pptx-prompts 的 ENGINE_PRESETS(与引擎逐字一致),本文件只做
 * "预设名 → 可直接写进 Deck Spec 的 theme 对象"的适配,外加间距/圆角/效果的默认值。
 * 这里刻意不再抄一份色表:两份色表必然漂移。
 */
import { normalizePresetName, resolvePresetTheme } from '@/lib/pptx-prompts'
import type { DeckTheme } from './types'

/** 站点 preset / 引擎 preset / 脏值 → 合法引擎预设名(默认 sage) */
export function normalizePreset(candidate?: string | null): string {
  return normalizePresetName(candidate)
}

/** 取一份可直接写进 Deck Spec 的主题(深拷贝,调用方随便改不影响预设表) */
export function themeFor(preset: string | null | undefined, language: string): DeckTheme {
  const resolved = resolvePresetTheme(preset, language)
  return {
    name: resolved.name,
    colors: { ...resolved.colors },
    fonts: { ...resolved.fonts },
    sizes: { ...resolved.sizes },
    // 引擎 layout 读的间距/圆角/效果默认值(与 themes/design_system.js 的默认一致)
    spacing: { xs: 0.08, sm: 0.16, md: 0.24, lg: 0.36, xl: 0.56, pageX: 0.78, pageY: 0.52 },
    radii: { small: 0.06, medium: 0.12, large: 0.2 },
    lineSpacingMultiple: resolved.lineSpacingMultiple,
    typography: {
      titleWeight: 'bold',
      headingWeight: 'bold',
      bodyWeight: 'normal',
      lineSpacingMultiple: resolved.lineSpacingMultiple,
      titleTracking: 0,
      bodyTracking: 0,
    },
    effects: { cardBorder: true, softShadow: false, accentRule: true },
  }
}
