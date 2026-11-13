/**
 * pipeline/contrast.ts — 底色与文字颜色的对比度兜底
 *
 * 为什么需要它(2026-02 真机实测):
 *   模型写「深底页」时经常照抄主题里的 foreground/primary(深色)当正文色,
 *   于是浅底页的法子在深底页上变成"深绿字压深绿底"——实测 25 页里那一页的
 *   三栏标题与正文几乎不可见(对比度约 1.2:1)。引擎不会替我们翻色(它忠实写入
 *   spec),所以这道兜底必须由站点在交给引擎之前做完。
 *
 * 规则(确定性,不看模型脸色):
 *   - 逐页取底:显式 background 优先,否则主题 background;
 *   - 递归遍历 text 元素(含 container 子元素):
 *       · 没写 color 的元素,在深底页补成主题的浅色(否则引擎用主题 foreground = 深色);
 *       · 写了 color 但对比度 < 3.2 的,按角色换成可读色(强调色向白色混 45%,其余用浅色/深色);
 *   - 只动"读不清"的颜色,读得清的一律不碰 —— 不做审美改造。
 */

/** 主题里与对比度相关的颜色(与 pptx-prompts 的 ENGINE_PRESETS 同形) */
export interface ContrastColors {
  background: string
  surface: string
  foreground: string
  muted: string
  primary: string
  accent: string
  border: string
}

/** 低到"必须换"的对比度阈值(WCAG AA 大字号是 3:1,这里取 3.2 留一点余量) */
const MIN_RATIO = 3.2

/** 深/浅底的分界(相对亮度 0-1;0.18 约等于 50% 灰) */
const DARK_BG_LUMINANCE = 0.18

function normaliseHex(input: string): string | null {
  const hex = String(input || '').trim().replace(/^#/u, '')
  if (!/^[0-9a-f]{6}$/iu.test(hex)) return null
  return hex.toUpperCase()
}

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

/** sRGB → 线性光(WCAG 2.x 定义) */
function linearise(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** 相对亮度(0 = 黑,1 = 白) */
export function relativeLuminance(hex: string): number {
  const normalised = normaliseHex(hex)
  if (!normalised) return 1
  const [r, g, b] = channels(normalised)
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b)
}

/** 两色对比度(1 = 完全相同,21 = 黑白) */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** 把 a 向 b 混 t(0-1),用于"强调色在深底上太暗 → 提亮" */
function blend(a: string, b: string, t: number): string {
  const ca = channels(normaliseHex(a) || '000000')
  const cb = channels(normaliseHex(b) || 'FFFFFF')
  const mixed = ca.map((v, i) => Math.round(v + (cb[i] - v) * t))
  return mixed.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function sameColor(a: string, b: string): boolean {
  const va = normaliseHex(a)
  const vb = normaliseHex(b)
  return !!va && va === vb
}

interface TextLike {
  type?: string
  color?: unknown
  bold?: unknown
  fontSize?: unknown
  children?: unknown
}

/** 一页的底色(显式优先,否则主题背景) */
export function slideBackgroundColor(slide: { background?: unknown }, colors: ContrastColors): string {
  const bg = typeof slide.background === 'string' ? normaliseHex(slide.background) : null
  return bg || normaliseHex(colors.background) || 'FFFFFF'
}

/**
 * 在这套色板里挑一个"压在 background 上读得清"的颜色。
 *
 * 不能简单假设 foreground 一定是深色 —— 深色主题(如 ink)的 foreground 是浅色,
 * 章节页换成米色底后仍用 foreground 就会"浅字压浅底"(实测过一次)。
 * 所以按对比度实测挑最优,而不是按"深底用浅色/浅底用深色"的经验规则。
 */
function bestReadableColor(background: string, colors: ContrastColors, big: boolean): string {
  const candidates = big
    ? [colors.surface, colors.background, colors.foreground, colors.primary]
    : [colors.foreground, colors.surface, colors.background, colors.muted]
  let best = candidates[0]
  let bestRatio = contrastRatio(best, background)
  for (const candidate of candidates.slice(1)) {
    const ratio = contrastRatio(candidate, background)
    if (ratio > bestRatio) {
      best = candidate
      bestRatio = ratio
    }
  }
  return best
}

function fixElement(element: TextLike, background: string, bgIsDark: boolean, colors: ContrastColors): number {
  let changed = 0
  if (element && element.type === 'text') {
    const declared = typeof element.color === 'string' ? normaliseHex(element.color) : null
    const big = element.bold === true || Number(element.fontSize) >= 20
    if (!declared) {
      // 没写颜色时引擎会用主题 foreground:它与本页底色读不清就显式补一个
      if (contrastRatio(colors.foreground, background) < MIN_RATIO) {
        element.color = bestReadableColor(background, colors, big)
        changed += 1
      }
    } else if (contrastRatio(declared, background) < MIN_RATIO) {
      if (sameColor(declared, colors.accent)) {
        // 强调色保留色相,只提亮(深底)/压暗(浅底)
        element.color = bgIsDark ? blend(colors.accent, 'FFFFFF', 0.45) : blend(colors.accent, '000000', 0.25)
      } else {
        element.color = bestReadableColor(background, colors, big)
      }
      changed += 1
    }
  }
  const children = Array.isArray(element?.children) ? (element.children as TextLike[]) : []
  for (const child of children) {
    changed += fixElement(child, background, bgIsDark, colors)
  }
  return changed
}

/**
 * 就地修正一页里读不清的文字颜色,返回改了几处。
 * 只碰 text 元素(含 container 内嵌),表格单元格/图表配色不在本兜底范围内。
 */
export function fixSlideContrast(
  slide: { background?: unknown; elements?: unknown },
  colors: ContrastColors,
): number {
  const background = slideBackgroundColor(slide, colors)
  const bgIsDark = relativeLuminance(background) < DARK_BG_LUMINANCE
  const elements = Array.isArray(slide.elements) ? (slide.elements as TextLike[]) : []
  let changed = 0
  for (const element of elements) {
    changed += fixElement(element, background, bgIsDark, colors)
  }
  return changed
}

/** 整份 deck 逐页修正,返回总改动处数(给日志/报告用) */
export function fixSpecContrast(spec: unknown): number {
  const deck = (spec || {}) as { slides?: unknown; theme?: { colors?: ContrastColors } }
  const colors = deck.theme?.colors
  if (!colors) return 0
  const slides = Array.isArray(deck.slides) ? (deck.slides as { background?: unknown; elements?: unknown }[]) : []
  return slides.reduce((sum, slide) => sum + fixSlideContrast(slide, colors), 0)
}
