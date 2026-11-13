/**
 * pipeline/mock.ts — 无密钥自测桩(NATIVE_MOCK_LLM=1)
 *
 * 为什么需要它:改造后的链路要能在没有 LLM key、没有 Unsplash key 的机器上跑完整
 * e2e(G6)。mock 只替换"会花钱/会联网的东西"(S2 搜索、S3 大纲、S4 规格),
 * 引擎构建、DB 落库、账务、终态守卫全部走真实代码 —— 这样 G6 的绿灯才有意义。
 *
 * fixture 的硬要求:≥8 页、≥4 种页面原型、chart/table/image 各至少一张。
 * 图片由本模块用 zlib 现场编一张 PNG(不联网、不落仓库文件)。
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { deflateSync } from 'zlib'
import { MOCK_LLM_ENV, type DeckElement, type DeckSlide, type DeckSpecJson, type OutlinePlan } from './types'
import { themeFor } from './theme'

/** 是否处于 mock 模式:任何取值形式都认(1/true/yes) */
export function isMockLLM(): boolean {
  const raw = (process.env[MOCK_LLM_ENV] || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

// ── 三种模板的最小造型工具 ────────────────────────────────────────────────

/** 页标题:引擎按文字量算高度,不给 h */
function title(text: string, color: string, size = 30): DeckElement {
  return { type: 'text', role: 'title', text, fontSize: size, bold: true, color }
}

/** 细分隔线(shape,高度 0.02in) */
function hairline(fill: string): DeckElement {
  return { type: 'shape', h: 0.02, fill, line: false }
}

/** 卡片:容器 + 内边距 + 圆角,子元素垂直堆叠,高度由内容决定 */
function card(colors: Record<string, string>, children: DeckElement[]): DeckElement {
  return {
    type: 'container',
    background: true,
    fill: colors.surface,
    lineColor: colors.border,
    radius: 0.12,
    padding: 0.26,
    gap: 0.1,
    children,
  }
}

function bodyText(text: string, color: string, size = 13): DeckElement {
  return { type: 'text', text, fontSize: size, color }
}

function smallNote(text: string, color: string): DeckElement {
  return { type: 'text', text, fontSize: 10, color }
}

// ── 现场生成一张 PNG(640×360 渐变),供 image 页面使用 ────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0,
  ]
}

/** 生成一张 from→to 的对角渐变 PNG,返回绝对路径(同机同参即同图) */
export function writeMockImage(dir: string, from: string, to: string): string {
  const width = 640
  const height = 360
  const [r0, g0, b0] = hexToRgb(from)
  const [r1, g1, b1] = hexToRgb(to)
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const t = (x / (width - 1) + y / (height - 1)) / 2
      raw[offset++] = Math.round(r0 + (r1 - r0) * t)
      raw[offset++] = Math.round(g0 + (g1 - g0) * t)
      raw[offset++] = Math.round(b0 + (b1 - b0) * t)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'mock-photo.png')
  writeFileSync(file, png)
  return file
}

// ── S2 调研桩 ─────────────────────────────────────────────────────────────

export function mockResearch(topic: string): { facts: string; images: [] } {
  return {
    facts: [
      `### ${topic}(fixture 事实,非真实检索)`,
      `- 本段是 NATIVE_MOCK_LLM=1 下的确定性 fixture:结构、模板与数据全部可复现,内容值不属于任何真实来源。`,
      `- 用途只有一个:让 e2e 在没有 LLM key / 搜索 key 的机器上跑完整的 S2→S5 与账务链路。`,
      `- 真实模式下本段由 search-client(博查 → Kimi Formula → 知识摘要)产出。`,
    ].join('\n'),
    images: [],
  }
}

// ── S3 大纲桩 ─────────────────────────────────────────────────────────────

const ARCHETYPES: Array<{ template: string; title: string; brief: string }> = [
  { template: 'cover', title: '封面', brief: '主标题、副标题与一条线索;不写正文。' },
  { template: 'kpi', title: '四个关键数字', brief: '四个并列指标卡,每个含数值、标签、一句注解。' },
  { template: 'comparison', title: '两种做法对照', brief: '左右两栏各一段说明,底部一句结论。' },
  { template: 'chart', title: '数据趋势', brief: '一张柱状图 + 右侧两张指标卡,图注说明数据来源。' },
  { template: 'table', title: '对象清单', brief: '一张三列表格,表头加粗,末尾一句注解。' },
  { template: 'image', title: '图文页', brief: '一张配图 + 一段说明 + 图片署名。' },
  { template: 'quote', title: '一句话结论', brief: '大字号引语 + 出处说明。' },
  { template: 'section', title: '收束', brief: '章节标题 + 三条要点收尾。' },
]

export function mockOutline(input: { topic: string; slideCount: number }): OutlinePlan {
  const count = Math.max(2, Math.min(25, input.slideCount || 8))
  const pages = Array.from({ length: count }, (_, index) => {
    const archetype = ARCHETYPES[index % ARCHETYPES.length]
    return {
      title: index === 0 ? input.topic : `${archetype.title}(${index + 1})`,
      template: archetype.template,
      brief: archetype.brief,
    }
  })
  return {
    title: input.topic,
    styleName: '原生预设 · 雾绿',
    preset: 'sage',
    pages,
  }
}

// ── S4 规格桩 ─────────────────────────────────────────────────────────────

function coverSlide(theme: ReturnType<typeof themeFor>, topic: string): DeckSlide {
  const c = theme.colors
  return {
    template: 'cover',
    background: c.background,
    notes: '封面:标题 + 副标题 + 一条细线,全部是原生文本与形状。',
    elements: [
      title(topic, c.primary, 36),
      hairline(c.border),
      bodyText('由原生引擎直接写出:每个字都是可编辑的 run,没有整页截图。', c.muted, 14),
      smallNote('NATIVE DECK / FIXTURE', c.accent),
    ],
  }
}

function kpiSlide(theme: ReturnType<typeof themeFor>): DeckSlide {
  const c = theme.colors
  const items = [
    { value: '0', label: '整页截图', note: '每页都是原生对象' },
    { value: '5', label: '对象类型', note: '文本/形状/表格/图表/图片' },
    { value: '1', label: '内嵌工作簿', note: '图表数据可改' },
    { value: '6', label: '构建闸门', note: '--check 与 --strict' },
  ]
  return {
    template: 'kpi',
    background: c.background,
    notes: '四个指标卡是容器 + 文本,数字与标签各自可编辑。',
    elements: [
      title('四件事同时成立,才算原生', c.foreground, 26),
      {
        type: 'container',
        columns: 4,
        gap: 0.22,
        rowGap: 0.22,
        children: items.map((item) =>
          card(c, [
            { type: 'text', text: item.value, fontSize: 30, bold: true, color: c.accent },
            bodyText(item.label, c.foreground, 14),
            smallNote(item.note, c.muted),
          ]),
        ),
      },
      smallNote('数字为 fixture 占位,非真实统计。', c.muted),
    ],
  }
}

function comparisonSlide(theme: ReturnType<typeof themeFor>): DeckSlide {
  const c = theme.colors
  return {
    template: 'comparison',
    background: c.background,
    notes: '对照页:两张卡片承载两段说明,底部一句结论。',
    elements: [
      title('同一页,两种做法', c.foreground, 26),
      {
        type: 'container',
        columns: 2,
        gap: 0.26,
        children: [
          card(c, [
            bodyText('整页截图导出', c.foreground, 16),
            bodyText('像素一致,但每个字都不可选;改一个数字要回原文件重来。', c.muted),
          ]),
          card(c, [
            bodyText('原生生成(本工具)', c.foreground, 16),
            bodyText('输入是 Deck Spec:内容与结构直接写成元素,没有需要反推的样式。', c.muted),
          ]),
        ],
      },
      bodyText('差别不在于像不像,而在于还能不能改。', c.muted, 12),
    ],
  }
}

function chartSlide(theme: ReturnType<typeof themeFor>): DeckSlide {
  const c = theme.colors
  return {
    template: 'chart',
    background: c.background,
    notes: '图表带着内嵌工作簿;改数不需要重新排版。',
    elements: [
      title('数据进图表,不是进图片', c.foreground, 26),
      {
        type: 'chart',
        chartType: 'bar',
        h: 3.9,
        data: [
          { name: '原生对象', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [18, 34, 52, 69] },
          { name: '栅格页面', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [12, 6, 2, 0] },
        ],
        options: {
          barDir: 'col',
          showLegend: true,
          chartColors: [c.primary, c.accent],
        },
      },
      smallNote('两个系列、四个季度;轴与图例是图表属性,颜色来自主题预设。', c.muted),
    ],
  }
}

function tableSlide(theme: ReturnType<typeof themeFor>): DeckSlide {
  const c = theme.colors
  return {
    template: 'table',
    background: c.background,
    notes: '表格是 a:tbl;每个单元格都是可编辑文本。',
    elements: [
      title('原生对象清单', c.foreground, 26),
      {
        type: 'table',
        h: 3.5,
        options: { fontSize: 12, valign: 'middle' },
        rows: [
          [
            { text: '对象', options: { bold: true } },
            { text: 'OOXML', options: { bold: true } },
            { text: '在 PowerPoint 里可以做什么', options: { bold: true } },
          ],
          ['文本', 'a:r', '双击直接改字;字距、粗细、颜色各自独立'],
          ['形状', 'p:sp', '拖动、改填充与描边、加阴影'],
          ['表格', 'a:tbl', '改单元格、加行、合并;表头行可重复'],
          ['图表', 'c:chart', '右键"编辑数据",改的是内嵌工作簿'],
        ],
      },
      smallNote('以上四类都出现在本文件里;没有一类是整页图片。', c.muted),
    ],
  }
}

function imageSlide(theme: ReturnType<typeof themeFor>, imagePath: string | null): DeckSlide {
  const c = theme.colors
  const elements: DeckElement[] = [
    title('图片是原生 p:pic', c.foreground, 26),
  ]
  if (imagePath) {
    elements.push({
      type: 'image',
      path: imagePath,
      h: 3.1,
      fit: 'cover',
      radius: 0.12,
      altText: 'fixture 渐变图',
      credit: { subject: 'fixture 渐变图', author: 'native-ppt-engine fixture', licence: 'CC0' },
    })
  } else {
    elements.push({
      type: 'shape',
      h: 3.1,
      fill: c.surface,
      lineColor: c.border,
      lineWidth: 1,
      radius: 0.12,
    })
  }
  elements.push(bodyText('替换、裁剪、加边框都是原生图片对象的属性,不经过栅格化。', c.muted))
  elements.push(smallNote('图片由 fixture 现场生成(zlib 编码 PNG),不属于任何第三方来源。', c.muted))
  return { template: 'image', background: c.background, elements }
}

function quoteSlide(theme: ReturnType<typeof themeFor>, topic: string): DeckSlide {
  const c = theme.colors
  return {
    template: 'quote',
    background: c.surface,
    notes: '引语页:一句结论 + 出处。',
    elements: [
      title('结论先行', c.primary, 20),
      { type: 'text', text: `「${topic}:先把结构写进规格,再让引擎算坐标。」`, fontSize: 26, bold: true, color: c.foreground },
      hairline(c.border),
      smallNote('— 原生引擎 fixture', c.muted),
    ],
  }
}

function sectionSlide(theme: ReturnType<typeof themeFor>): DeckSlide {
  const c = theme.colors
  return {
    template: 'section',
    background: c.primary,
    notes: '收束页:深色底 + 三条要点。',
    elements: [
      { type: 'text', role: 'title', text: '三步交付', fontSize: 30, bold: true, color: c.background },
      { type: 'text', text: '① 规格先校验(--check);② 布局与写入一次完成;③ --strict 布局警告即失败。', fontSize: 14, color: c.background },
      { type: 'text', text: '每一步都能单独复现,失败信息带引擎原文。', fontSize: 11, color: c.surface },
    ],
  }
}

/**
 * 生成 fixture Deck Spec。页数 = input.slideCount,前八页覆盖八种页面原型
 * (chart / table / image 各一),超过八页按同序循环。
 */
export function mockDeckSpec(
  input: { topic: string; language: string; slideCount: number },
  plan: OutlinePlan,
): DeckSpecJson {
  const theme = themeFor(plan.preset, input.language)
  let imagePath: string | null = null
  try {
    imagePath = writeMockImage(join(tmpdir(), 'native-mock-media'), theme.colors.accent, theme.colors.primary)
  } catch {
    imagePath = null // 写不出来就降级成色块,不让 fixture 因为 IO 挂掉
  }
  const count = Math.max(2, Math.min(25, input.slideCount || 8))
  const slides: DeckSlide[] = []
  for (let index = 0; index < count; index++) {
    switch (index % 8) {
      case 0:
        slides.push(coverSlide(theme, input.topic))
        break
      case 1:
        slides.push(kpiSlide(theme))
        break
      case 2:
        slides.push(comparisonSlide(theme))
        break
      case 3:
        slides.push(chartSlide(theme))
        break
      case 4:
        slides.push(tableSlide(theme))
        break
      case 5:
        slides.push(imageSlide(theme, imagePath))
        break
      case 6:
        slides.push(quoteSlide(theme, input.topic))
        break
      default:
        slides.push(sectionSlide(theme))
    }
    // 页数多于八页时,标题后缀区分,免得预览里八页同名
    if (index >= 8) {
      const round = Math.floor(index / 8) + 1
      const first = slides[slides.length - 1]
      const head = first.elements[0]
      if (head && head.type === 'text' && typeof head.text === 'string') {
        head.text = `${head.text}(${round})`
      }
    }
  }
  return {
    title: plan.title || input.topic,
    author: 'native-ppt-engine',
    language: input.language,
    pageSize: 'wide',
    theme,
    slides,
  }
}
