/**
 * pptx-prompts.ts — 原生 Deck Spec 的提示词模块(阶段 3 大纲 / 阶段 4 规格 / 阶段 4 修复)
 *
 * 设计原则:
 * - 两段式:阶段 3 只决定"讲什么"(标题 + 页面原型 + 要点),阶段 4 才展开成元素。
 * - 提示词即引擎契约。真源是引擎 checkout(只读参考):
 *     ../../pptx/native/templates/index.js      页面原型的字段面
 *     ../../pptx/native/engine/layout.js        流式排布与"文字高度实测"
 *     ../../pptx/examples/native_deck_spec.js   完整 deck 的样子
 *     ../../pptx/SKILL.md                       元素字段表与三条硬规则
 *   引擎改了契约,这里必须跟着改,否则模型产出会被 `cli.js --check` 打回。
 * - 元素是"流"不是"坐标":元素不写 x/y/w,宽度随栏宽;文字不写 h,高度由布局实测。
 *   模型越少碰几何,越不容易越界与文字重叠。
 *
 * 三条硬规则(引擎侧是结构性的,不是风格建议):
 * 1. 盒高由布局实测:文字元素不写 h,不写 x/y;容器高度由子元素撑开。
 * 2. 一页一个量级:同一张图表里的数值必须同量级,跨度大就拆成数字块。
 * 3. 图片必须带 credit:没有 subject/author/licence 的图片进不了 deck(引擎 schema 直接拒)。
 */

// ---------- 页面原型 ----------

/**
 * 引擎 templates/ 的 12 个页面模板(与 templates/index.js 的导出一一对应)。
 * `credits` 只是对齐引擎目录:本站的署名写在 image 元素的 credit 上,不单独占一页。
 */
export const PAGE_TEMPLATES = [
  'cover',
  'section',
  'hero',
  'content',
  'editorial',
  'kpi',
  'comparison',
  'process',
  'quote',
  'bento',
  'table',
  'credits',
] as const

export type PageTemplate = (typeof PAGE_TEMPLATES)[number]

/**
 * 大纲可选的页面原型 = 管线认可的白名单(pipeline/plan.ts 直接拿它收敛 LLM 输出)。
 * 与引擎模板的差别只有两处:去掉 credits(署名并入图片元素),
 * 加上 chart / image 两个组合原型(标题 + 图表或配图 + 注解,引擎侧由元素直接拼)。
 */
export const PAGE_ARCHETYPES = [
  'cover',
  'section',
  'hero',
  'content',
  'editorial',
  'kpi',
  'comparison',
  'process',
  'quote',
  'bento',
  'table',
  'chart',
  'image',
] as const

export type PageArchetype = (typeof PAGE_ARCHETYPES)[number]

/** 引擎能写成的原生元素类型(container 由布局引擎展开成逐个盒子) */
export const ELEMENT_TYPES = ['text', 'shape', 'line', 'image', 'chart', 'table', 'container'] as const

export type SpecElementType = (typeof ELEMENT_TYPES)[number]

// ---------- 主题预设 ----------

export interface EngineColors {
  background: string
  surface: string
  foreground: string
  primary: string
  accent: string
  muted: string
  border: string
}

export type ColorKey = keyof EngineColors

export const COLOR_KEYS: ColorKey[] = [
  'background',
  'surface',
  'foreground',
  'primary',
  'accent',
  'muted',
  'border',
]

export interface EngineThemeSpec {
  name: string
  colors: EngineColors
  fonts: { heading: string; body: string; numeric: string }
  sizes: { display: number; title: number; heading: number; body: number; caption: number; micro: number }
  lineSpacingMultiple: number
}

/**
 * 引擎 themes/presets.js 的四套预设,色值逐字照抄。
 * 引擎测试断言过每套都满足:surface 与 background 肉眼可分、文字在两种底上都可读。
 * 阶段 4 由 pipeline/theme.ts 注入主题并把它交给本模块(见 buildSpecPrompt 的 theme/themeHint),
 * 这里的两份表只是"调用方没给主题"时的兜底,值必须与引擎一致。
 */
export const ENGINE_PRESETS: Record<'ink' | 'sand' | 'sage' | 'clay', EngineThemeSpec> = {
  ink: {
    name: 'ink',
    colors: {
      background: '12202B',
      surface: '1A2C39',
      foreground: 'EEF3F6',
      primary: 'F0D9A8',
      accent: 'E4785C',
      muted: 'A9BAC6',
      border: '2C4150',
    },
    fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei', numeric: 'Microsoft YaHei' },
    sizes: { display: 44, title: 34, heading: 20, body: 14, caption: 10, micro: 9 },
    lineSpacingMultiple: 1.3,
  },
  sand: {
    name: 'sand',
    colors: {
      background: 'F2E8D9',
      surface: 'FFFCF6',
      foreground: '2B2118',
      primary: '4E3A26',
      accent: 'B4552B',
      muted: '75634E',
      border: 'E1D2BC',
    },
    fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei', numeric: 'Microsoft YaHei' },
    sizes: { display: 44, title: 34, heading: 20, body: 14, caption: 10, micro: 9 },
    lineSpacingMultiple: 1.32,
  },
  sage: {
    name: 'sage',
    colors: {
      background: 'E6EFE8',
      surface: 'FBFDFB',
      foreground: '1E2B24',
      primary: '1F4438',
      accent: 'C0653A',
      muted: '4F6659',
      border: 'CFDED4',
    },
    fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei', numeric: 'Microsoft YaHei' },
    sizes: { display: 44, title: 34, heading: 20, body: 14, caption: 10, micro: 9 },
    lineSpacingMultiple: 1.32,
  },
  clay: {
    name: 'clay',
    colors: {
      background: 'F8E7DF',
      surface: 'FFFBF8',
      foreground: '2C1D17',
      primary: '6B2D1F',
      accent: '985C17',
      muted: '7A5F52',
      border: 'EBD5C9',
    },
    fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei', numeric: 'Microsoft YaHei' },
    sizes: { display: 44, title: 34, heading: 20, body: 14, caption: 10, micro: 9 },
    lineSpacingMultiple: 1.32,
  },
}

/** 站点表单的 7 个风格预设,各自落到一套引擎预设(引擎只有四套,允许映射到同一套) */
export const SITE_PRESETS: Record<string, { engine: keyof typeof ENGINE_PRESETS; hint: string }> = {
  business: { engine: 'sage', hint: '商务专业:雾绿冷调 + 砖红点缀,克制、数据优先' },
  tech: { engine: 'ink', hint: '技术科技:深底亮字,暖金标题 + 珊瑚高光,结构感强' },
  education: { engine: 'sand', hint: '教育亲和:暖沙纸感底 + 墨棕标题,印刷味、易读' },
  marketing: { engine: 'clay', hint: '营销活力:陶土暖底 + 砖红标题,视觉冲击' },
  minimal: { engine: 'sand', hint: '极简克制:纸感底 + 墨棕字,大量留白,只留一条强调线' },
  creative: { engine: 'clay', hint: '创意设计:暖陶土底,砖红与赭石撞色,版面活泼' },
  clay: { engine: 'clay', hint: '陶土温暖:粉橙底 + 砖红,手作温度感' },
}

/** 提示词里出现过的全部预设名(站点 7 个 + 引擎 4 个,任一都能被认) */
export const THEME_PRESETS = [
  'business',
  'tech',
  'education',
  'marketing',
  'minimal',
  'creative',
  'clay',
  'ink',
  'sand',
  'sage',
] as const

export type ThemePreset = (typeof THEME_PRESETS)[number]

/** 预设名归一化:引擎名原样保留,站点名映射到引擎名,其余回落 sage */
export function normalizePresetName(preset?: string | null): keyof typeof ENGINE_PRESETS {
  const key = String(preset || '').trim().toLowerCase()
  if (!key) return 'sage'
  if (key in ENGINE_PRESETS) return key as keyof typeof ENGINE_PRESETS
  const mapped = SITE_PRESETS[key]
  return mapped ? mapped.engine : 'sage'
}

/** 预设的一句话风格说明(只描述气质,不含色值) */
export function presetHint(preset?: string | null): string {
  const key = String(preset || '').trim().toLowerCase()
  const site = SITE_PRESETS[key]
  if (site) return site.hint
  const engine = normalizePresetName(preset)
  const label: Record<keyof typeof ENGINE_PRESETS, string> = {
    ink: '深墨:暗底、浅面板、暖色正文',
    sand: '暖沙:纸感底色 + 墨棕标题',
    sage: '雾绿:冷而安静,仍然有颜色',
    clay: '陶土:暖场 + 砖红标题 + 赭石数字',
  }
  return `${engine} 预设(${label[engine]})`
}

/**
 * 预设 → 引擎主题。字体按语言给:引擎默认字体族没有中日文字形,
 * 中文 deck 必须显式声明中文字面,否则整份 pptx 的字会掉到 fallback。
 */
export function resolvePresetTheme(preset?: string | null, language = 'zh-CN'): EngineThemeSpec {
  const base = ENGINE_PRESETS[normalizePresetName(preset)]
  const cjk = /^(zh|ja|ko)/i.test(language)
  const face = cjk ? 'Microsoft YaHei' : 'Segoe UI'
  return { ...base, colors: { ...base.colors }, fonts: { heading: face, body: face, numeric: face } }
}

// ---------- 类型 ----------

/** 一张可用配图。`path` 是管线落盘后的路径(引擎只认本地文件与 data: URI) */
export interface SpecSourceImage {
  /** Unsplash provider photo ID, used to select/attribute a concrete asset */
  id?: string
  /** 原始地址;阶段 4 的管线也用它传"已落盘的路径"(见 buildSpecPrompt 的说明) */
  url: string
  /** 已落盘的路径(优先于 url) */
  path?: string
  caption?: string
  author?: string
  licence?: string
  pageUrl?: string
}

/** 阶段 3 / 阶段 4 共用的输入面 */
export interface SpecPromptInput {
  topic: string
  audience?: string | null
  tone?: string | null
  preset?: string | null
  customStyle?: string | null
  /** 已合并好的风格描述(站点 preset / 用户自定义风格 / 基调三选一) */
  styleHint?: string | null
  customRequirements?: string | null
  language: string
  slideCount: number
  /** 调研阶段的资料文本(S2 产出) */
  facts?: string
  images?: SpecSourceImage[]
}

/**
 * 一页大纲:页面原型名 + 自包含的要点。
 *
 * 这里是**唯一真源**:pipeline/types.ts 直接 re-export 本类型(见其 PageOutline 别名)。
 * 曾经两边各写一份,加了 keyMessage / visualIntent 之后只有一处能编译 —— 版面提示词
 * 拿到的字段与大纲解析写回的字段必须是同一份契约。
 */
export interface OutlinePage {
  title: string
  template: string
  brief: string
  /** 本页唯一核心结论(规格阶段据此保持信息焦点) */
  keyMessage?: string
  /** 视觉表达意图:应该让观众看到 / 比较 / 理解什么 */
  visualIntent?: string
  /** 面向图库的英文场景检索词,由规划模型给出 */
  imageQuery?: string
  /** 页面级检索后绑定到本页的具体图片 ID(由 pipeline/research.ts 写回) */
  imageId?: string
  /** 本页引用的真实来源(标题或 URL),只填研究资料里确实存在的 */
  evidenceRefs?: string[]
}

/** 与 pipeline/types.ts 的 PageOutline 同形,便于跨模块引用 */
export type PageOutline = OutlinePage

/** 阶段 3 产物:只有在"讲什么"层面做的决定 */
export interface OutlinePlan {
  title: string
  styleName: string
  preset: string
  pages: OutlinePage[]
}

/** 阶段 4 可注入的已解析主题(通常来自 pipeline/theme.ts 的 themeFor) */
export interface SpecThemeLike {
  name?: string
  colors: Record<string, string>
}

// ---------- 构图契约 ----------

/**
 * 每种页面原型的默认构图策略。规划阶段(visualIntent)与规格阶段
 * (buildSpecPrompt 的"构图执行要求")共用这一份措辞:模型在两层看到的是同一条约束,
 * 而不是"先给一句意图、到规格阶段再自由发挥"。
 */
export const VISUAL_FALLBACK: Record<string, string> = {
  cover: '以标题和副标题建立主题,使用强弱层级与大面积留白,不堆叠信息卡片。',
  section: '用章节标题、短引导语和强烈色块建立叙事停顿,不放常规内容列表。',
  hero: '采用主标题与辅助视觉的非对称构图,形成一个明确视觉焦点。',
  content: '围绕一个结论组织少量证据,采用清晰标题、正文和重点强调。',
  editorial: '采用杂志式编辑布局,以一段主张配合侧栏注释或关键事实。',
  kpi: '用少量大数字形成视觉层级,每个指标配简短解释,避免重复卡片堆叠。',
  comparison: '建立明确的对照轴,左右内容必须可比较,最后给出结论。',
  process: '用步骤、阶段或因果关系形成连续阅读路径。',
  quote: '突出一句关键引述,来源和解释作为次级信息。',
  bento: '用不等权重的模块形成大小节奏,主模块明显大于辅助模块。',
  table: '用结构化表格承载精确比较,表前给结论,表后给解读。',
  chart: '用图表表达一个趋势或差异,标题写结论而非图表名称。',
  image: '让图片承担主要叙事,配简短标题和必要注释,图片必须与页面结论相关。',
  credits: '以来源清单承载图片与素材署名,不承载正文论据。',
}

/**
 * 一页的构图执行要求:原型默认策略 + 本页专项视觉意图。
 * 单一实现(曾经 quality.ts 与 pptx-prompts.ts 各有一份,只有一份被真正调用)。
 */
export function compositionGuidance(page: { template?: string; visualIntent?: string }): string {
  const archetype = String(page?.template || '').trim().toLowerCase() || 'content'
  const base = VISUAL_FALLBACK[archetype] || VISUAL_FALLBACK.content
  const intent = String(page?.visualIntent || '').replace(/\s+/g, ' ').trim()
  return intent ? `${base} 本页专项视觉意图：${intent}` : base
}

/** 用户的额外要求(表单收集):规划与规格共用同一措辞,保证两层都遵守 */
export function customRequirementsSection(customRequirements?: string | null): string {
  const req = (customRequirements || '').trim()
  if (!req) return ''
  return `【用户的额外要求(必须遵守)】\n${req}`
}

// ---------- 元素契约 ----------

const ELEMENT_REFERENCE = `## 元素契约(每个元素都会写成一类真正的原生对象)
| 元素 | 必填 | 可选 |
| --- | --- | --- |
| text | text | role("title" 或 "heading"), fontSize, bold, italic, color, align, valign, bullet |
| shape | h | fill, lineColor, lineWidth, radius, shadow, transparency |
| line | h | color, width, dash, beginArrowType, endArrowType |
| image | path, h, credit | fit(cover/contain/crop/fill), focus, zoom, filter, radius, altText, outline, shadow |
| chart | chartType, h, data | options{showLegend, showValue, chartColors, legendPos, barDir} |
| table | h, rows | options{colW, fontSize, valign}, source |
| container | children | background, columns(1-6), columnTracks, rowGap, crossGap, gap, padding, fill, radius, lineColor, shadow, align, justify, columnSpan, rowSpan |

排布规则(引擎 layout.js 的实测行为,照做就不会越界):
- 元素**不要写 x / y / w**:顶层元素自上而下流式排布,宽度随页面与容器的栏宽。
- **文字元素不要写 h**:高度由布局按字号与栏宽实测;写了 h 反而可能压字或留大洞。
- shape / line / image / chart / table 不是文字,必须给 h(面板高度)。
- **卡片 = container + \`background: true\` + fill/radius/padding**。只写 fill 而漏掉
  \`background\` 的容器**不会被画出来**:整页会变成"标题 + 一堆散字"。
- 分栏:等分用 \`columns\`;不对称版心用 \`columns\` + \`columnTracks:[{"fr":1.6},{"fr":1}]\`
  (左文右图、图表 2:1、表 2:1 都靠它)。
- 网格里让一格占更多地方用 \`columnSpan\`(首卡跨 2 列是最省事的节奏手段)。
- 标题文本一律写 role: "title"(小标题写 "heading"),正文不写 role。
- chartType 取值:bar / line / pie / doughnut / area / radar / scatter。
- chart 的 data 形如 [{"name":"系列","labels":["Q1","Q2"],"values":[18,34]}]。
- table 的 rows 是二维数组;单元格可写字符串,也可写 {"text":"…","options":{"bold":true}};首行是表头。
- 颜色一律六位十六进制、不带 #;长度单位一律英寸。`

// ---------- 系统规范(常驻,阶段 4 共用) ----------

/** 站点 6+1 个风格预设 → 引擎预设的对照表(写进系统提示,让模型说得出风格名) */
const SITE_PRESET_TABLE = Object.entries(SITE_PRESETS)
  .map(([name, preset]) => `| ${name} | ${preset.engine} | ${preset.hint} |`)
  .join('\n')

export const SPEC_SYSTEM = `你是原生 PPTX 演示文稿的规格设计师。你产出的 JSON 会被原生引擎逐元素写成 PowerPoint 原生对象:文本框是真的文本框、表格是 a:tbl、图表带着可编辑的内嵌工作簿。你的任务不是"画得像",而是"把内容描述成结构"。

## 输出纪律
- 只输出纯 JSON 对象,不要代码块包裹,不要任何解释、前言或后记。
- 不要写样式表、标记语言、脚本或任何排版指令;颜色一律六位十六进制(不带 #),长度单位一律英寸。
- 字段名用本提示词给出的名字,不自创字段,不加注释。
- 不在页面上编造数据:数字与年份只能来自给定资料,资料没有就写定性判断。

## 画布
- pageSize 一律 "wide":13.333 × 7.5 英寸;左右正文边距由页面 margin 决定,可用宽度约 11.8 英寸。
- 元素自上而下流式排布;分栏靠 container 的 columns,不靠手写坐标。

## 风格预设(站点表单 7 选 1,各自落到一套引擎预设)
| 站点预设 | 引擎预设 | 气质 |
| --- | --- | --- |
${SITE_PRESET_TABLE}

阶段 3 只需在 preset 里写预设名;阶段 4 的色板由服务端按预设注入,你照抄提示词里给出的十六进制即可。

## 三条硬规则(违反会被引擎或版式判据打回)
1. **盒高由布局实测,不要写死 h**。文字元素的 h 一律省略,让布局按字号和栏宽实测换行高度;绝不用 h 去"挤进"一页。容器高度由子元素撑开,也不写 h。只有面板类(shape / image / chart / table)才给 h。
2. **一页一个量级**。同一张图表里的数值必须同量级:能放 26.6 对 135,不能放 26.6 对 3600(小柱子会消失,页面就在骗人)。跨度超过约 50 倍时,把可比的一组放进图表,异常值单独用文本或指标卡说明,并写明这是换算后的数字。坐标轴从 0 起,不许截断。
3. **图片必须带 credit**。image 元素必须同时给 credit.subject(画面内容)、credit.author(作者)、credit.licence(许可),三者都不能空;path 只能用给定清单里的路径,不许编造地址,也不能写远程 URL。没有合规署名的图不要放进 deck。

## 文档纪律
- 资料片段的标题/站点/日期只用于判断新旧,不要写进页面;页面上不写"资料来源:""据 XX 报道"这类行。唯一例外是 table 的 source 字段与图片署名。
- 中文 deck 用简体中文;英文/日文 deck 跟随 language。
- 每页承载 60-120 字实质内容:不空洞,也不塞满。卡片标题 ≤12 字、说明 ≤20 字,给文字留出框内余量。
- 不出现占位文字(如 Lorem ipsum),不写页眉页脚页码,不写"第 X 页/共 Y 页"。

${ELEMENT_REFERENCE}`

// ---------- 阶段 3:大纲 ----------

const TEMPLATE_REFERENCE = `## 页面原型(大纲里的 template 取值,只能从这个表里选)
| 原型 | 结构 | 什么时候用 |
| --- | --- | --- |
| cover | 大标题 + 细线 + 副标题 | 封面 |
| section | 整页色块 + 章节标题 + 一句说明 | 章节过渡、收束 |
| hero | 大标题 + 说明 + 图形块 | 全篇最核心的一句主张 |
| content | 标题 + 细线 + 一段正文 | 单点阐释 |
| editorial | 标题 + 导语 + 双栏论证 | 观点 + 证据 |
| kpi | 标题 + 2-4 个指标卡(数值/标签/注解) | 关键数字 |
| comparison | 标题 + 左右两卡 + 结论句 | 方案/做法对比 |
| process | 标题 + 3-5 个步骤(序号/标题/说明) | 流程、路径 |
| quote | 一句大字号引语 + 出处 | 一句话立论 |
| bento | 标题 + 3-6 格要点网格 | 并列要点 |
| table | 标题 + 表格(首行表头)+ 注解 | 结构化数据 |
| chart | 标题 + 一张图表 + 读图结论 | 趋势、构成 |
| image | 标题 + 一张配图 + 说明 + 署名 | 视觉重心(需要可用配图) |

引擎还有第 12 个模板 credits(图片来源页)。本站的署名写在每张图的 credit 上,不要产出 credits 页。`

/** 构建阶段 3 的用户提示:只要大纲 */
export function buildPlanPrompt(input: SpecPromptInput): string {
  const lines: string[] = ['请为以下需求规划一份演示文稿大纲:只决定"讲什么"和"用哪种页面原型",不要设计样式。', '']
  lines.push(`- 主题: ${input.topic}`)
  lines.push(`- 页数: ${input.slideCount} 页(必须正好 ${input.slideCount} 条 pages)`)
  lines.push(`- 语言: ${input.language}`)
  if (input.audience) lines.push(`- 受众: ${input.audience}`)
  if (input.tone) lines.push(`- 基调: ${input.tone}`)
  const styleHint = (input.styleHint || input.customStyle || '').trim()
  if (styleHint) lines.push(`- 风格: ${styleHint}`)
  if (input.preset) lines.push(`- 风格预设: ${input.preset}(${presetHint(input.preset)})`)

  const req = customRequirementsSection(input.customRequirements)
  if (req) lines.push('', req)

  if (input.facts) {
    lines.push('', '## 真实资料与来源证据(内容必须基于这些事实,不要编造数据)')
    lines.push(input.facts.slice(0, 6000))
    lines.push('使用市场规模、增长率、政策、公司案例等可核验事实时，brief 必须保留对应来源标题或 URL；资料不足时降低断言强度或明确标记待核实。模型内置知识/Kimi Formula 结果不视为博查网页来源。')
  }

  const usable = (input.images || []).filter((image) => image.path || image.url)
  lines.push('', '## 配图素材库')
  if (usable.length > 0) {
    lines.push(
      `本次检索并下载了 ${usable.length} 张候选配图。最多安排 ${Math.min(3, usable.length)} 页使用图片；只在图片能强化该页信息时使用，不要为了填版而使用。`,
    )
    for (const image of usable) {
      lines.push(`- image_id=${image.id || 'unknown'} | 描述：${image.caption || '无描述'} | 摄影师：${image.author || 'Unknown'} | 页面：${image.pageUrl || image.url} | 本地素材：${image.path || '不可用'}`)
    }
    lines.push('如果某页使用图片，必须在该页 brief 中原样写出 image_id=<对应 ID>，并说明画面与该页核心观点的关系；同一张图片不得重复用于多页。')
    lines.push('不要在 brief 中编造素材 ID、摄影师或图片来源。')
  } else {
    lines.push('本次没有可用配图:不要安排整页大图,用 kpi / bento / editorial / table 承载视觉重心。')
  }

  lines.push('', TEMPLATE_REFERENCE, '')
  lines.push('## 输出格式(严格 JSON,不要代码块包裹)')
  lines.push('{')
  lines.push('  "title": "整份演示文稿的标题",')
  lines.push('  "styleName": "风格名(如:雾绿商务)",')
  lines.push('  "preset": "引擎主题预设名(ink / sand / sage / clay 之一)",')
  lines.push('  "pages": [')
  lines.push('    { "title": "页标题", "template": "cover", "key_message": "本页唯一核心结论", "visual_intent": "用何种视觉关系表达核心结论", "image_query": "English visual scene keywords for Unsplash, or empty string", "evidence_refs": ["真实来源标题或 URL"], "brief": "这一页要讲的全部内容:标题、要点、数字、结论" }')
  lines.push('  ]')
  lines.push('}')
  lines.push('')
  lines.push('## 大纲纪律')
  lines.push('- 第 1 页 cover;最后一页 section(总结 / 行动建议)。')
  lines.push(`- 中间页在 ${PAGE_ARCHETYPES.filter((name) => name !== 'cover' && name !== 'section').join(' / ')} 之间轮换,相邻两页不要用同一原型。`)
  lines.push('- 页数 ≥10 时,每 3-5 张内容页后插一张 section 作章节过渡。')
  lines.push('- 需要数字对比用 kpi / comparison / table;趋势与构成用 content 页承载图表;一句话观点用 quote;并列要点用 bento。')
  lines.push('- 每页必须给 key_message(一句核心结论) 与 visual_intent(说明视觉焦点、对比关系或阅读路径),不要只写内容摘要。')
  lines.push('- 对需要图片的页面给 image_query:简短、具体的英文摄影场景关键词(不是抽象概念,避免文字/海报/Logo),无图片需求则为空字符串。')
  lines.push('- evidence_refs 只能填写本次研究资料里真实存在的来源标题或 URL;没有外部证据时返回空数组,不得杜撰。')
  lines.push('- brief 必须自包含:该页要写的标题、小标题、正文、数字、结论全写进去;规格阶段只照 brief 展开,不会补内容。')
  lines.push('- 只返回 JSON 对象。')
  return lines.join('\n')
}

// ---------- 阶段 4:Deck Spec ----------

/** 把 hex 字符串洗干净成引擎要的六位大写 */
function cleanHex(value: string | undefined): string | null {
  const raw = String(value || '').trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : null
}

/**
 * 把"注入主题 + 预设"收敛成七色。注入主题优先:它是最终落进 pptx 的那一份;
 * 缺项落到预设表,保证提示词里永远有真实十六进制(不让模型自己发明颜色)。
 */
function resolveColors(options: {
  theme?: SpecThemeLike
  preset?: string | null
  language?: string
}): EngineColors {
  const fallback = resolvePresetTheme(options.preset, options.language || 'zh-CN').colors
  const fromTheme = options.theme?.colors || {}
  const out = {} as EngineColors
  for (const key of COLOR_KEYS) {
    out[key] = cleanHex(fromTheme[key]) || fallback[key]
  }
  return out
}

/**
 * 每种原型的元素骨架(不带坐标:排布交给布局)。
 *
 * 这些骨架是**契约的一部分**,不是散文:模型会照着抄。所以每条都必须是引擎真能排出来的形状,
 * 而且必须带上那几个"不写就没效果"的开关 —— 踩过的坑:
 *   - 卡片只写 fill 不写 `background: true`,引擎一个像素都不画(卡片全隐形,整份稿子看起来
 *     只剩标题和一堆散字);
 *   - 全用 `columns` 等分列,整份稿子就是"标题 + 三个等宽卡片";`columnTracks` 才能做
 *     左文右图、图表 2:1 这类版心节奏。
 */
function templateRecipes(c: EngineColors): string {
  /** 卡片骨架:background 是开关,fill/radius/lineColor 只有配上它才画得出来 */
  const card = (children: string): string =>
    `{"type":"container","background":true,"fill":"${c.surface}","lineColor":"${c.border}",`
    + `"radius":0.12,"padding":0.26,"gap":0.1,"children":[${children}]}`

  return `## 每种原型的元素骨架(照骨架填内容,不要自己发明排布)

通用开关:
- 卡片 = container + **\`background: true\`** + fill/radius/padding。**漏掉 background,卡片不会被画出来**。
- 等分栏用 \`columns\`;不对称版心用 \`columns\` + \`columnTracks:[{"fr":1.6},{"fr":1}]\`(数字是宽度比例)。
- 每页第一行是 kicker(可选),第二行是 role:"title";正文段落不写 role。
- 一页最多两个视觉重心。卡片之间必须留 gap;不要一页塞 6 个等宽卡片。

封面 cover(居中由站点处理,不要写 x/y):
{"template":"cover","background":"${c.background}","elements":[
  {"type":"text","text":"KICKER 一行(可选)","fontSize":10,"bold":true,"color":"${c.accent}"},
  {"type":"text","role":"title","text":"主标题","fontSize":40,"bold":true,"color":"${c.primary}"},
  {"type":"shape","h":0.05,"fill":"${c.accent}","line":false},
  {"type":"text","text":"副标题 / 汇报人 / 日期","fontSize":15,"color":"${c.muted}"}]}

章节过渡 section(整页色块,字用底色):
{"template":"section","background":"${c.primary}","elements":[
  {"type":"text","text":"CHAPTER 01","fontSize":11,"bold":true,"color":"${c.accent}"},
  {"type":"text","role":"title","text":"章节标题","fontSize":28,"bold":true,"color":"${c.background}"},
  {"type":"shape","h":0.04,"fill":"${c.accent}","line":false},
  {"type":"text","text":"一句过渡说明","fontSize":14,"color":"${c.background}"}]}

主张页 hero(左文右数据的不对称版心):
{"template":"hero","background":"${c.background}","elements":[
  {"type":"text","text":"核心主张","fontSize":10,"bold":true,"color":"${c.accent}"},
  {"type":"text","role":"title","text":"这一页只讲一个主张","fontSize":32,"bold":true,"color":"${c.foreground}"},
  {"type":"container","columns":2,"columnTracks":[{"fr":1.5},{"fr":1}],"gap":0.4,"children":[
    {"type":"container","gap":0.14,"children":[
      {"type":"text","text":"两到三句说明:为什么成立、靠什么支撑。","fontSize":15,"color":"${c.foreground}"},
      {"type":"shape","h":0.02,"fill":"${c.border}","line":false},
      {"type":"text","text":"补充一句限定条件或口径。","fontSize":12,"color":"${c.muted}"}]},
    ${card(`{"type":"text","text":"三个数字","fontSize":10,"bold":true,"color":"${c.accent}"},
      {"type":"container","columns":2,"columnTracks":[{"fr":1},{"fr":2}],"gap":0.16,"children":[
        {"type":"text","text":"69%","fontSize":26,"bold":true,"color":"${c.accent}"},
        {"type":"container","gap":0.02,"children":[
          {"type":"text","text":"指标名","fontSize":13,"color":"${c.foreground}"},
          {"type":"text","text":"一句注解","fontSize":10,"color":"${c.muted}"}]}]}`)}]}]}

阐释页 content(标题 + 分隔线 + 正文,必要时加一张要点卡):
{"template":"content","background":"${c.background}","elements":[
  {"type":"text","role":"title","text":"页标题","fontSize":26,"bold":true,"color":"${c.foreground}"},
  {"type":"shape","h":0.02,"fill":"${c.border}","line":false},
  {"type":"text","text":"一段 60-120 字的正文,先给判断,再给依据,最后给边界。","fontSize":14,"color":"${c.foreground}"},
  ${card(`{"type":"text","role":"heading","text":"要点小标题","fontSize":15,"bold":true,"color":"${c.primary}"},
    {"type":"text","text":"把它写成一句能独立成立的话。","fontSize":13,"color":"${c.foreground}"}`)}]}

编辑式 editorial(导语 + 主栏 1.4 : 注栏 1):
{"template":"editorial","background":"${c.background}","elements":[
  {"type":"text","text":"INSIGHT / ANALYSIS","fontSize":10,"bold":true,"color":"${c.accent}"},
  {"type":"text","role":"title","text":"页标题","fontSize":28,"bold":true,"color":"${c.foreground}"},
  {"type":"text","text":"先给能独立成立的核心判断(一句)。","fontSize":17,"color":"${c.primary}"},
  {"type":"shape","h":0.04,"fill":"${c.accent}","line":false},
  {"type":"container","columns":2,"columnTracks":[{"fr":1.4},{"fr":1}],"gap":0.38,"children":[
    {"type":"container","gap":0.12,"children":[
      {"type":"text","role":"heading","text":"论点","fontSize":16,"bold":true,"color":"${c.primary}"},
      {"type":"text","text":"两段论证,每段 40-70 字。","fontSize":14,"color":"${c.foreground}"}]},
    ${card(`{"type":"text","role":"heading","text":"注","fontSize":14,"bold":true,"color":"${c.primary}"},
      {"type":"text","text":"口径 / 来源 / 限制条件,可以比正文更短。","fontSize":12,"color":"${c.muted}"}`)}]}]}

指标页 kpi(首卡跨 2 列形成节奏,其余等分):
{"template":"kpi","background":"${c.background}","elements":[
  {"type":"text","role":"title","text":"页标题","fontSize":26,"bold":true,"color":"${c.foreground}"},
  {"type":"container","columns":3,"gap":0.22,"rowGap":0.22,"children":[
    {"type":"container","background":true,"fill":"${c.surface}","lineColor":"${c.border}","radius":0.12,"padding":0.26,"gap":0.1,"columnSpan":2,"children":[
      {"type":"text","text":"62%","fontSize":38,"bold":true,"color":"${c.accent}"},
      {"type":"text","text":"最重要的那个指标(一句话说清它是什么)","fontSize":14,"color":"${c.foreground}"},
      {"type":"text","text":"口径与时间范围","fontSize":11,"color":"${c.muted}"}]},
    ${card(`{"type":"text","text":"3.2s","fontSize":26,"bold":true,"color":"${c.accent}"},
      {"type":"text","text":"指标名","fontSize":13,"color":"${c.foreground}"},
      {"type":"text","text":"注解","fontSize":10,"color":"${c.muted}"}`)},
    ${card(`{"type":"text","text":"153","fontSize":26,"bold":true,"color":"${c.accent}"},
      {"type":"text","text":"指标名","fontSize":13,"color":"${c.foreground}"},
      {"type":"text","text":"注解","fontSize":10,"color":"${c.muted}"}`)},
    ${card(`{"type":"text","text":"34","fontSize":26,"bold":true,"color":"${c.accent}"},
      {"type":"text","text":"指标名","fontSize":13,"color":"${c.foreground}"},
      {"type":"text","text":"注解","fontSize":10,"color":"${c.muted}"}`)}]},
  {"type":"text","text":"口径 / 时间说明","fontSize":10,"color":"${c.muted}"}]}

对比页 comparison(两栏同构 + 结论条):
{"template":"comparison","background":"${c.background}","elements":[
  {"type":"text","role":"title","text":"页标题","fontSize":26,"bold":true,"color":"${c.foreground}"},
  {"type":"container","columns":2,"gap":0.26,"children":[
    ${card(`{"type":"text","role":"heading","text":"方案 A","fontSize":16,"bold":true,"color":"${c.muted}"},
      {"type":"text","text":"两到三句说明,含关键差异。","fontSize":14,"color":"${c.foreground}"}`)},
    ${card(`{"type":"text","role":"heading","text":"方案 B","fontSize":16,"bold":true,"color":"${c.primary}"},
      {"type":"text","text":"两到三句说明,含关键差异。","fontSize":14,"color":"${c.foreground}"}`)}]},
  {"type":"container","background":true,"fill":"${c.primary}","radius":0.12,"padding":0.22,"children":[
    {"type":"text","text":"一句结论:两者差别到底在哪里。","fontSize":13,"color":"${c.background}"}]}]}

流程页 process(3-5 列,每列一步):
{"template":"process","background":"${c.background}","elements":[
  {"type":"text","role":"title","text":"页标题","fontSize":26,"bold":true,"color":"${c.foreground}"},
  {"type":"container","columns":4,"gap":0.2,"children":[
    ${card(`{"type":"text","text":"01","fontSize":22,"bold":true,"color":"${c.accent}"},
      {"type":"text","role":"heading","text":"步骤名","fontSize":14,"bold":true,"color":"${c.foreground}"},
      {"type":"text","text":"一句说明(≤20 字)","fontSize":11,"color":"${c.muted}"}`)},
    ${card(`{"type":"text","text":"02","fontSize":22,"bold":true,"color":"${c.accent}"},
      {"type":"text","role":"heading","text":"步骤名","fontSize":14,"bold":true,"color":"${c.foreground}"},
      {"type":"text","text":"一句说明","fontSize":11,"color":"${c.muted}"}`)},
    ${card(`{"type":"text","text":"03","fontSize":22,"bold":true,"color":"${c.accent}"},
      {"type":"text","role":"heading","text":"步骤名","fontSize":14,"bold":true,"color":"${c.foreground}"},
      {"type":"text","text":"一句说明","fontSize":11,"color":"${c.muted}"}`)}]},
  {"type":"text","text":"一句总括:这套流程解决什么问题。","fontSize":11,"color":"${c.muted}"}]}

引语页 quote(整页居中,字要大):
{"template":"quote","background":"${c.primary}","elements":[
  {"type":"text","role":"title","text":"结论先行","fontSize":18,"bold":true,"color":"${c.accent}"},
  {"type":"text","text":"「这一页只放一句能独立成立的话。」","fontSize":30,"bold":true,"color":"${c.background}"},
  {"type":"shape","h":0.04,"w":2.2,"fill":"${c.accent}","line":false},
  {"type":"text","text":"— 出处 / 年份","fontSize":11,"color":"${c.border}"}]}

要点网格 bento(格数必须是 列数 的整数倍;首格跨 2 列形成不等权重,示范为 4 格 = 2+1+1+1):
{"template":"bento","background":"${c.background}","elements":[
  {"type":"text","role":"title","text":"页标题","fontSize":26,"bold":true,"color":"${c.foreground}"},
  {"type":"container","columns":3,"gap":0.22,"rowGap":0.22,"children":[
    {"type":"container","background":true,"fill":"${c.surface}","lineColor":"${c.border}","radius":0.12,"padding":0.26,"gap":0.1,"columnSpan":2,"children":[
      {"type":"text","role":"heading","text":"主格(最重要的一条)","fontSize":17,"bold":true,"color":"${c.primary}"},
      {"type":"text","text":"两句说明,把这一格讲透。","fontSize":13,"color":"${c.foreground}"}]},
    ${card(`{"type":"text","role":"heading","text":"辅格","fontSize":15,"bold":true,"color":"${c.primary}"},
      {"type":"text","text":"一到两句说明。","fontSize":12,"color":"${c.foreground}"}`)},
    ${card(`{"type":"text","role":"heading","text":"辅格","fontSize":15,"bold":true,"color":"${c.primary}"},
      {"type":"text","text":"一到两句说明。","fontSize":12,"color":"${c.foreground}"}`)},
    ${card(`{"type":"text","role":"heading","text":"辅格","fontSize":15,"bold":true,"color":"${c.primary}"},
      {"type":"text","text":"一到两句说明。","fontSize":12,"color":"${c.foreground}"}`)}]}]}

数据表 table(表占主栏 2 份,读数占 1 份;表必须给 h):
{"template":"table","background":"${c.background}","elements":[
  {"type":"text","role":"title","text":"页标题","fontSize":26,"bold":true,"color":"${c.foreground}"},
  {"type":"container","columns":2,"columnTracks":[{"fr":2},{"fr":1}],"gap":0.3,"children":[
    {"type":"table","h":3.4,"options":{"fontSize":12,"valign":"middle"},"rows":[
      [{"text":"列一","options":{"bold":true}},{"text":"列二","options":{"bold":true}},{"text":"列三","options":{"bold":true}}],
      ["值","值","值"]]},
    {"type":"container","gap":0.12,"children":[
      {"type":"text","role":"heading","text":"读数","fontSize":14,"bold":true,"color":"${c.primary}"},
      {"type":"text","text":"表里最该被记住的一条是什么。","fontSize":12,"color":"${c.foreground}"}]}]}]}`
}

/** 图表页与配图页的骨架(它们靠元素拼,不靠引擎的模板函数) */
function extraRecipes(c: EngineColors): string {
  return `图表页 chart(数据进图表,不要进图片;同一个图表里的系列必须同量级。图占 2 份宽,读数占 1 份):
{"template":"chart","background":"${c.background}","elements":[
  {"type":"text","text":"TREND","fontSize":10,"bold":true,"color":"${c.accent}"},
  {"type":"text","role":"title","text":"标题写结论,不要写「图表」这两个字","fontSize":26,"bold":true,"color":"${c.foreground}"},
  {"type":"container","columns":2,"columnTracks":[{"fr":2},{"fr":1}],"gap":0.3,"children":[
    {"type":"container","gap":0.1,"children":[
      {"type":"chart","chartType":"bar","h":3.5,
       "data":[{"name":"系列A","labels":["Q1","Q2","Q3","Q4"],"values":[18,34,52,69]}],
       "options":{"showLegend":true,"showValue":true,"chartColors":["${c.primary}","${c.accent}"]}},
      {"type":"text","text":"数据来源 / 口径","fontSize":10,"color":"${c.muted}"}]},
    {"type":"container","gap":0.12,"children":[
      {"type":"container","background":true,"fill":"${c.surface}","lineColor":"${c.border}","radius":0.12,"padding":0.22,"children":[
        {"type":"text","text":"69","fontSize":24,"bold":true,"color":"${c.accent}"},
        {"type":"text","text":"最该被记住的那个数","fontSize":12,"color":"${c.muted}"}]},
      {"type":"text","text":"一句读图结论:趋势说明了什么、为什么。","fontSize":12,"color":"${c.foreground}"}]}]}]}

配图页 image(只有清单里给了 path 的图能用;credit 三个字段都不能空。图占主栏,文字占次栏):
{"template":"image","background":"${c.background}","elements":[
  {"type":"text","text":"配图不是装饰","fontSize":10,"bold":true,"color":"${c.accent}"},
  {"type":"text","role":"title","text":"页标题","fontSize":26,"bold":true,"color":"${c.foreground}"},
  {"type":"container","columns":2,"columnTracks":[{"fr":1.15},{"fr":1}],"gap":0.34,"children":[
    {"type":"image","path":"<清单里的 path>","h":4.0,"fit":"cover","radius":0.12,"altText":"画面说明",
     "credit":{"subject":"画面内容","author":"作者","licence":"许可"}},
    {"type":"container","gap":0.12,"children":[
      {"type":"text","text":"这张图说明了什么(与本页结论的关系)。","fontSize":14,"color":"${c.foreground}"},
      {"type":"shape","h":0.02,"fill":"${c.border}","line":false},
      {"type":"text","text":"Photo by 作者 / 许可","fontSize":10,"color":"${c.muted}"}]}]}]}

其他原型也可以追加图表或配图元素:hero / content 页在标题与正文之后加一个 chart(h 3.2-4.0)
或 image(h 3.2-3.8),再加一行注解即可。不要把图表塞进卡片里,也不要整页只有一张图没有文字。`
}

/**
 * 构建阶段 4 的用户提示:按大纲产出可直接送引擎的 Deck Spec。
 *
 * `theme` 是服务端注入的已解析主题(pipeline/theme.ts 的 themeFor):提示词里给模型的
 * 十六进制与最终落进 pptx 的十六进制必须是同一份,否则图表的系列色会和页面底色打架。
 * 不传 theme 时回落到本模块的引擎预设表(plan.preset → 四套预设之一)。
 */
export function buildSpecPrompt(plan: OutlinePlan, input: SpecPromptInput, theme?: SpecThemeLike): string {
  const colors = resolveColors({ theme, preset: plan.preset || input.preset, language: input.language })
  const presetName = theme?.name || normalizePresetName(plan.preset || input.preset)
  const pages = plan.pages || []
  const lines: string[] = []

  lines.push('请把下面的大纲展开成一份 Deck Spec(纯 JSON),它会被原生引擎直接写成 pptx。')
  lines.push('')
  lines.push('## 这份 deck 的主题(服务端会用它覆盖 theme,你只需在 theme.preset 里写预设名)')
  lines.push(`- 预设:${presetName}(${presetHint(presetName)})`)
  lines.push('- 色板(元素里要颜色就抄这些值,六位十六进制不带 #):')
  lines.push(`  background ${colors.background} · surface ${colors.surface} · foreground ${colors.foreground}`)
  lines.push(`  primary ${colors.primary} · accent ${colors.accent} · muted ${colors.muted} · border ${colors.border}`)
  lines.push('- 页面元素自上而下流式排布,不写 x/y/w;文字不写 h。')
  lines.push('')

  lines.push(`## 大纲(${pages.length} 页,顺序与原型必须照搬)`)
  pages.forEach((page, index) => {
    lines.push(`${index + 1}. [${page.template}] ${page.title}`)
    if (page.keyMessage) lines.push(`   核心结论：${page.keyMessage}`)
    if (page.visualIntent) lines.push(`   视觉意图：${page.visualIntent}`)
    lines.push(`   构图执行要求：${compositionGuidance(page)}`)
    if (page.imageId) lines.push(`   本页指定配图：image_id=${page.imageId}(只能在这一页使用,不要挪到别的页)`)
    if (page.evidenceRefs?.length) lines.push(`   证据引用：${page.evidenceRefs.join('；')}`)
    lines.push(`   页面内容：${page.brief}`)
  })

  const req = customRequirementsSection(input.customRequirements)
  if (req) lines.push('', req)

  if (input.facts) {
    lines.push('', '## 真实资料(数字与年份只能来自这里)')
    lines.push(input.facts.slice(0, 6000))
  }

  const usable = (input.images || [])
    .map((image) => ({ path: (image.path || image.url || '').trim(), image }))
    .filter((entry) => entry.path && !/^https?:\/\//i.test(entry.path))
  lines.push('', '## 可用配图(只能用这些 path,并且每张图都要带 credit)')
  if (usable.length === 0) {
    lines.push('没有可用配图:不要产出 image 元素。')
  } else {
    usable.slice(0, 10).forEach((entry, index) => {
      const subject = entry.image.caption || '配图'
      const author = entry.image.author || '未知作者'
      const licence = entry.image.licence || 'Unsplash License'
      lines.push(`${index + 1}. image_id="${entry.image.id || 'unknown'}" · path="${entry.path}" · subject="${subject}" · author="${author}" · licence="${licence}"`)
    })
    lines.push('引用时必须遵守大纲指定的 image_id；原样抄 path 与三个 credit 字段,不要改写作者名或许可名。不得使用大纲未选择的图片,不得重复使用同一图片。')
  }

  lines.push('', '## 输出格式(严格 JSON,不要代码块包裹)')
  lines.push('{')
  lines.push(`  "title": ${quote(plan.title || input.topic)},`)
  lines.push(`  "language": ${quote(input.language)},`)
  lines.push('  "pageSize": "wide",')
  lines.push(`  "theme": { "preset": "${presetName}" },`)
  lines.push('  "slides": [')
  lines.push(`    { "template": "cover", "background": "${colors.background}", "notes": "讲稿(可选)", "elements": [ … ] }`)
  lines.push('  ]')
  lines.push('}')
  lines.push('')
  lines.push(`- slides 必须正好 ${pages.length} 页,顺序与大纲一致,template 抄大纲里的原型名。`)
  lines.push('- 每一页都要有非空 elements 与 background;常规页用 background,surface / primary 只用于对比页与章节页。')
  lines.push('- 需要讲稿时写 notes(字符串):它进备注页,不出现在画面上。')
  lines.push('- 页面原型不是标签：必须按每页的构图执行要求落实到原生元素结构。相邻页面不能连续复制同一种卡片布局。')
  lines.push('- 同一份 deck 应有封面、章节停顿、数据表达、比较、流程、编辑式页面等节奏变化；只在内容确实需要时使用对应原型。')
  lines.push('- 每页先表达 key_message,再组织 supporting evidence;visual_intent 决定构图和视觉焦点,不要把页面做成无差别卡片堆。')
  lines.push('- evidence_refs 是内容依据,不能把模型推断伪装成外部事实;必要时将来源 URL 放入 notes 或 table.source。')
  lines.push('- 内容量按 brief:brief 里没有的东西不要补,资料里没有的数字不要编。')
  lines.push('')
  lines.push(templateRecipes(colors))
  lines.push('')
  lines.push(extraRecipes(colors))
  lines.push('')
  lines.push('只返回 JSON 对象。')

  return lines.join('\n')
}

/**
 * 构建阶段 4 的修复提示:把引擎 --check 的错误(或 --strict 的版式警告)原文喂回模型。
 * 判据是引擎说了算,所以错误原文逐条照抄,不做归纳。
 * previousOutput 是上一轮模型的原始文本(改的是它,不是我们收敛后的对象)。
 */
export function buildSpecRepairPrompt(
  previousOutput: string,
  errors: string[],
  plan?: OutlinePlan,
): string {
  const lines: string[] = []
  lines.push('你上一次输出的 Deck Spec 没有通过原生引擎的校验,请修正后重新输出完整 JSON。')
  lines.push('')
  lines.push('## 引擎报出的问题(逐条修掉,不要绕过)')
  const list = errors.length > 0 ? errors.slice(0, 30) : ['(引擎没给具体条目,请按下面清单自查)']
  list.forEach((message) => lines.push(`- ${message}`))
  if (errors.length > 30) lines.push(`- … 另有 ${errors.length - 30} 条`)
  lines.push('')
  lines.push('## 自查清单')
  lines.push('- slides 是否非空,每页是否有非空 elements;页数是否与大纲一致。')
  lines.push('- 文字元素是否都没有 h、没有 x/y/w;shape / image / chart / table 是否都有 h。')
  lines.push('- 分栏是否走 container 的 columns,而不是靠手写坐标。')
  lines.push('- 颜色是否六位十六进制且不带 #;chart 的 data 是否是 [{name, labels, values}] 数组。')
  lines.push('- table 的 rows 是否是二维数组、首行作表头;单元格文字是否短到能排下。')
  lines.push('- image 是否带 credit 的 subject / author / licence,path 是否来自给定清单。')
  lines.push('- 是否残留任何样式表、标记语言、脚本或注释。')
  lines.push('- 版式警告(越界 / 文字溢出 / 文字重叠)通常来自写死 h 或内容过长:压内容,别压字号。')
  if (plan && plan.pages.length > 0) {
    lines.push('')
    lines.push(`## 大纲(${plan.pages.length} 页,展开后页数必须一致)`)
    plan.pages.forEach((page, index) => {
      lines.push(`${index + 1}. [${page.template}] ${page.title}`)
    })
  }
  lines.push('')
  lines.push('## 上一次的输出(留作对照,不要保留其中的错误)')
  lines.push((previousOutput || '(空)').slice(0, 12000))
  lines.push('')
  lines.push('只返回修正后的完整 JSON 对象,不要解释改了什么。')
  return lines.join('\n')
}

// ---------- 阶段 5:按页修复 ----------

/**
 * 只重写"有问题的那几页"的提示词。
 *
 * 为什么不整份重写:整份重写会顺手改动本来没问题的页(实测:同一句 brief,
 * 两次输出的卡片数量、图片位置、甚至原型都会变),而"修好 3 页、弄坏 8 页"
 * 比不修更糟。这里给模型的输入是**问题页原文 + 其它页的一行摘要**,输出只收
 * 问题页,合并由调用方按 index 做,非目标页一个字节都不动。
 */
export function buildPageRepairPrompt(
  plan: OutlinePlan,
  spec: { slides: Array<{ template?: string; background?: string; notes?: string; elements?: unknown[] }> },
  targets: Array<{ page: number; lines: string[] }>,
): string {
  const lines: string[] = []
  lines.push('这份 Deck Spec 已经能被引擎写成 pptx,但下面这几页有实测问题。')
  lines.push('请**只重写这几页**,其余页保持原样 —— 输出的 slides 里只需要这几页。')
  lines.push('')
  lines.push('## 硬约束(违反会让整份规格被引擎拒绝,修复轮直接作废)')
  lines.push('- 页数与顺序不变:每页仍对应原来的页码与页面原型。')
  lines.push('- 元素不写 x / y / w;文字元素不写 h;shape / image / chart / table 必须有 h。')
  lines.push('- 不新增图片:只能用下面"可用配图"里给出的 path,并原样抄 credit 三个字段。')
  lines.push('- 颜色六位十六进制不带 #;单位英寸;不写任何标记语言 / 样式表 / 脚本。')
  lines.push('- 内容不能变少到丢结论:改动幅度以"解决这条问题"为准,不要整页换题。')
  lines.push('')
  lines.push('## 要修的页')
  for (const target of targets) {
    const page = spec.slides[target.page - 1]
    const outline = plan.pages[target.page - 1]
    lines.push(`### 第 ${target.page} 页 · 原型 ${page?.template || outline?.template || 'content'}`)
    if (outline?.title) lines.push(`- 页标题:${outline.title}`)
    if (outline?.keyMessage) lines.push(`- 核心结论:${outline.keyMessage}`)
    if (outline?.visualIntent) lines.push(`- 视觉意图:${outline.visualIntent}`)
    lines.push('- 实测问题:')
    for (const line of target.lines) lines.push(`  - ${line}`)
    lines.push('- 这一页现在的元素:')
    lines.push(JSON.stringify({ template: page?.template, background: page?.background, elements: page?.elements || [] }))
    lines.push('')
  }
  lines.push('## 其它页(不要输出,不要改动,仅供理解上下文)')
  spec.slides.forEach((slide, index) => {
    if (targets.some((target) => target.page === index + 1)) return
    lines.push(`${index + 1}. [${slide.template || 'content'}] ${plan.pages[index]?.title || ''}`)
  })
  lines.push('')
  lines.push('## 输出格式(严格 JSON,不要代码块包裹)')
  lines.push('{ "slides": [ { "index": <页码,从 1 开始>, "template": "原型的名字", "background": "十六进制", "notes": "讲稿(可选)", "elements": [ … ] } ] }')
  lines.push('')
  lines.push('只返回 JSON 对象。')
  return lines.join('\n')
}

// ---------- 阶段 2:检索查询 ----------

/** 构建搜索查询(3 条,覆盖数据/背景/案例) */
/**
 * 检索角度:三组"内容型"问题 + 一组"权威口径"问题。
 *
 * 实测(低空经济):只问内容型问题时,9 条来源里 8 条来自研报代销站,官方口径一条都
 * 没进来 —— PPT 里引用的数字于是全都无法追溯。多问一句"政策 / 官方 / 数据"能把
 * gov.cn、部委、统计口径的页面拉进来;来源分级(见 pipeline/sources.ts)再把它们排到前面。
 * 多这一次检索的成本,比"整份 deck 的引用都不可信"低得多。
 */
export function buildSearchQueries(topic: string): string[] {
  const year = new Date().getFullYear()
  return [
    `${topic} ${year}年 市场规模 最新数据`,
    `${topic} ${year}年 行业现状 发展趋势`,
    `${topic} 典型案例 应用场景`,
    `${topic} 政策文件 官方数据 发布`,
  ]
}

// ---------- 内部助手 ----------

/** JSON 字符串字面量(避免手写引号出错) */
function quote(value: string): string {
  return JSON.stringify(value)
}
