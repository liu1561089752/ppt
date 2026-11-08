'use strict';

/**
 * Complex multi-page stress fixture.
 *
 * This is deliberately a *designed* 12-slide deck, not a component gallery: it
 * exercises asymmetric covers, gradient section dividers, editorial two-column
 * layouts, KPI grids, comparison surfaces, flow and timeline diagrams, a native
 * chart, a native styled table, mixed image fitting, dense bilingual rich text,
 * and a closing page — while every slide must stay editable.
 *
 * Run it directly to write a PPTX:
 *   node pptx/examples/native_stress_deck.js out.pptx
 */

const path = require('node:path');
const { components } = require('../native');
const { writePngFixture, gradientPainter } = require('../native/scripts/sample_image');

const PAGE = { width: 13.333, height: 7.5 };
const M = 0.66;
const CW = PAGE.width - M * 2;

const theme = {
  name: 'editorial-annual-review',
  colors: {
    background: 'F7F7F4',
    foreground: '202321',
    primary: '183B3A',
    accent: 'D36B45',
    muted: '6B7470',
    surface: 'FFFFFF',
    border: 'DCE2DE'
  },
  fonts: { heading: 'Aptos Display', body: 'Aptos', cjk: 'Microsoft YaHei' },
  sizes: { title: 32, heading: 19, body: 13, caption: 8.5 },
  spacing: { xs: 0.08, sm: 0.14, md: 0.22, lg: 0.34, xl: 0.5, pageX: M, pageY: 0.5 },
  radii: { small: 0.06, medium: 0.12, large: 0.18 },
  typography: { titleWeight: 'bold', headingWeight: 'bold', bodyWeight: 'normal', lineSpacingMultiple: 1.26 },
  backgrounds: {
    gradient: { angle: 135, stops: [{ position: 0, color: '142536' }, { position: 0.58, color: '234B61' }, { position: 1, color: 'E56A42' }] }
  },
  effects: {
    cardBorder: true,
    shadow: { color: '1B2A28', opacity: 0.14, blur: 10, angle: 45, distance: 3 }
  }
};

const C = theme.colors;

function text(value, options = {}) {
  return Object.assign({ type: 'text', text: value }, options);
}

function shape(options = {}) {
  return Object.assign({ type: 'shape', line: false }, options);
}

function card(options = {}) {
  return {
    type: 'container',
    direction: options.direction || 'column',
    gap: options.gap === undefined ? 0.14 : options.gap,
    padding: options.padding === undefined ? 0.3 : options.padding,
    background: Object.assign({
      fill: C.surface,
      radius: theme.radii.large,
      lineColor: C.border,
      lineWidth: 0.75,
      shadow: theme.effects.shadow
    }, options.background || {}),
    children: options.children || [],
    ...(options.w === undefined ? {} : { w: options.w }),
    ...(options.flex === undefined ? {} : { flex: options.flex })
  };
}

function tableBody(rows) {
  return rows.map((row, index) => row.map((cell) => ({
    text: cell,
    options: {
      fontSize: 10.5,
      color: C.foreground,
      fill: { color: index % 2 === 0 ? 'FFFFFF' : 'F4F6F5' }
    }
  })));
}

function slideHeader(kicker, title) {
  return [
    text(kicker, {
      x: M, y: 0.46, w: 6.4, h: 0.22,
      fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.accent
    }),
    text(title, {
      x: M - 0.02, y: 0.72, w: CW, h: 0.66,
      fontFace: theme.fonts.heading, fontSize: theme.sizes.title, bold: true, color: C.primary
    }),
    { type: 'line', x: M, y: 1.5, w: CW, h: 0, color: C.border, width: 0.75 }
  ];
}

function buildStressDeck(assets) {
  const landscape = assets.landscape;
  const portrait = assets.portrait;
  const panorama = assets.panorama;

  return {
    title: '2025 年度回顾与 2026 战略',
    subject: 'Native engine stress fixture',
    language: 'zh-CN',
    pageSize: 'wide',
    theme,
    slides: [
      // 01 — asymmetric cover with a full-height picture column
      {
        background: C.background,
        notes: '封面：右侧整幅图片 + 左侧文本重心，刻意打破居中构图。',
        elements: [
          { type: 'image', path: portrait, x: 8.62, y: 0, w: PAGE.width - 8.62, h: PAGE.height, fit: 'cover', focus: 'center' },
          shape({ x: 0, y: 0, w: 8.62, h: PAGE.height, fill: C.background }),
          shape({ x: 0.92, y: 1.34, w: 0.1, h: 0.92, fill: C.accent }),
          text('ANNUAL REVIEW  /  2025', {
            x: 1.16, y: 1.32, w: 6.4, h: 0.24,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.muted
          }),
          text('在不确定的周期里\n把确定性做厚', {
            x: 0.92, y: 1.74, w: 6.9, h: 1.96,
            fontFace: theme.fonts.heading, fontSize: 42, bold: true, color: C.primary,
            lineSpacingMultiple: 1.12, valign: 'top'
          }),
          text('收入结构、毛利质量与现金流的完整复盘，以及 2026 年三条主线投入的取舍逻辑。',
            {
              x: 0.96, y: 3.82, w: 6.1, h: 1.0,
              fontFace: theme.fonts.body, fontSize: 14, color: C.foreground, valign: 'top'
            }),
          { type: 'line', x: 0.96, y: 5.06, w: 1.42, h: 0, color: C.accent, width: 2.4 },
          text('战略与经营 · 董事会材料', {
            x: 0.96, y: 5.34, w: 4.2, h: 0.28,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted
          }),
          text('内部资料 · 请勿外传', {
            x: 0.96, y: 5.62, w: 4.2, h: 0.28,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted
          }),
          text('01 / 12', {
            x: 0.96, y: 6.78, w: 2, h: 0.26,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.muted
          })
        ]
      },

      // 02 — gradient section divider with an oversized index number
      {
        background: C.primary,
        notes: '章节页：可编辑渐变形状 + 超大序号，全部是原生对象。',
        elements: [
          shape({
            x: 0, y: 0, w: PAGE.width, h: PAGE.height,
            fill: '142536',
            gradient: theme.backgrounds.gradient
          }),
          text('01', {
            x: 8.4, y: 0.9, w: 4.2, h: 3.4,
            fontFace: theme.fonts.heading, fontSize: 168, bold: true, color: '2A5E5C',
            align: 'right', valign: 'mid'
          }),
          text('SECTION 01', {
            x: 0.96, y: 2.5, w: 4.2, h: 0.24,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.accent
          }),
          text('经营基本盘', {
            x: 0.94, y: 2.9, w: 7.15, h: 0.94,
            fontFace: theme.fonts.heading, fontSize: 40, bold: true, color: 'FFFFFF'
          }),
          text('三年收入结构、毛利质量与自由现金流的轨迹，以及支撑 2026 年投入的现金安全垫。', {
            x: 0.98, y: 4.02, w: 6.3, h: 0.9,
            fontFace: theme.fonts.body, fontSize: 15, color: 'E8EDEB', valign: 'top'
          }),
          { type: 'line', x: 0.98, y: 5.28, w: 2.2, h: 0, color: C.accent, width: 2.4 },
          text('02 / 12', {
            x: 0.98, y: 6.78, w: 2, h: 0.26,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: '8FA3A1'
          })
        ]
      },

      // 03 — editorial lead plus two nested cards built from containers
      {
        background: C.background,
        notes: '编辑式版面：先给独立成立的核心判断，再用两张卡片展开证据。',
        elements: [
          ...slideHeader('INSIGHT / 01', '增长来自结构，而不是单点投入'),
          text('结论先行：新增收入的 62% 来自两个新产品线，而非既有大客户扩容。这说明结构升级已经发生，但组织能力尚未跟上。', {
            x: M, y: 1.72, w: CW - 0.6, h: 0.94,
            fontFace: theme.fonts.heading, fontSize: 17, color: C.primary,
            lineSpacingMultiple: 1.3, valign: 'top'
          }),
          {
            type: 'container', direction: 'row', gap: 0.4, align: 'stretch',
            x: M, y: 2.86, w: CW,
            children: [
              card({
                flex: 1,
                children: [
                  text('结构性机会', { w: undefined, fontFace: theme.fonts.heading, fontSize: theme.sizes.heading, bold: true, color: C.primary }),
                  text('两个新产品线在 18 个月内贡献了 62% 的增量收入，客户结构中腰部客户占比首次超过 40%。', {
                    fontFace: theme.fonts.body, fontSize: theme.sizes.body, color: C.foreground, valign: 'top'
                  }),
                  {
                    type: 'container', direction: 'row', gap: 0.3, align: 'end',
                    children: [
                      text('62%', { flex: 1, fontFace: theme.fonts.heading, fontSize: 26, bold: true, color: C.accent }),
                      text('增量收入贡献', { flex: 1, fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted })
                    ]
                  }
                ]
              }),
              card({
                flex: 1,
                background: { fill: '183B3A', lineColor: '183B3A' },
                children: [
                  text('组织缺口', { fontFace: theme.fonts.heading, fontSize: theme.sizes.heading, bold: true, color: 'FFFFFF' }),
                  text('交付人力仍按旧结构配置，新产品线的人均支持客户数是成熟线的 1.8 倍，是 2026 年最大的运营风险。', {
                    fontFace: theme.fonts.body, fontSize: theme.sizes.body, color: 'E8EDEB', valign: 'top'
                  }),
                  {
                    type: 'container', direction: 'row', gap: 0.3, align: 'end',
                    children: [
                      text('1.8x', { flex: 1, fontFace: theme.fonts.heading, fontSize: 26, bold: true, color: C.accent }),
                      text('人均支持客户数差异', { flex: 1, fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: 'A9BCBA' })
                    ]
                  }
                ]
              })
            ]
          }
        ]
      },

      // 04 — four-up KPI grid driven by a single column count
      {
        background: C.background,
        notes: 'KPI 网格：columns: 4 让四张卡片自动等宽等高。',
        elements: [
          ...slideHeader('METRICS / 02', '关键指标：四条曲线同时转正'),
          {
            type: 'container', columns: 4, gap: 0.3, align: 'stretch',
            x: M, y: 1.8, w: CW,
            children: [
              card({
                padding: 0.26, gap: 0.1,
                children: [
                  text('营业收入', { fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.muted }),
                  text('¥ 12.84 亿', { fontFace: theme.fonts.heading, fontSize: 24, bold: true, color: C.primary }),
                  text('+18.4% YoY', { fontFace: theme.fonts.body, fontSize: 10, bold: true, color: C.accent }),
                  text('连续四个季度加速', { fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted, valign: 'top' })
                ]
              }),
              card({
                padding: 0.26, gap: 0.1,
                children: [
                  text('毛利率', { fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.muted }),
                  text('61.2%', { fontFace: theme.fonts.heading, fontSize: 24, bold: true, color: C.primary }),
                  text('+3.6 pts', { fontFace: theme.fonts.body, fontSize: 10, bold: true, color: C.accent }),
                  text('产品结构升级驱动', { fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted, valign: 'top' })
                ]
              }),
              card({
                padding: 0.26, gap: 0.1,
                children: [
                  text('自由现金流', { fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.muted }),
                  text('¥ 1.96 亿', { fontFace: theme.fonts.heading, fontSize: 24, bold: true, color: C.primary }),
                  text('+41.0% YoY', { fontFace: theme.fonts.body, fontSize: 10, bold: true, color: C.accent }),
                  text('净现比 1.12', { fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted, valign: 'top' })
                ]
              }),
              card({
                padding: 0.26, gap: 0.1,
                children: [
                  text('客户留存', { fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.muted }),
                  text('94.6%', { fontFace: theme.fonts.heading, fontSize: 24, bold: true, color: C.primary }),
                  text('+2.1 pts', { fontFace: theme.fonts.body, fontSize: 10, bold: true, color: C.accent }),
                  text('腰部客户留存最高', { fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted, valign: 'top' })
                ]
              })
            ]
          },
          text('注：口径为合并报表，剔除一次性处置收益；自由现金流 = 经营现金流 − 资本开支。', {
            x: M, y: 5.5, w: CW, h: 0.3,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted
          }),
          { type: 'line', x: M, y: 5.28, w: 1.1, h: 0, color: C.accent, width: 2.2 },
          text('04 / 12', {
            x: M, y: 6.78, w: 2, h: 0.26,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.muted
          })
        ]
      },

      // 05 — two contrasting surfaces with rich-text runs
      {
        background: C.background,
        notes: '对比页：同一容器结构、不同表面处理，正文使用富文本 runs。',
        elements: [
          ...slideHeader('DECISION / 03', '两条路径的取舍：规模优先还是效率优先'),
          {
            type: 'container', direction: 'row', gap: 0.42, align: 'stretch',
            x: M, y: 1.82, w: CW,
            children: [
              card({
                flex: 1,
                children: [
                  text('A · 规模优先', { fontFace: theme.fonts.heading, fontSize: theme.sizes.heading, bold: true, color: C.primary }),
                  text([
                    { text: '逻辑：', options: { bold: true, color: C.accent } },
                    { text: '以更低价格换取份额，用 24 个月做到细分市场第一，再通过规模摊薄获客与交付成本。' }
                  ], { fontFace: theme.fonts.body, fontSize: theme.sizes.body, color: C.foreground, valign: 'top' }),
                  text([
                    { text: '代价：', options: { bold: true, color: C.accent } },
                    { text: '毛利率在 12 个月内下探 6–8 pts，现金流缺口约 8000 万，需要新一轮融资。' }
                  ], { fontFace: theme.fonts.body, fontSize: theme.sizes.body, color: C.foreground, valign: 'top' })
                ]
              }),
              card({
                flex: 1,
                background: { fill: 'FFF3EE', lineColor: 'F0C9B8', shadow: { color: 'D36B45', opacity: 0.12, blur: 12, angle: 45, distance: 3 } },
                children: [
                  text('B · 效率优先（建议）', { fontFace: theme.fonts.heading, fontSize: theme.sizes.heading, bold: true, color: 'A9482A' }),
                  text([
                    { text: '逻辑：', options: { bold: true, color: 'A9482A' } },
                    { text: '聚焦高毛利的两个产品线，用交付自动化把人均支持客户数提升 60%，释放的现金投入研发。' }
                  ], { fontFace: theme.fonts.body, fontSize: theme.sizes.body, color: C.foreground, valign: 'top' }),
                  text([
                    { text: '代价：', options: { bold: true, color: 'A9482A' } },
                    { text: '放弃部分低价大单，短期收入增速回落到 12% 左右，需要董事会接受增长节奏的调整。' }
                  ], { fontFace: theme.fonts.body, fontSize: theme.sizes.body, color: C.foreground, valign: 'top' })
                ]
              })
            ]
          },
          text('建议：选择 B，并在 2026 H2 用释放出的现金流评估 A 路线的窗口机会。', {
            x: M, y: 6.02, w: CW, h: 0.38,
            fontFace: theme.fonts.body, fontSize: 13, bold: true, color: C.primary
          })
        ]
      },

      // 06 — native flow diagram
      {
        background: C.surface,
        notes: '流程图：原生圆角矩形 + 原生箭头线。',
        elements: [
          ...slideHeader('OPERATING MODEL / 04', '交付自动化：五步改造路径'),
          ...components.processFlow([
            { title: '识别', description: '按行业与场景聚类现有交付动作' },
            { title: '标准化', description: '沉淀 12 个可复用交付模板' },
            { title: '工具化', description: '把模板转成内部自动化流程' },
            { title: '规模化', description: '新产品线全量切换，人力再配置' },
            { title: '度量', description: '以人均支持客户数为唯一北极星' }
          ], { theme, x: M, y: 2.24, w: CW, nodeHeight: 1.5, titleSize: 15, bodySize: 9.5 }),
          text('目标：18 个月内人均支持客户数从 6.4 提升到 10.2，交付人力总量不增。', {
            x: M, y: 4.36, w: CW, h: 0.34,
            fontFace: theme.fonts.body, fontSize: 13, color: C.foreground
          }),
          shape({ x: M, y: 5.05, w: CW, h: 1.24, fill: 'F1F4F2', radius: 0.12 }),
          text('风险提示', {
            x: M + 0.3, y: 5.24, w: 3, h: 0.26,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.accent
          }),
          text('工具化阶段会出现 4–6 周的双轨运行期，需要提前锁定 6 名交付骨干专职投入，否则会同时拖累新老业务。', {
            x: M + 0.3, y: 5.54, w: CW - 0.6, h: 0.6,
            fontFace: theme.fonts.body, fontSize: 12.5, color: C.foreground, valign: 'top'
          })
        ]
      },

      // 07 — native timeline
      {
        background: C.background,
        notes: '时间轴：原生线条 + 椭圆节点 + 文本。',
        elements: [
          ...slideHeader('ROADMAP / 05', '2026 年四个交付节点'),
          ...components.timeline([
            { date: '2026 Q1', title: '结构定稿', description: '完成产品线边界与人力再配置方案' },
            { date: '2026 Q2', title: '模板落地', description: '12 个交付模板上线并完成培训' },
            { date: '2026 Q3', title: '工具切换', description: '自动化流程替换 70% 手工动作' },
            { date: '2026 Q4', title: '规模复制', description: '人均支持客户数达标 10.2' }
          ], { theme, x: 1.0, y: 2.55, w: PAGE.width - 2.0 }),
          text('每个节点都有明确的验收口径与负责人；季度复盘中未达标的关键结果直接触发资源重排。', {
            x: M, y: 5.72, w: CW, h: 0.4,
            fontFace: theme.fonts.body, fontSize: 13, color: C.foreground
          })
        ]
      },

      // 08 — native chart beside an insight card
      {
        background: C.background,
        notes: '图表页：原生可编辑柱状图 + 右侧结论卡片，用行容器对齐高度。',
        elements: [
          ...slideHeader('CHART / 06', '收入结构：新产品线两年内成为主引擎'),
          {
            type: 'container', direction: 'row', gap: 0.4, align: 'stretch',
            x: M, y: 1.8, w: CW,
            children: [
              card({
                flex: 2.1, padding: 0.26,
                children: [
                  {
                    type: 'chart', chartType: 'bar',
                    h: 3.9,
                    data: [
                      { name: '成熟产品线', labels: ['2023', '2024', '2025', '2026E'], values: [6.2, 6.6, 6.9, 7.1] },
                      { name: '新产品线', labels: ['2023', '2024', '2025', '2026E'], values: [1.1, 3.4, 5.9, 8.2] }
                    ],
                    options: {
                      barDir: 'col',
                      showLegend: true,
                      legendPos: 'b',
                      legendFontSize: 9,
                      showValue: false,
                      catAxisLabelFontSize: 9,
                      valAxisLabelFontSize: 9,
                      chartColors: ['183B3A', 'D36B45']
                    }
                  },
                  text('单位：亿元 · 2026 为预算口径', {
                    fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted
                  })
                ]
              }),
              card({
                flex: 1, padding: 0.3, gap: 0.16,
                background: { fill: '183B3A', lineColor: '183B3A' },
                children: [
                  text('读图结论', { fontFace: theme.fonts.heading, fontSize: theme.sizes.heading, bold: true, color: 'FFFFFF' }),
                  text('2025 年是交叉点：新产品线收入首次接近成熟线的 86%，2026 年将完成反超。', {
                    fontFace: theme.fonts.body, fontSize: 12.5, color: 'E8EDEB', valign: 'top'
                  }),
                  text('这意味着资源投放的重点必须跟着迁移，而不是继续维护成熟线的规模惯性。', {
                    fontFace: theme.fonts.body, fontSize: 12.5, color: 'E8EDEB', valign: 'top'
                  }),
                  { type: 'line', w: 0.9, h: 0, color: C.accent, width: 2.2 }
                ]
              })
            ]
          }
        ]
      },

      // 09 — native styled table
      {
        background: C.surface,
        notes: '表格页：原生 PowerPoint 表格，表头与斑马纹通过单元格样式实现。',
        elements: [
          ...slideHeader('APPENDIX / 07', '分产品线经营明细'),
          {
            type: 'table',
            x: M, y: 1.86, w: CW, h: 3.55,
            rows: [
              [
                { text: '产品线', options: { bold: true, color: 'FFFFFF', fill: { color: '183B3A' }, fontSize: 11 } },
                { text: '收入（亿）', options: { bold: true, color: 'FFFFFF', fill: { color: '183B3A' }, fontSize: 11, align: 'right' } },
                { text: '毛利率', options: { bold: true, color: 'FFFFFF', fill: { color: '183B3A' }, fontSize: 11, align: 'right' } },
                { text: '同比', options: { bold: true, color: 'FFFFFF', fill: { color: '183B3A' }, fontSize: 11, align: 'right' } },
                { text: '2026 策略', options: { bold: true, color: 'FFFFFF', fill: { color: '183B3A' }, fontSize: 11 } }
              ],
              ...tableBody([
                ['核心平台', '6.92', '66.4%', '+4.1%', '守住毛利，控制定制'],
                ['数据服务', '3.18', '58.2%', '+32.6%', '主投入，补齐交付自动化'],
                ['行业方案', '1.74', '49.8%', '+21.0%', '聚焦两个高胜率行业'],
                ['海外业务', '0.86', '44.1%', '+58.2%', '试点，不追规模'],
                ['其他', '0.14', '31.5%', '−12.4%', '逐步收缩']
              ])
            ],
            options: {
              colW: [2.35, 1.85, 1.45, 1.3, 5.05],
              border: { type: 'solid', color: 'DCE2DE', pt: 0.5 },
              fontFace: theme.fonts.body,
              valign: 'mid',
              rowH: 0.42
            }
          },
          text('数据来源：管理报表（未经审计）。毛利率按产品线直接成本归集，未分摊总部费用。', {
            x: M, y: 5.72, w: CW, h: 0.32,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted
          })
        ]
      },

      // 10 — image fitting gallery as a real content grid
      {
        background: C.background,
        notes: '图片页：cover / contain / 圆角裁切三种适配方式在同一网格内对照。',
        elements: [
          ...slideHeader('VISUAL / 08', '现场与产品：三种图片适配方式'),
          {
            type: 'container', columns: 3, gap: 0.3, align: 'stretch',
            x: M, y: 1.8, w: CW,
            children: [
              card({
                padding: 0.2, gap: 0.12,
                children: [
                  { type: 'image', path: landscape, h: 2.28, fit: 'cover', radius: 0.1 },
                  text('COVER · 铺满裁切', { fontFace: theme.fonts.body, fontSize: 9, bold: true, color: C.muted }),
                  text('适合建立视觉重心，裁切由 a:srcRect 控制，可随时在 PowerPoint 中重新调整。', {
                    fontFace: theme.fonts.body, fontSize: 11.5, color: C.foreground, valign: 'top'
                  })
                ]
              }),
              card({
                padding: 0.2, gap: 0.12,
                children: [
                  { type: 'image', path: landscape, h: 2.28, fit: 'contain', lineColor: C.border, lineWidth: 0.75, lineDash: 'dash' },
                  text('CONTAIN · 完整显示', { fontFace: theme.fonts.body, fontSize: 9, bold: true, color: C.muted }),
                  text('适合图表、截图等不允许裁切的内容，图片框自动收敛到原始比例。', {
                    fontFace: theme.fonts.body, fontSize: 11.5, color: C.foreground, valign: 'top'
                  })
                ]
              }),
              card({
                padding: 0.2, gap: 0.12,
                children: [
                  { type: 'image', path: panorama, h: 2.28, fit: 'cover', zoom: 1.6, radius: 0.28,
                    shadow: { color: '1B2A28', opacity: 0.2, blur: 12, angle: 45, distance: 4 } },
                  text('ZOOM + 圆角 + 阴影', { fontFace: theme.fonts.body, fontSize: 9, bold: true, color: C.muted }),
                  text('zoom 收紧取景，圆角来自 a:prstGeom，阴影来自 a:effectLst，全部可编辑。', {
                    fontFace: theme.fonts.body, fontSize: 11.5, color: C.foreground, valign: 'top'
                  })
                ]
              })
            ]
          },
          text('三张图片都是原生图片对象，没有被拼成整页截图。', {
            x: M, y: 6.36, w: CW, h: 0.3,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: C.muted
          })
        ]
      },

      // 11 — dense bilingual long-form text in two auto-height columns
      {
        background: C.surface,
        notes: '长文页：两栏自动高度、中英混排、富文本 runs，用于验证密集内容的排版稳健性。',
        elements: [
          ...slideHeader('DISCUSSION / 09', '关于“效率优先”的三个反对意见'),
          {
            type: 'container', direction: 'row', gap: 0.5, align: 'start',
            x: M, y: 1.76, w: CW,
            children: [
              {
                type: 'container', direction: 'column', gap: 0.2, flex: 1,
                children: [
                  text([
                    { text: '反对一：', options: { bold: true, color: C.accent } },
                    { text: '放弃低价大单会削弱我们在核心客户内部的话语权。' }
                  ], { fontFace: theme.fonts.body, fontSize: 12.5, color: C.foreground, valign: 'top' }),
                  text('回应：用毛利率和留存率而不是收入规模衡量话语权。过去 24 个月，低价大单的平均留存是 71%，而腰部客户是 94.6%。放弃的是收入数字，不是客户关系。', {
                    fontFace: theme.fonts.body, fontSize: 12, color: C.muted, valign: 'top'
                  }),
                  text([
                    { text: '反对二：', options: { bold: true, color: C.accent } },
                    { text: '交付自动化的一次性投入太高，2026 年现金流会紧张。' }
                  ], { fontFace: theme.fonts.body, fontSize: 12.5, color: C.foreground, valign: 'top' }),
                  text('回应：工具化预算 3200 万，分四个季度投入；按人均支持客户数提升 60% 测算，14 个月即可回收，且不依赖外部融资。', {
                    fontFace: theme.fonts.body, fontSize: 12, color: C.muted, valign: 'top'
                  })
                ]
              },
              {
                type: 'container', direction: 'column', gap: 0.2, flex: 1,
                children: [
                  text([
                    { text: '反对三：', options: { bold: true, color: C.accent } },
                    { text: '组织能力提升的节奏无法用季度节点管理。' }
                  ], { fontFace: theme.fonts.body, fontSize: 12.5, color: C.foreground, valign: 'top' }),
                  text('回应：把能力拆成可度量的过程指标——模板覆盖率、双轨运行周数、自动化替代率，用过程指标替代“感觉在进步”的判断。', {
                    fontFace: theme.fonts.body, fontSize: 12, color: C.muted, valign: 'top'
                  }),
                  shape({ h: 0.02, fill: C.border }),
                  text('Decision required  ·  需要董事会本次会议明确的三件事：', {
                    fontFace: theme.fonts.body, fontSize: 10, bold: true, color: C.primary
                  }),
                  text('1) 接受 12% 的收入增速目标；2) 批准 3200 万工具化预算；3) 授权 Q2 完成人力再配置。', {
                    fontFace: theme.fonts.body, fontSize: 12, color: C.foreground, valign: 'top'
                  })
                ]
              }
            ]
          }
        ]
      },

      // 12 — closing statement
      {
        background: C.primary,
        notes: '收尾页：可编辑渐变条 + 大结论 + 联系信息行容器。',
        elements: [
          shape({
            x: 0, y: 0, w: PAGE.width, h: 0.28,
            fill: 'D36B45',
            gradient: { angle: 0, stops: [{ position: 0, color: 'D36B45' }, { position: 1, color: '00A6A6' }] }
          }),
          text('THE NEXT 12 MONTHS', {
            x: M, y: 1.62, w: 8, h: 0.26,
            fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: C.accent
          }),
          text('把结构红利\n变成组织能力', {
            x: M - 0.02, y: 2.02, w: 9.2, h: 1.86,
            fontFace: theme.fonts.heading, fontSize: 40, bold: true, color: 'FFFFFF',
            lineSpacingMultiple: 1.14, valign: 'top'
          }),
          text('2026 年我们不再需要更多的机会判断，而是把已经验证的三条主线执行到位。', {
            x: M, y: 4.06, w: 8.4, h: 0.8,
            fontFace: theme.fonts.body, fontSize: 14, color: 'E8EDEB', valign: 'top'
          }),
          { type: 'line', x: M, y: 5.28, w: 1.6, h: 0, color: C.accent, width: 2.4 },
          {
            type: 'container', direction: 'row', gap: 0.6, align: 'start',
            x: M, y: 5.72, w: CW,
            children: [
              text('战略与经营部', { flex: 1, fontFace: theme.fonts.body, fontSize: 11, bold: true, color: 'FFFFFF' }),
              text('2025 年度回顾 · 董事会材料', { flex: 1.6, fontFace: theme.fonts.body, fontSize: 11, color: 'A9BCBA' }),
              text('12 / 12', { flex: 1, fontFace: theme.fonts.body, fontSize: 11, bold: true, color: 'A9BCBA', align: 'right' })
            ]
          }
        ]
      }
    ]
  };
}

function buildAssets(directory) {
  return {
    landscape: writePngFixture(directory, 'stress-landscape.png', 960, 640, gradientPainter([24, 59, 58], [211, 107, 69])),
    portrait: writePngFixture(directory, 'stress-portrait.png', 640, 960, gradientPainter([18, 34, 45], [0, 166, 166])),
    panorama: writePngFixture(directory, 'stress-panorama.png', 1400, 460, gradientPainter([247, 244, 236], [24, 59, 58]))
  };
}

module.exports = { buildStressDeck, buildAssets, theme, PAGE, M, CW };

if (require.main === module) {
  const { generatePptx } = require('../native');
  const outputPath = process.argv[2] || 'native-stress-deck.pptx';
  const assetDir = process.argv[3] || path.join(process.cwd(), 'native-stress-assets');
  const assets = buildAssets(assetDir);
  generatePptx(buildStressDeck(assets), outputPath)
    .then((result) => {
      const warnings = result.report.reduce((sum, slide) => sum + slide.warnings.length, 0);
      console.log(JSON.stringify({ outputPath: result.outputPath, slides: result.report.length, warnings }, null, 2));
      result.report.forEach((slide) => {
        slide.warnings.forEach((warning) => console.log('slide ' + slide.slide + ' ' + warning.code + ': ' + warning.message));
      });
    })
    .catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
}
