'use strict';

/**
 * The flagship spec: six pages, built from the design system rather than from coordinates.
 *
 * `templates.*` returns a whole slide (background + elements) from a few content fields, and
 * `components.*` returns the pieces a page needs. A spec that is written like this stays readable
 * when the copy changes, because the page is described by what it is (a hero, a KPI row, a
 * comparison) and not by where each box happens to sit.
 *
 *   node native/cli.js ../examples/native_deck_spec.js native-deck.pptx --report native-deck.json
 */

const { templates, components } = require('../native');

const theme = {
  name: 'native-editorial',
  colors: {
    background: 'F7F7F4',
    surface: 'FFFFFF',
    foreground: '202321',
    primary: '183B3A',
    accent: 'D36B45',
    muted: '6B7470',
    border: 'DCE2DE'
  },
  fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' },
  sizes: { title: 32, heading: 20, body: 14, caption: 10 },
  spacing: { pageX: 0.78, pageY: 0.5 },
  radii: { small: 0.06, medium: 0.12, large: 0.2 },
  effects: { cardBorder: true },
  backgrounds: { gradient: { angle: 135, stops: [{ color: '1F4B45', position: 0 }, { color: '16272C', position: 1 }] } }
};

const margin = theme.spacing.pageX;

function sectionHead(title, lead) {
  return [
    components.title(title, { theme, x: margin, y: 0.62, w: 11.8, h: 0.62, fontSize: theme.sizes.title }),
    components.divider({ theme, x: margin + 0.02, y: 1.34, w: 11.75 }),
    ...(lead ? [components.paragraph(lead, {
      theme, x: margin + 0.04, y: 1.56, w: 11.2, h: 0.42,
      fontSize: theme.sizes.body, color: theme.colors.muted
    })] : [])
  ];
}

const deck = {
  title: '原生 PPTX 工具链',
  author: 'Native PowerPoint Engine',
  language: 'zh-CN',
  pageSize: 'wide',
  theme,
  slides: [
    Object.assign(templates.hero({
      theme,
      kicker: 'NATIVE DECK / TOOLCHAIN',
      title: '从规格到原生对象，中间不经过 HTML',
      subtitle: 'Deck Spec 描述内容与设计意图，布局引擎算坐标，写入器把每个元素写成 PowerPoint 自己的对象。',
      footer: 'SPEC  ·  LAYOUT  ·  OOXML',
      titleSize: 34
    }), { notes: '封面：一块渐变面板、一条细线、三段文字，全部是原生形状与文本。' }),

    (() => {
      // The template gives the four cards their measured geometry; a takeaway band and one line of
      // provenance close the page, because a KPI row alone leaves the bottom third empty.
      const page = templates.kpi({
        theme,
        title: '四件事同时成立，才算原生',
        items: [
          { label: '整页栅格', value: '0', note: '没有一页是截图' },
          { label: '文本框', value: '678', note: '21 套示例的逐包审计' },
          { label: '原生表格', value: '17', note: '含合并单元格' },
          { label: '内嵌工作簿', value: '8', note: '图表数据可改' }
        ]
      });
      page.elements.push(...components.infoCard({
        theme, x: margin, y: 4.42, w: 11.7, h: 1.72,
        title: '判断标准不是"长得像"，而是"里面是什么"',
        body: '一张整页截图也有像素完美的版式，但它的每个字都不可选。原生对象的判据是：文本框里有 run、'
          + '表格是 a:tbl、图表带着工作簿、形状带着自己的填充与描边——四类都在，才谈得上可编辑。'
      }));
      page.elements.push({
        type: 'text', text: '数字来自 pipeline-converted/ 的逐包审计：21 套 fixture、69 页、678 个文本框、1,386 个 run。',
        x: margin + 0.04, y: 6.36, w: 11.2, h: 0.28,
        fontFace: theme.fonts.body, fontSize: theme.sizes.caption, color: theme.colors.muted
      });
      return Object.assign(page, { notes: '卡片是形状、指标是文本；数字全部来自 pipeline-converted 里的实测审计。' });
    })(),

    Object.assign(templates.comparison({
      theme,
      title: '两条路径，不同的权威来源',
      left: {
        title: 'HTML 转 PPTX',
        body: '输入是已经画好的网页：解析器从 DOM 和 CSS 里还原盒模型、装饰与文本，适合把已有网页转成演示文稿。'
      },
      right: {
        title: '原生生成（本工具）',
        body: '输入是 Deck Spec：内容、结构与设计意图直接写成元素，没有需要反推的样式，也没有需要对齐的浏览器渲染。'
      }
    }), { notes: '对比页用两个原生卡片承载两段说明文字。' }),

    {
      background: theme.colors.surface,
      notes: '流程页的四个节点是形状，节点之间的箭头是线。',
      elements: [
        ...sectionHead('一次生成的六个步骤', '规格先校验，再算布局，最后逐元素写入；每一步都能单独复现。'),
        // processFlow draws the node, its title and `description`; the field is not `body`.
        ...components.processFlow([
          { title: '写规格', description: 'JSON / JS 模块' },
          { title: '校验', description: '类型与取值' },
          { title: '布局', description: '测量与排版' },
          { title: '写入', description: '五类原生对象' },
          { title: '补丁', description: '写入器之外' },
          { title: '验收', description: '渲染与审计' }
        ], { theme, x: margin + 0.04, y: 2.2, w: 11.7, nodeHeight: 1.95, bodySize: 11 }),
        components.paragraph('前四步是确定的；补丁那一步之所以存在，是因为写入器不写的属性——平铺填充、按系列线型、'
          + '表格里的行内 run——只能等文件写完之后再补进 OOXML。',
        { theme, x: margin + 0.04, y: 4.62, w: 11.2, h: 0.62, fontSize: theme.sizes.body, color: theme.colors.foreground }),
        components.paragraph('每一步都能单独运行：cli.js --check 只校验，npm test 只跑结构，visual_golden.py 只比图。',
        { theme, x: margin + 0.04, y: 6.28, w: 11.2, h: 0.3, fontSize: theme.sizes.caption, color: theme.colors.muted })
      ]
    },

    {
      background: theme.colors.surface,
      notes: '图表带着数据工作簿；改数不需要重新排版。',
      elements: [
        ...sectionHead('数据进图表，不是进图片', '两个系列、四个季度；轴与图例是图表属性，颜色来自主题。'),
        {
          type: 'chart', chartType: 'bar',
          x: margin + 0.02, y: 2.1, w: 7.3, h: 4.3,
          data: [
            { name: '原生对象', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [18, 34, 52, 69] },
            { name: '栅格页面', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [12, 6, 2, 0] }
          ],
          options: { barDir: 'col', showLegend: true, chartColors: ['183B3A', 'D36B45'] }
        },
        ...components.kpiCard({
          theme, x: 8.5, y: 2.1, w: 3.9, h: 1.85,
          label: '图表数 / 工作簿数', value: '8 / 8', note: '每个图表都内嵌一份 xlsx'
        }),
        ...components.kpiCard({
          theme, x: 8.5, y: 4.2, w: 3.9, h: 1.85,
          label: '写入器补丁', value: '19', note: '写入器不写、由补丁补上的属性'
        })
      ]
    },

    {
      background: theme.colors.surface,
      notes: '表格是 a:tbl；行高、对齐和表头重复都是单元格属性。',
      elements: [
        ...sectionHead('原生对象清单', '这一页的表格本身就是证明：每个单元格都是可编辑的文本。'),
        {
          type: 'table',
          x: margin + 0.02, y: 2.15, w: 11.7, h: 3.9,
          options: { fontSize: 12, valign: 'middle' },
          rows: [
            [
              { text: '对象', options: { bold: true } },
              { text: 'OOXML', options: { bold: true } },
              { text: '在 PowerPoint 里可以做什么', options: { bold: true } }
            ],
            ['文本', 'a:r', '双击直接改字；字距、粗细、颜色各自独立'],
            ['形状', 'p:sp', '拖动、改填充与描边、加阴影'],
            ['表格', 'a:tbl', '改单元格、加行、合并；表头行可重复'],
            ['图表', 'c:chart', '右键“编辑数据”，改的是内嵌工作簿'],
            ['图片', 'p:pic', '裁剪、换图；替换后仍是原生图片对象']
          ]
        },
        components.paragraph('以上五类都出现在本文件里；没有一类是整页图片。', {
          theme, x: margin + 0.04, y: 6.24, w: 11.2, h: 0.3,
          fontSize: theme.sizes.caption, color: theme.colors.muted
        })
      ]
    }
  ]
};

module.exports = deck;
