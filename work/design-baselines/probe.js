'use strict';

/**
 * 页面构图探针:12 种原型各一页,只用 JSON 流式规格(和站点生成的是同一条契约)
 *
 * 这份 deck 的用途是**设计验证**,不是产品:
 *   1. 证明站点可以交给模型的每一种构图,引擎都真的排得出来(不带 x/y,靠 columns 与 columnTracks);
 *   2. 给"视觉基准"提供一版人工确认过的参考排版;
 *   3. 站点的配方若被改成引擎排不出来的形状,这份 deck 会先红。
 *
 *   node pptx/native/cli.js work/design-baselines/probe.js work/design-baselines/probe.pptx \
 *        --strict --json --report work/design-baselines/report.json --layout-out work/design-baselines/layout.json
 *   python pptx/native/scripts/preview_deck.py work/design-baselines/probe.pptx --output-dir ... --sheet ...
 */

const { presets } = require('../../pptx/native/themes/presets');

// 预设只带色板/字号/行距;字体写真实系统字面,文字高度才是实测值而不是估算值
const theme = Object.assign({}, presets.sage, {
  fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei', numeric: 'Microsoft YaHei' },
});

const c = theme.colors;

/** 卡片:容器画自己的底 + 圆角 + 内边距,子元素竖直堆叠 */
function card(children, extra = {}) {
  return Object.assign({
    type: 'container',
    // `background: true` 才是"这张卡要画自己的底"的开关;只给 fill 什么都不会画
    background: true,
    fill: c.surface,
    lineColor: c.border,
    lineWidth: 0.75,
    radius: 0.14,
    padding: 0.28,
    gap: 0.1,
    // 浅底上的白卡只靠 1px 描边几乎看不出来:给一层极轻的阴影,卡片才"浮"起来
    shadow: { opacity: 0.14, blur: 1.2, distance: 0.06, angle: 90, color: '1E2B24' },
    children,
  }, extra);
}

function kicker(text) {
  return { type: 'text', text, fontSize: 10, bold: true, color: c.accent };
}

function title(text, size = 26) {
  return { type: 'text', role: 'title', text, fontSize: size, bold: true, color: c.foreground };
}

function body(text, size = 14, color = c.foreground) {
  return { type: 'text', text, fontSize: size, color };
}

function rule(color = c.border, h = 0.02) {
  return { type: 'shape', h, fill: color, line: false };
}

function metric(value, label, note) {
  return card([
    { type: 'text', text: value, fontSize: 30, bold: true, color: c.accent },
    { type: 'text', text: label, fontSize: 13, color: c.foreground },
    { type: 'text', text: note, fontSize: 10, color: c.muted },
  ]);
}

/** 一行读数:左边大数字,右边标签 + 注解(比"三个竖排卡片"矮得多) */
function row(value, label, note) {
  return {
    type: 'container',
    columns: 2,
    columnTracks: [{ fr: 1 }, { fr: 2.1 }],
    gap: 0.16,
    children: [
      { type: 'text', text: value, fontSize: 26, bold: true, color: c.accent },
      {
        type: 'container',
        gap: 0.02,
        children: [
          { type: 'text', text: label, fontSize: 13, color: c.foreground },
          { type: 'text', text: note, fontSize: 10, color: c.muted },
        ],
      },
    ],
  };
}

const deck = {
  title: '页面构图探针:站点的 12 种原型',
  language: 'zh-CN',
  pageSize: 'wide',
  theme,
  slides: [
    // 01 封面:垂直居中(startY),kicker → 大标题 → 强调细线 → 副题
    {
      template: 'cover',
      background: c.background,
      startY: 2.1,
      elements: [
        kicker('NATIVE DECK / COMPOSITION PROBE'),
        title('页面构图探针', 40),
        rule(c.accent, 0.05),
        body('12 种页面原型 · 只用流式规格 · 坐标由引擎算', 15, c.muted),
      ],
    },
    // 02 主张页:左文右数据(不对称两栏 columnTracks)
    {
      template: 'hero',
      background: c.background,
      elements: [
        kicker('核心主张'),
        title('把版式交给引擎,把判断留给模型', 32),
        {
          type: 'container',
          columns: 2,
          columnTracks: [{ fr: 1.5 }, { fr: 1 }],
          gap: 0.42,
          children: [
            {
              type: 'container',
              gap: 0.16,
              children: [
                body('同一份内容,能不能既讲清楚又好看,取决于两件事:版心有没有节奏,视觉焦点是否唯一。前者是几何,后者是取舍。', 15),
                rule(c.border),
                body('引擎负责几何:元素不写坐标,框高按实测文字算,越界与重叠在写盘前就被拒绝。', 13, c.muted),
              ],
            },
            card([
              kicker('三个数字'),
              row('12', '页面原型', '每种一套构图'),
              row('0', '手写坐标', '全部由布局计算'),
              row('100%', '可编辑', '没有整页截图'),
            ], { gap: 0.16 }),
          ],
        },
      ],
    },
    // 03 编辑式:导语 + 主栏 + 注栏(1.4 : 1)
    {
      template: 'editorial',
      background: c.background,
      elements: [
        kicker('INSIGHT / ANALYSIS'),
        title('留白不是没写完,是让焦点站住', 28),
        body('一句话能说清的事不要画三张卡。留白的职责是把读者的视线按顺序推到该看的地方。', 17, c.primary),
        rule(c.accent, 0.04),
        {
          type: 'container',
          columns: 2,
          columnTracks: [{ fr: 1.4 }, { fr: 1 }],
          gap: 0.4,
          children: [
            {
              type: 'container',
              gap: 0.14,
              children: [
                { type: 'text', role: 'heading', text: '论点', fontSize: 16, bold: true, color: c.primary },
                body('封面、章节、引语这三类页面天生"少字":它们的价值在于停顿,不在于信息量。把它们塞满卡片,节奏就没了。', 14),
                body('正文页相反:内容塌在上三分之一,读者会以为这一页没写完。', 14),
              ],
            },
            card([
              { type: 'text', role: 'heading', text: '注', fontSize: 14, bold: true, color: c.primary },
              body('判据来自实测:渲染后内容底边低于页面 62% 时,视觉上就是"半页纸"。', 12, c.muted),
              body('这条判据写在 review.ts 里,由像素度量触发,不靠模型自评。', 12, c.muted),
            ]),
          ],
        },
      ],
    },
    // 04 指标页:3 列网格,首卡跨 2 列(不等权重的节奏)
    {
      template: 'kpi',
      background: c.background,
      elements: [
        kicker('关键指标'),
        title('四个数字讲完这件事', 26),
        {
          type: 'container',
          columns: 3,
          gap: 0.22,
          rowGap: 0.22,
          children: [
            card([
              { type: 'text', text: '62%', fontSize: 40, bold: true, color: c.accent },
              { type: 'text', text: '内容是"补"出来的页', fontSize: 14, color: c.foreground },
              body('首轮生成里,内容只排到上半屏的页占比;补写后降到 8%。', 12, c.muted),
            ], { columnSpan: 2 }),
            metric('3.2s', '单页构建耗时', '25 页约 1 分钟'),
            metric('153', '引擎单测', '全部通过'),
            metric('34', '链路单测', '判据与合并规则'),
            metric('0', '截图页', '每页都是原生对象'),
          ],
        },
        body('口径:本机实测,25 页含 6 张配图。', 10, c.muted),
      ],
    },
    // 05 对比页:两栏同构 + 结论条
    {
      template: 'comparison',
      background: c.background,
      elements: [
        kicker('两种做法'),
        title('HTML 转 PPT 与原生生成,差别在后半程', 26),
        {
          type: 'container',
          columns: 2,
          gap: 0.26,
          children: [
            card([
              { type: 'text', role: 'heading', text: 'HTML → PPTX', fontSize: 16, bold: true, color: c.muted },
              body('设计自由度最高,但每个元素都要反推成形状;文字错位、字体替换、编辑困难是结构性的。', 14),
              body('交付物能看,不能改。', 13, c.muted),
            ]),
            card([
              { type: 'text', role: 'heading', text: '原生生成', fontSize: 16, bold: true, color: c.primary },
              body('输入是结构化的 Deck Spec:文字是 run,表格是 a:tbl,图表带内嵌工作簿。', 14),
              body('交付物能看,也能改。', 13, c.primary),
            ]),
          ],
        },
        card([body('结论:要让客户改得动,版式必须在第一步就是结构,而不是像素。', 13, c.foreground)], {
          fill: c.primary,
          lineColor: c.primary,
          padding: 0.22,
        }),
      ],
    },
    // 06 流程页:4 个步骤,序号是强调色
    {
      template: 'process',
      background: c.background,
      elements: [
        kicker('交付路径'),
        title('一条内容从选题到可交付 PPT 的四步', 26),
        {
          type: 'container',
          columns: 4,
          gap: 0.2,
          children: [
            card([
              { type: 'text', text: '01', fontSize: 22, bold: true, color: c.accent },
              { type: 'text', role: 'heading', text: '检索', fontSize: 14, bold: true, color: c.foreground },
              body('多角度检索,来源逐条留档。', 11, c.muted),
            ]),
            card([
              { type: 'text', text: '02', fontSize: 22, bold: true, color: c.accent },
              { type: 'text', role: 'heading', text: '规划', fontSize: 14, bold: true, color: c.foreground },
              body('只决定讲什么,与怎么讲分开。', 11, c.muted),
            ]),
            card([
              { type: 'text', text: '03', fontSize: 22, bold: true, color: c.accent },
              { type: 'text', role: 'heading', text: '成稿', fontSize: 14, bold: true, color: c.foreground },
              body('规格过引擎校验,一次写成 pptx。', 11, c.muted),
            ]),
            card([
              { type: 'text', text: '04', fontSize: 22, bold: true, color: c.accent },
              { type: 'text', role: 'heading', text: '复检', fontSize: 14, bold: true, color: c.foreground },
              body('渲染、逐页看、只改问题页。', 11, c.muted),
            ]),
          ],
        },
        body('每一步都能单独复现;失败信息带引擎原文。', 10, c.muted),
      ],
    },
    // 07 数据页:图表占 2 份,读图结论占 1 份
    {
      template: 'chart',
      background: c.background,
      elements: [
        kicker('趋势'),
        title('原生对象占比在四个季度内收敛到 100%', 26),
        {
          type: 'container',
          columns: 2,
          columnTracks: [{ fr: 2 }, { fr: 1 }],
          gap: 0.3,
          children: [
            {
              type: 'container',
              gap: 0.1,
              children: [
                {
                  type: 'chart',
                  chartType: 'bar',
                  h: 3.5,
                  data: [
                    { name: '原生对象', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [18, 34, 52, 69] },
                    { name: '栅格页面', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [12, 6, 2, 0] },
                  ],
                  options: { barDir: 'col', showLegend: true, chartColors: [c.primary, c.accent] },
                },
                body('数据来源:内部迁移记录,按季度统计页数。', 10, c.muted),
              ],
            },
            {
              type: 'container',
              gap: 0.12,
              children: [
                card([
                  { type: 'text', text: '69', fontSize: 24, bold: true, color: c.accent },
                  body('Q4 原生对象页数', 12, c.muted),
                ]),
                card([
                  { type: 'text', text: '0', fontSize: 24, bold: true, color: c.accent },
                  body('Q4 栅格页面数', 12, c.muted),
                ]),
                body('读图:两条序列在 Q4 交叉,之后不再有整页图片。', 12, c.foreground),
              ],
            },
          ],
        },
      ],
    },
    // 08 表格页:表 + 右侧读数(表要占主栏)
    {
      template: 'table',
      background: c.background,
      elements: [
        kicker('对照表'),
        title('四种对象在 PowerPoint 里能改什么', 26),
        {
          type: 'container',
          columns: 2,
          columnTracks: [{ fr: 2 }, { fr: 1 }],
          gap: 0.3,
          children: [
            {
              type: 'table',
              h: 3.4,
              options: { fontSize: 12, valign: 'middle' },
              rows: [
                [{ text: '对象', options: { bold: true } }, { text: 'OOXML', options: { bold: true } }, { text: '可编辑的程度', options: { bold: true } }],
                ['文本', 'a:r', '改字、改字距、改粗细'],
                ['形状', 'p:sp', '拖动、改填充与描边'],
                ['表格', 'a:tbl', '加行、合并、改单元格'],
                ['图表', 'c:chart', '右键编辑数据,改内嵌工作簿'],
              ],
            },
            {
              type: 'container',
              gap: 0.12,
              children: [
                { type: 'text', role: 'heading', text: '读数', fontSize: 14, bold: true, color: c.primary },
                body('四类对象各自对应 OOXML 里的一种节点:能改什么,取决于它写成了哪一种。', 12),
                body('整页图片不在表里 —— 它没有可编辑的结构。', 12, c.muted),
              ],
            },
          ],
        },
      ],
    },
    // 09 配图页:图在左、文在右(不对称两栏)
    {
      template: 'image',
      background: c.background,
      elements: [
        kicker('配图不是装饰'),
        title('图片承担叙事时,文字只需要一句', 26),
        {
          type: 'container',
          columns: 2,
          columnTracks: [{ fr: 1.15 }, { fr: 1 }],
          gap: 0.36,
          children: [
            {
              type: 'image',
              path: '../../pptx/examples/assets/tea/longjing-dry.jpg',
              h: 4.1,
              fit: 'cover',
              radius: 0.12,
              altText: '示例配图',
              credit: { subject: '示例配图', author: 'probe', licence: 'CC0' },
            },
            {
              type: 'container',
              gap: 0.14,
              children: [
                body('一页只留一个视觉焦点。图片不是填空:它与本页结论无关时,宁可换成数据或对照。', 14),
                rule(c.border),
                body('署名:作者 / 许可。缺署名的图片 schema 直接拒。', 11, c.muted),
              ],
            },
          ],
        },
      ],
    },
    // 10 要点网格:不等权重 bento(2 列 + 2 列 + 2 列的三行节奏)
    {
      template: 'bento',
      background: c.background,
      elements: [
        kicker('要点'),
        title('三种页面各自的分工', 26),
        {
          type: 'container',
          columns: 3,
          gap: 0.22,
          rowGap: 0.22,
          children: [
            card([
              { type: 'text', role: 'heading', text: '停顿页', fontSize: 17, bold: true, color: c.primary },
              body('封面 / 章节 / 引语:只留一句话,居中,四周大留白。', 13),
            ], { columnSpan: 2 }),
            card([
              { type: 'text', role: 'heading', text: '论证页', fontSize: 15, bold: true, color: c.primary },
              body('一个结论 + 两三条证据。', 12),
            ]),
            card([
              { type: 'text', role: 'heading', text: '数据页', fontSize: 15, bold: true, color: c.primary },
              body('图占主栏,读图结论占次栏。', 12),
            ]),
            card([
              { type: 'text', role: 'heading', text: '对照页', fontSize: 15, bold: true, color: c.primary },
              body('同一根轴上的两项,最后给结论。', 12),
            ]),
            card([
              { type: 'text', role: 'heading', text: '图文页', fontSize: 15, bold: true, color: c.primary },
              body('图片负责情绪,文字负责事实。', 12),
            ]),
          ],
        },
      ],
    },
    // 11 引语页:大字 + 出处(深底)
    {
      template: 'quote',
      background: c.primary,
      startY: 2.2,
      elements: [
        { type: 'text', role: 'title', text: '结论先行', fontSize: 18, bold: true, color: c.accent },
        { type: 'text', text: '「先把结构写进规格,再让引擎算坐标。」', fontSize: 30, bold: true, color: c.background },
        { type: 'shape', h: 0.04, w: 2.2, fill: c.accent, line: false },
        { type: 'text', text: '— 原生引擎设计笔记', fontSize: 11, color: c.border },
      ],
    },
    // 12 收束页:深底 + 三条行动项
    {
      template: 'section',
      background: c.primary,
      elements: [
        { type: 'text', text: 'CHAPTER 04', fontSize: 11, bold: true, color: c.accent },
        { type: 'text', role: 'title', text: '下一步:把复检变成交付的一部分', fontSize: 28, bold: true, color: c.background },
        { type: 'shape', h: 0.04, w: 1.6, fill: c.accent, line: false },
        {
          type: 'container',
          columns: 3,
          gap: 0.24,
          children: [
            {
              type: 'container',
              gap: 0.08,
              children: [
                { type: 'text', text: '①', fontSize: 18, bold: true, color: c.accent },
                { type: 'text', text: '渲染每一份成品,存证逐页 PNG。', fontSize: 13, color: c.background },
              ],
            },
            {
              type: 'container',
              gap: 0.08,
              children: [
                { type: 'text', text: '②', fontSize: 18, bold: true, color: c.accent },
                { type: 'text', text: '几何与像素判据分开记录,不互相冒充。', fontSize: 13, color: c.background },
              ],
            },
            {
              type: 'container',
              gap: 0.08,
              children: [
                { type: 'text', text: '③', fontSize: 18, bold: true, color: c.accent },
                { type: 'text', text: '只改问题页,改动范围可验证。', fontSize: 13, color: c.background },
              ],
            },
          ],
        },
      ],
    },
  ],
};

module.exports = deck;


