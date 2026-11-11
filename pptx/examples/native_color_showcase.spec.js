'use strict';

/**
 * What a deck looks like when the design system is allowed to use colour.
 *
 * The engine used to ship one pale theme, `templates.content()` painted pages with the *card* colour,
 * and no template wrote a colour field - so a deck came out as white pages with white cards on them.
 * This deck is the counter-example: one preset ('sand'), colour-field dividers, tinted panels, accent
 * numbers, and themed chart series. Six pages, no white page, and not one gradient or image needed to
 * get there.
 */

const { preset } = require('../native/themes/presets');
const templates = require('../native/templates');
const components = require('../native/components');

// A colour preset says nothing about type; the deck says what it can render.
const theme = preset('sand', {
  fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei', cjk: 'Microsoft YaHei' }
});

function cover() {
  return templates.cover({
    theme,
    title: '色彩不需要图片也能成立',
    subtitle: '一份 deck 的底色、色块与强调色 · 原生生成 · 全部可编辑',
    // A colour field instead of a page: the title takes the theme's background colour, which a preset
    // guarantees to be legible on the primary field.
    background: theme.colors.primary,
    titleColor: theme.colors.background,
    subtitleColor: theme.colors.background,
    accent: theme.colors.accent,
    titleSize: 38
  });
}

function tintedPanel() {
  const marginX = theme.layouts.pageMarginX;
  // Hand-composed rather than `templates.content()`, because that template's body box spans the page
  // and this page puts two cards beside it.
  return {
    background: theme.colors.background,
    elements: [
      components.title('内容页也不该是一片白', {
        theme, x: marginX, y: 0.52, w: 6.2, h: 0.62, fontSize: theme.sizes.title
      }),
      components.divider({ theme, x: marginX + 0.02, y: 1.24, w: 5.9 }),
      components.paragraph('页面用主题底色，卡片用 surface —— 两者必须看得出差别，卡片才像卡片。', {
        theme, x: marginX + 0.04, y: 1.62, w: 5.85, h: 1.1, fontSize: theme.sizes.body + 1
      }),
      components.paragraph('这一页的卡片、标题、正文、标尺全部来自同一个主题，没有一处手写色值。', {
        theme, x: marginX + 0.04, y: 2.86, w: 5.85, h: 1.1, fontSize: theme.sizes.body, color: theme.colors.muted
      }),
      ...components.infoCard({
        theme,
        title: '色板怎么定',
        body: '底色带一点纸感，标题用深墨，强调色只给数字和标尺。三个颜色就够，多了会乱。',
        x: 7.05, y: 1.62, w: 5.55, h: 2.34
      }),
      ...components.kpiCard({
        theme,
        label: '强调色占比',
        value: '12%',
        note: '只用在数字、标尺和一处强调',
        x: 7.05, y: 4.2, w: 5.55, h: 1.6,
        color: theme.colors.accent,
        valueSize: 34
      })
    ]
  };
}

function divider() {
  return templates.section({
    theme,
    kicker: '01 结构',
    title: '章节扉页就该是一整块颜色',
    subtitle: '这一页没有任何图片，只有底色、标题和一根标尺。'
  });
}

function kpiRow() {
  return templates.kpi({
    theme,
    title: '数字用强调色，标题用深墨',
    items: [
      { label: '主色页面', value: '3', note: '封面、两处扉页', color: theme.colors.accent },
      { label: '卡片', value: '11', note: '全部使用 surface', color: theme.colors.accent },
      { label: '手写色值', value: '0', note: '全部来自主题令牌', color: theme.colors.accent }
    ]
  });
}

function chartPage() {
  const marginX = theme.layouts.pageMarginX;
  return {
    background: theme.colors.background,
    elements: [
      components.title('图表自带主题色', {
        theme, x: marginX, y: 0.52, w: 11.9, h: 0.62, fontSize: theme.sizes.title
      }),
      components.divider({ theme, x: marginX + 0.02, y: 1.24, w: 11.85 }),
      // The panel is what makes a chart sit on a page instead of floating in it.
      {
        type: 'shape', x: marginX, y: 1.62, w: 7.4, h: 4.1, radius: theme.radii.medium,
        fill: theme.colors.surface, lineColor: theme.colors.border, lineWidth: 0.8
      },
      {
        type: 'chart',
        chartType: 'bar',
        x: marginX + 0.32,
        y: 1.88,
        w: 6.76,
        h: 3.58,
        data: [{ name: '页面类型', labels: ['纯色页', '卡片页', '图文页'], values: [3, 11, 2] }],
        showLegend: false,
        showValue: true,
        fontSize: 11
      },
      components.paragraph('系列颜色取自 theme.colors.primary 与 accent，图表不会自己跳出一套和页面无关的配色。', {
        theme, x: 8.3, y: 1.9, w: 4.4, h: 1.6, fontSize: theme.sizes.body
      }),
      components.paragraph('强调色只给数字和标尺，正文保持中性，读者才知道先看哪里。', {
        theme, x: 8.3, y: 3.7, w: 4.4, h: 1.4, fontSize: theme.sizes.body, color: theme.colors.muted
      })
    ]
  };
}

function closing() {
  return templates.section({
    theme,
    kicker: '02 收尾',
    title: '收尾页同样是一块颜色',
    subtitle: '一份 deck 的节奏是：颜色 → 内容 → 颜色。'
  });
}

module.exports = {
  title: 'colour showcase',
  language: 'zh-CN',
  pageSize: 'wide',
  theme,
  slides: [cover(), tintedPanel(), divider(), kpiRow(), chartPage(), closing()]
};
