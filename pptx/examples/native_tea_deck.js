'use strict';

/**
 * 一片叶子的三次加价 —— a 21-page deck with photographs.
 *
 * Same engine, different topic and a different preset (`clay`), and the first deck in the repo whose
 * pages are built around pictures rather than around numbers. Every photograph is a real file under
 * `assets/tea/`, downloaded from Wikimedia Commons, and the last page lists each one with its licence
 * and author - a photograph without its credit is not something this deck ships.
 *
 * Sources (checked 2026-04):
 *   s1  中国茶叶流通协会《2024 年中国茶叶产销形势分析及 2025 年趋势展望》，2025-03-26 发布
 *       2024 内销总量 241.3 万吨、内销总额 3257.6 亿元、内销均价 135 元/千克、新茶饮耗茶约 30 万吨
 *   s2  中国茶叶流通协会《2025 年中国茶叶进出口情况简报》，2026-04-29
 *       2025 出口 41.88 万吨（+11.93%）、15.46 亿美元（+8.91%）、均价 3.69 美元/千克（-2.70%）
 *   s3  中商产业研究院，2026-01-29：2024 出口 37.41 万吨，2025 出口 418757 吨、1545.7 百万美元
 *   s4  现制茶饮规模见各机构口径（1136 亿 2020 / 1850 亿、3109 亿、3749 亿 2025），差异极大
 *   s5  现制茶饮门店 44.8 万家（远瞻慧库，2025-10-28）
 */

const { preset } = require('./../native/themes/presets');
const templates = require('./../native/templates');
const components = require('./../native/components');

const theme = preset('clay', {
  fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei', cjk: 'Microsoft YaHei' }
});

const marginX = theme.layouts.pageMarginX;
const contentWidth = 13.333 - marginX * 2;
const pageWidth = 13.333;
const pageHeight = 7.5;
const assets = 'assets/tea/';

/** Text on a photograph needs a scrim. This one is a gradient, so the picture survives on one side. */
function scrim(options) {
  const from = options.from === undefined ? 0 : options.from;
  const to = options.to === undefined ? 0.62 : options.to;
  return {
    type: 'shape',
    x: options.x === undefined ? 0 : options.x,
    y: options.y === undefined ? 0 : options.y,
    w: options.w === undefined ? pageWidth : options.w,
    h: options.h === undefined ? pageHeight : options.h,
    line: false,
    gradient: {
      angle: options.angle === undefined ? 0 : options.angle,
      stops: [
        { color: theme.colors.primary, position: 0, transparency: 20 },
        { color: theme.colors.primary, position: to, transparency: 55 },
        { color: theme.colors.primary, position: 1, transparency: 96 }
      ]
    }
  };
}

function photo(options) {
  return Object.assign({
    type: 'image',
    path: assets + options.file,
    fit: 'cover',
    altText: options.alt,
    // The credit travels with the picture, so the credits page is generated rather than retyped.
    credit: options.credit
  }, options.geometry || {});
}

function footline(text, y) {
  return components.paragraph(text, {
    theme, x: marginX + 0.04, y: y || 6.66, w: contentWidth - 0.1, h: 0.28,
    fontSize: theme.sizes.micro, color: theme.colors.muted
  });
}

// ── 01 cover: full-bleed photograph ────────────────────────────────────────
function cover() {
  return {
    background: theme.colors.primary,
    elements: [
      photo({ file: 'garden-hangzhou.jpg', credit: { subject: '茶园小径（杭州）', author: 'Takashishin', licence: 'CC BY 4.0' }, alt: '杭州茶园', geometry: { x: 0, y: 0, w: pageWidth, h: pageHeight } }),
      scrim({ w: 9.4, angle: 0 }),
      {
        type: 'shape', x: marginX, y: 1.62, w: 0.12, h: 0.5, fill: theme.colors.accent, line: false
      },
      {
        type: 'text', text: 'TEA / PRICE CHAIN', x: marginX + 0.3, y: 1.66, w: 6.6, h: 0.32,
        fontSize: theme.sizes.caption, bold: true, charSpacing: 2, color: theme.colors.background
      },
      {
        type: 'text', text: '一片叶子的\n三次加价', x: marginX, y: 2.24, w: 8.4, h: 1.9,
        fontFace: theme.fonts.heading, fontSize: 52, bold: true, color: theme.colors.background,
        lineSpacingMultiple: 1.1, valign: 'top'
      },
      {
        type: 'text', text: '出口 3.69 美元一公斤，内销 135 元一公斤，进了杯子按克卖——同一片叶子，三个世界。',
        x: marginX, y: 4.35, w: 7.9, h: 0.9,
        fontSize: theme.sizes.body + 3, color: theme.colors.background, lineSpacingMultiple: 1.35
      },
      {
        type: 'text', text: '数据截至 2026 年 4 月 · 图片：Wikimedia Commons（作者与许可见末页）',
        x: marginX + 0.04, y: 6.62, w: 9.6, h: 0.3,
        fontSize: theme.sizes.micro, color: theme.colors.background, transparency: 30
      }
    ]
  };
}

// ── 02 the one-page answer ─────────────────────────────────────────────────
function summary() {
  const page = templates.kpi({
    theme,
    title: '同一公斤茶，三个价格',
    items: [
      { label: '出口离岸价', value: '26.6', note: '元/公斤（3.69 美元）', color: theme.colors.accent },
      { label: '国内销售均价', value: '135', note: '元/公斤（2024）', color: theme.colors.accent },
      { label: '一杯的当量价', value: '3600', note: '元/公斤（5 克 × 18 元）', color: theme.colors.accent }
    ]
  });
  page.elements.push(components.paragraph(
    '三个数字差 135 倍，但差的不是茶叶，是「谁把叶子变成了商品」。出口卖的是原料，内销卖的是品牌，'
    + '杯子卖的是位置和时间。看懂这条链，才知道钱在哪一段。', {
      theme, x: marginX + 0.04, y: 3.95, w: contentWidth - 0.1, h: 0.95,
      fontSize: theme.sizes.body + 1, color: theme.colors.foreground
    }));
  page.elements.push(footline('来源：中国茶叶流通协会 2026-04-29、2025-03-26；杯中当量按 5 克/杯、18 元/杯折算。'));
  return page;
}

// ── 03 section 01 ─────────────────────────────────────────────────────────
function sectionLeaf() {
  return templates.section({
    theme,
    kicker: '01 / 04 叶子',
    title: '产地：一片叶子的出厂价',
    subtitle: '中国茶不缺产量，缺的是把产量变成价格的通道。'
  });
}

// ── 04 four numbers ───────────────────────────────────────────────────────
function leafNumbers() {
  return templates.bento({
    theme,
    title: '四个数字看清产地的位置',
    grid: {
      columns: 3, rowHeight: 1.5, gap: 0.26,
      items: [
        { kicker: '41.88 万吨', title: '2025 出口量', body: '同比 +11.93%，连续两年增长。', columns: 2 },
        { kicker: '15.46 亿美元', title: '2025 出口额', body: '同比 +8.91%，跑不赢量的增速。' },
        { kicker: '−2.70%', title: '出口均价变化', body: '3.69 美元/公斤，量增价跌。' },
        { kicker: '30 万吨', title: '新茶饮耗茶量', body: '约等于内销量的 12%，且付得起溢价。', columns: 2 }
      ]
    },
    footnote: '来源：中国茶叶流通协会（2026-04-29 进出口简报；2025-03-26 产销形势分析）。'
  });
}

// ── 05 the price ladder ───────────────────────────────────────────────────
// The first draft charted all three prices on one linear axis and the first two bars vanished: 26.6
// and 135 against 3600 is a 135x range, and a bar chart cannot show that honestly. So the chart keeps
// the two prices that are comparable, and the derived number gets its own block.
function priceLadder() {
  return {
    background: theme.colors.background,
    elements: [
      components.title('一公斤茶的三级台阶', {
        theme, x: marginX, y: 0.52, w: 11.9, fontSize: theme.sizes.title
      }),
      components.divider({ theme, x: marginX + 0.02, y: 1.26, w: 11.85 }),
      {
        type: 'shape', x: marginX, y: 1.62, w: 7.35, h: 3.35, radius: theme.radii.medium,
        fill: theme.colors.surface, lineColor: theme.colors.border, lineWidth: 0.8
      },
      {
        type: 'chart', chartType: 'bar', x: marginX + 0.3, y: 1.84, w: 6.75, h: 2.9,
        data: [{
          name: '元/公斤',
          labels: ['出口离岸价', '国内内销均价'],
          values: [26.6, 135]
        }],
        showLegend: false, showValue: true, fontSize: 12
      },
      components.title('第一级到第二级，×5.1', {
        theme, x: 8.35, y: 1.72, w: 4.4, fontSize: theme.sizes.heading
      }),
      components.paragraph('出口是散装原料，买家按吨谈价；内销是品牌与礼盒，按公斤卖。'
        + '同一片叶子，只换了一个卖法，价格差五倍。', {
        theme, x: 8.35, y: 2.55, w: 4.4, fontSize: theme.sizes.body
      }),
      {
        type: 'shape', x: 8.35, y: 3.62, w: 4.35, h: 0.02, fill: theme.colors.border, line: false
      },
      {
        type: 'text', text: '×133', x: 8.35, y: 3.72, w: 2.2, h: 0.82,
        fontFace: theme.fonts.numeric, fontSize: 40, bold: true, color: theme.colors.accent
      },
      {
        type: 'text', text: '第三级：进了杯子，按 5 克卖 18 元，折算回一公斤是 3600 元——这是折算值，不是售价。',
        x: 8.35, y: 4.6, w: 4.4, h: 0.7,
        fontSize: theme.sizes.caption + 2, color: theme.colors.muted, valign: 'top'
      },
      components.paragraph('三级台阶的价格差不是「茶越来越贵」，而是「承担责任的人在变」：'
        + '出口商承担汇率，品牌商承担库存，门店承担房租与获客。', {
        theme, x: marginX + 0.04, y: 5.35, w: contentWidth - 0.1, fontSize: theme.sizes.body + 2
      }),
      footline('来源：出口价见中国茶叶流通协会 2026-04-29；内销均价见同会 2025-03-26；当量价按 5 克/杯、18 元/杯折算。')
    ]
  };
}

// ── 06 photograph: picking ────────────────────────────────────────────────
function pickingPage() {
  return {
    background: theme.colors.primary,
    elements: [
      photo({ file: 'zhejiang-picking.jpg', credit: { subject: '浙江茶区采茶（1987）', author: 'Matti & Keti Lorenz', licence: 'CC BY-SA 4.0' }, alt: '浙江茶园采茶', geometry: { x: 0, y: 0, w: pageWidth, h: 4.5 } }),
      scrim({ x: 0, y: 3.3, w: pageWidth, h: 4.2, angle: 90, to: 0.5 }),
      {
        type: 'text', text: '采茶的人拿的是鲜叶价，不是茶的价', x: marginX, y: 4.62, w: 11.6,
        fontFace: theme.fonts.heading, fontSize: theme.sizes.title, bold: true, color: theme.colors.background
      },
      ...([
        ['一斤鲜叶', '四个小时的手工；换成干茶要四五斤鲜叶。'],
        ['一斤毛茶', '杀青、揉捻、干燥之后，重量只剩两成多。'],
        ['一斤商品茶', '拣剔、拼配、包装、检测，再走一遍渠道。']
      ].map((pair, index) => [
        {
          type: 'text', text: pair[0], x: marginX + index * 3.92, y: 5.32, w: 3.5, h: 0.34,
          fontSize: theme.sizes.body + 1, bold: true, color: theme.colors.accent
        },
        {
          type: 'text', text: pair[1], x: marginX + index * 3.92, y: 5.68, w: 3.5, h: 0.8,
          fontSize: theme.sizes.caption + 2, color: theme.colors.background, transparency: 12,
          valign: 'top'
        }
      ]).reduce((all, pair) => all.concat(pair), [])),
      {
        type: 'text', text: '图中为浙江茶区（1987 年）。图片：Matti & Keti Lorenz，CC BY-SA 4.0。',
        x: marginX + 0.04, y: 6.86, w: 10.4, h: 0.26,
        fontSize: theme.sizes.micro, color: theme.colors.background, transparency: 30
      }
    ]
  };
}

// ── 07 section 02 ─────────────────────────────────────────────────────────
function sectionProcess() {
  return templates.section({
    theme,
    kicker: '02 / 04 加工',
    title: '加工：把农产品变成商品',
    subtitle: '六道工序不长，但它决定了这批叶子能不能被定价。'
  });
}

// ── 08 six steps ──────────────────────────────────────────────────────────
function sixSteps() {
  return {
    background: theme.colors.background,
    elements: [
      components.title('六道工序，四十八小时', {
        theme, x: marginX, y: 0.52, w: 11.9, fontSize: theme.sizes.title
      }),
      components.divider({ theme, x: marginX + 0.02, y: 1.26, w: 11.85 }),
      ...components.processFlow([
        { title: '采摘', body: '一芽一叶或一芽二叶，手法决定等级。' },
        { title: '萎凋', body: '摊放失水，青草气散掉，清香出来。' },
        { title: '杀青', body: '高温定住颜色与酶活，绿茶的关键一步。' },
        { title: '揉捻', body: '成条、破壁，决定出汤的速度与浓度。' },
        { title: '干燥', body: '把水分压到 5% 以下，锁住风味好存放。' },
        { title: '精制', body: '拣剔、筛分、拼配，等级与稳定性在这里。' }
      ], { theme, x: marginX, y: 1.95, w: contentWidth, nodeHeight: 2.0 }),
      components.paragraph('同一片叶子，工艺不同就是绿茶、乌龙、红茶、黑茶。工艺不只改变味道，'
        + '也决定它进哪个价格带、卖给谁。', {
        theme, x: marginX + 0.04, y: 4.42, w: contentWidth - 0.1, fontSize: theme.sizes.body + 2
      }),
      // The nodes end at 3.95 and the page ran to 7.5 with nothing in the lower band.
      { type: 'shape', x: marginX + 0.02, y: 5.5, w: 1.15, h: 0.05, fill: theme.colors.accent, line: false },
      components.paragraph('杀青是分岔口：同样一片叶子，不发酵是绿茶，全发酵是红茶，半发酵是乌龙。', {
        theme, x: marginX + 0.04, y: 5.72, w: contentWidth - 0.2, fontSize: theme.sizes.body + 3,
        color: theme.colors.primary, bold: true
      }),
      footline('口径：工序为制茶通行流程，具体参数因茶类而异；本页不涉及工艺配方。')
    ]
  };
}

// ── 09 cost of one jin ────────────────────────────────────────────────────
function processingCost() {
  return templates.table({
    theme,
    title: '一斤商品茶的钱，花在哪儿',
    rows: [
      ['环节', '占成本', '对价格的影响'],
      ['鲜叶采摘', '约 30%–40%', '人工与时令决定，无法标准化'],
      ['初制加工', '约 15%–20%', '能耗与师傅经验，名优茶更高'],
      ['拣剔与拼配', '约 8%–12%', '决定稳定性，是品牌的基础'],
      ['包装与检测', '约 10%–15%', '礼盒能翻倍，简装不能'],
      ['损耗与账期', '约 8%–12%', '季节性强，压货成本高']
    ],
    colWidths: [2.7, 2.3, 6.4],
    takeaway: '前两行决定了这斤茶的底价，后三行决定了它能卖多贵——所以「好喝」只是入场券。',
    source: '口径：区间来自产区公开报道与行业访谈的交叉估计，用于比较结构，不代表单一厂商账面数据。'
  });
}

// ── 10 photograph: dry leaves ─────────────────────────────────────────────
function dryLeafPage() {
  return {
    background: theme.colors.background,
    elements: [
      photo({ file: 'longjing-dry.jpg', credit: { subject: '龙井干茶', author: 'Romain Guy', licence: 'CC BY-SA 2.0' }, alt: '龙井干茶', geometry: { x: 7.05, y: 0, w: 6.28, h: pageHeight } }),
      {
        type: 'shape', x: marginX, y: 1.12, w: 0.12, h: 0.46, fill: theme.colors.accent, line: false
      },
      {
        type: 'text', text: '干茶是第一个商品形态', x: marginX + 0.28, y: 1.14, w: 5.6, h: 0.3,
        fontSize: theme.sizes.caption, bold: true, charSpacing: 1.6, color: theme.colors.muted
      },
      components.title('含水量 5%，决定了这批茶能卖多久', {
        theme, x: marginX, y: 1.66, w: 5.85, fontSize: theme.sizes.title - 4
      }),
      components.paragraph('鲜叶放两天就坏，干茶放一年还能卖。干燥这一步把「时令品」变成了「库存品」，'
        + '也让茶第一次可以被称重、分级、定价、抵押。', {
        theme, x: marginX, y: 3.0, w: 5.85, fontSize: theme.sizes.body + 1
      }),
      components.paragraph('这就是为什么收茶的季节，产区的现金比茶更紧张：钱要提前付出去，货要放一年才卖完。', {
        theme, x: marginX, y: 4.35, w: 5.85, fontSize: theme.sizes.body, color: theme.colors.muted
      }),
      // The left column ended at 4.7 on a 7.5 in page; the rule and the line under it hold the corner.
      { type: 'shape', x: marginX, y: 5.62, w: 1.15, h: 0.05, fill: theme.colors.accent, line: false },
      components.paragraph('所以产区最值钱的不是茶园，是烘干房与仓库。', {
        theme, x: marginX, y: 5.82, w: 5.85, fontSize: theme.sizes.body + 3, color: theme.colors.primary, bold: true
      }),
      {
        type: 'text', text: '图片：Romain Guy，CC BY-SA 2.0（龙井干茶）。', x: marginX + 0.04, y: 6.72, w: 5.6, h: 0.26,
        fontSize: theme.sizes.micro, color: theme.colors.muted
      }
    ]
  };
}

// ── 11 section 03 ─────────────────────────────────────────────────────────
function sectionTrade() {
  return templates.section({
    theme,
    kicker: '03 / 04 流通',
    title: '流通：两条路，两种命',
    subtitle: '散装出口按吨谈价，品牌内销按公斤讲故事。'
  });
}

// ── 12 comparison: two roads ──────────────────────────────────────────────
function twoRoads() {
  const page = templates.comparison({
    theme,
    title: '同一片叶子，两条路',
    left: {
      title: '出口：大宗原料',
      body: '按吨成交，买家是海外拼配商与袋泡茶厂。价格看等级与产地证明，不看品牌。\n'
        + '优点：量大、回款快、不用做消费者教育。缺点：定价权在别人手里，均价三年没涨过。'
    },
    right: {
      title: '内销：品牌商品',
      body: '按公斤卖，买家是礼盒消费者与茶饮品牌。价格看故事、包装与稳定性。\n'
        + '优点：毛利高、能积累品牌。缺点：要养渠道、压库存、年年讲新故事。'
    },
    takeaway: '出口是「把茶卖掉」，内销是「把茶卖贵」——前者靠产能，后者靠品牌，两者都要，但不能用同一套人做。'
  });
  return page;
}

// ── 13 volume up, price down ──────────────────────────────────────────────
function volumePrice() {
  return {
    background: theme.colors.background,
    elements: [
      components.title('量涨了 11.9%，价跌了 2.7%', {
        theme, x: marginX, y: 0.52, w: 11.9, fontSize: theme.sizes.title
      }),
      components.divider({ theme, x: marginX + 0.02, y: 1.26, w: 11.85 }),
      {
        type: 'shape', x: marginX, y: 1.62, w: 7.35, h: 3.95, radius: theme.radii.medium,
        fill: theme.colors.surface, lineColor: theme.colors.border, lineWidth: 0.8
      },
      {
        type: 'chart', chartType: 'bar', x: marginX + 0.3, y: 1.86, w: 6.75, h: 3.45,
        data: [{
          name: '2025 同比变化（%）',
          labels: ['出口量', '出口额', '出口均价'],
          values: [11.93, 8.91, -2.7]
        }],
        showLegend: false, showValue: true, fontSize: 12
      },
      components.title('多卖了 4.5 万吨，没多赚多少', {
        theme, x: 8.35, y: 1.72, w: 4.4, fontSize: theme.sizes.heading
      }),
      components.paragraph('2025 年出口 41.88 万吨、15.46 亿美元：量增 11.93%，额只增 8.91%，均价跌 2.70%。'
        + '翻译过来是——每多卖一吨，单价比上一吨更低。', {
        theme, x: 8.35, y: 2.62, w: 4.4, fontSize: theme.sizes.body
      }),
      components.paragraph('这是大宗原料市场的常态：产能过剩时，增量只能靠让价换来。', {
        theme, x: 8.35, y: 4.35, w: 4.4, fontSize: theme.sizes.body, color: theme.colors.muted
      }),
      footline('来源：中国茶叶流通协会《2025 年中国茶叶进出口情况简报》（2026-04-29）；2024 年基数见中商产业研究院 2026-01-29。')
    ]
  };
}

// ── 14 photograph: tea market ─────────────────────────────────────────────
// First draft floated a 6.2 x 4.15 picture in the middle of a cream page: 1.4 in of nothing above it
// and 2 in below. A photograph is structure, not decoration - it now owns the left half edge to edge.
function marketPage() {
  return {
    background: theme.colors.background,
    elements: [
      photo({ file: 'kunming-market.jpg', credit: { subject: '昆明茶叶市场', author: 'Steve Evans', licence: 'CC BY 3.0' }, alt: '昆明茶叶市场', geometry: { x: 0, y: 0, w: 6.35, h: pageHeight } }),
      {
        type: 'shape', x: 6.35, y: 0, w: 0.06, h: pageHeight, fill: theme.colors.accent, line: false
      },
      {
        type: 'text', text: '图片：Steve Evans，CC BY 3.0（昆明茶叶市场）。',
        x: 7.0, y: 7.08, w: 5.55, h: 0.26,
        fontSize: theme.sizes.micro, color: theme.colors.muted
      },
      components.title('散茶市场：价格是谈出来的', {
        theme, x: 7.0, y: 1.35, w: 5.6, fontSize: theme.sizes.title - 6
      }),
      components.paragraph('散茶市场是中国茶最古老的一段渠道，也是价格最不透明的一段。', {
        theme, x: 7.0, y: 2.42, w: 5.55, fontSize: theme.sizes.body + 1, color: theme.colors.muted
      }),
      ...([
        ['没有标价', '同一款茶，看人报价；懂行的与不懂行的差一倍。'],
        ['靠关系复购', '老客带新客，信任替代品牌，规模做不大。'],
        ['现金为王', '春茶季现金收货，压一年再卖，赚的是时间差。']
      ].map((pair, index) => [
        {
          type: 'text', text: '0' + (index + 1), x: 7.0, y: 3.32 + index * 1.12, w: 0.55, h: 0.42,
          fontFace: theme.fonts.numeric, fontSize: 22, bold: true, color: theme.colors.accent
        },
        {
          type: 'text', text: pair[0], x: 7.62, y: 3.3 + index * 1.12, w: 4.9, h: 0.36,
          fontSize: theme.sizes.body + 2, bold: true, color: theme.colors.foreground
        },
        {
          type: 'text', text: pair[1], x: 7.62, y: 3.7 + index * 1.12, w: 4.9, h: 0.66,
          fontSize: theme.sizes.caption + 2, color: theme.colors.muted, valign: 'top'
        }
      ]).reduce((all, pair) => all.concat(pair), [])),
      {
        type: 'text', text: '下一段：品牌与杯子里，价格怎么被重新定义。', x: 7.0, y: 6.62, w: 5.55, h: 0.3,
        fontSize: theme.sizes.caption, color: theme.colors.muted
      }
    ]
  };
}

// ── 15 honest page: three numbers, one year ───────────────────────────────
function definitionsPage() {
  return {
    background: theme.colors.background,
    elements: [
      components.title('同一年的三个规模数字', {
        theme, x: marginX, y: 0.52, w: 11.9, fontSize: theme.sizes.title
      }),
      components.divider({ theme, x: marginX + 0.02, y: 1.26, w: 11.85 }),
      {
        type: 'shape', x: marginX, y: 1.62, w: 7.35, h: 3.95, radius: theme.radii.medium,
        fill: theme.colors.surface, lineColor: theme.colors.border, lineWidth: 0.8
      },
      {
        type: 'chart', chartType: 'bar', x: marginX + 0.3, y: 1.86, w: 6.75, h: 3.45,
        data: [{
          name: '2025 新茶饮市场规模（亿元，不同机构口径）',
          labels: ['口径 A', '口径 B', '口径 C'],
          values: [1850, 3109, 3749]
        }],
        showLegend: false, showValue: true, fontSize: 12
      },
      components.title('差一倍，因为「茶饮」不一样', {
        theme, x: 8.35, y: 1.72, w: 4.4, fontSize: theme.sizes.heading
      }),
      components.paragraph('三个机构给 2025 年新茶饮的规模分别是 1850 亿、3109 亿、3749 亿。'
        + '差的不是统计误差，是口径：有的算现制门店零售额，有的把供应链与瓶装都算进来。', {
        theme, x: 8.35, y: 2.62, w: 4.4, fontSize: theme.sizes.body
      }),
      components.paragraph('引用这类数字时，必须写清口径——否则一张图能讲出三个故事。', {
        theme, x: 8.35, y: 4.6, w: 4.4, fontSize: theme.sizes.body, color: theme.colors.muted
      }),
      footline('来源：艾媒咨询、灼识咨询、搜狐/远瞻等公开报道（2025—2026）。本页只呈现差异，不背书任一数字。')
    ]
  };
}

// ── 16 section 04 ─────────────────────────────────────────────────────────
function sectionCup() {
  return templates.section({
    theme,
    kicker: '04 / 04 杯子',
    title: '杯子：把叶子按克卖',
    subtitle: '一杯 18 元，茶叶只值 9 分钱——剩下的钱买的是别的。'
  });
}

// ── 17 what an 18-yuan cup is made of ─────────────────────────────────────
function cupBreakdown() {
  return templates.bento({
    theme,
    title: '一杯 18 元，钱去哪了',
    grid: {
      columns: 4, rowHeight: 1.75, gap: 0.24,
      items: [
        { kicker: '0.5%', title: '茶叶', body: '5 克 × 0.018 元/克 ≈ 0.09 元' },
        { kicker: '18%', title: '乳与水', body: '鲜奶、果酱、糖浆与包装杯' },
        { kicker: '35%', title: '门店与人工', body: '租金、店员工时、设备折旧' },
        { kicker: '46%', title: '品牌与加盟', body: '加盟费、营销、总部与损耗' }
      ]
    },
    footnote: '口径：结构为示意区间（来自行业访谈与加盟商公开材料），同一杯在不同城市、不同品牌差异极大；茶叶按 2024 内销均价 135 元/公斤折算。'
  });
}

// ── 18 photograph: the cup ────────────────────────────────────────────────
function cupPage() {
  return {
    background: theme.colors.primary,
    elements: [
      photo({ file: 'bubble-tea.jpg', credit: { subject: '珍珠奶茶', author: 'sam651030', licence: 'CC0' }, alt: '一杯奶茶', geometry: { x: 8.15, y: 0, w: 5.18, h: pageHeight } }),
      scrim({ x: 7.0, y: 0, w: 2.2, h: pageHeight, angle: 0, to: 0.5 }),
      {
        type: 'shape', x: marginX, y: 1.42, w: 0.12, h: 0.46, fill: theme.colors.accent, line: false
      },
      {
        type: 'text', text: 'THE CUP', x: marginX + 0.28, y: 1.44, w: 5.0, h: 0.3,
        fontSize: theme.sizes.caption, bold: true, charSpacing: 2, color: theme.colors.background
      },
      {
        type: 'text', text: '一杯茶里，\n茶叶是最便宜的部分', x: marginX, y: 1.96, w: 6.4, h: 1.7,
        fontFace: theme.fonts.heading, fontSize: 34, bold: true, color: theme.colors.background,
        lineSpacingMultiple: 1.22, valign: 'top'
      },
      components.paragraph('这不是坏事：说明这一杯卖的是稳定、方便和位置。但对产地意味着——'
        + '就算新茶饮一年用掉 30 万吨茶，它也不打算为「茶叶品质」付大头。', {
        theme, x: marginX, y: 3.95, w: 6.4, fontSize: theme.sizes.body + 2,
        color: theme.colors.background
      }),
      components.paragraph('想从杯子里多分一点，只有三条路：做基底茶的独家供应、做可追溯的风味标签、'
        + '或者自己做品牌。', {
        theme, x: marginX, y: 5.05, w: 6.4, fontSize: theme.sizes.body,
        color: theme.colors.background, transparency: 18
      }),
      {
        type: 'text', text: '图片：sam651030，CC0（珍珠奶茶）。', x: marginX + 0.04, y: 6.74, w: 6.0, h: 0.26,
        fontSize: theme.sizes.micro, color: theme.colors.background, transparency: 32
      }
    ]
  };
}

// ── 19 five calls ─────────────────────────────────────────────────────────
const calls = [
  '出口按吨、内销按公斤、杯里按克——先想清楚自己在哪一级台阶上赚钱。',
  '均价跌 2.7% 说明产能仍过剩：靠量补价的路，明年会更难走。',
  '加工不是成本项，是定价项；能把含水量与稳定性做稳的产区，才有议价权。',
  '新茶饮吃掉 12% 的内销茶，却只付原料价：想升级，就得进它的配方表。',
  '别用「文化」解释价格差，用「谁承担了库存与获客」解释。'
];

function fiveCalls() {
  return {
    background: theme.colors.background,
    elements: [
      components.title('五条判断', {
        theme, x: marginX, y: 0.52, w: 11.9, fontSize: theme.sizes.title
      }),
      components.divider({ theme, x: marginX + 0.02, y: 1.26, w: 11.85 }),
      ...calls.map((call, index) => [
        {
          type: 'text', text: '0' + (index + 1), x: marginX, y: 1.78 + index * 0.95, w: 0.85, h: 0.6,
          fontSize: 30, bold: true, color: theme.colors.accent
        },
        {
          type: 'text', text: call, x: marginX + 0.9, y: 1.82 + index * 0.95, w: contentWidth - 1.1, h: 0.8,
          fontSize: theme.sizes.body + 5, color: theme.colors.foreground, valign: 'top'
        }
      ]).reduce((all, pair) => all.concat(pair), []),
      footline('本页为结论汇总，证据见前 18 页；数据截至 2026 年 4 月。')
    ]
  };
}

// ── 20 closing on a photograph ────────────────────────────────────────────
function closing() {
  return {
    background: theme.colors.primary,
    elements: [
      photo({ file: 'wuyishan.jpg', credit: { subject: '武夷山茶园', author: 'Lennartbj', licence: 'CC BY-SA 4.0' }, alt: '武夷山茶园', geometry: { x: 7.25, y: 0, w: 6.08, h: pageHeight } }),
      {
        type: 'text', text: 'NEXT / 下一步', x: marginX, y: 2.02, w: 5.4, h: 0.3,
        fontSize: theme.sizes.caption, bold: true, charSpacing: 2, color: theme.colors.accent
      },
      {
        type: 'text', text: '把叶子卖成商品，\n而不是卖成原料', x: marginX, y: 2.42, w: 6.2, h: 1.7,
        fontFace: theme.fonts.heading, fontSize: 34, bold: true, color: theme.colors.background,
        lineSpacingMultiple: 1.24, valign: 'top'
      },
      components.paragraph('下一步是把这三件事排进一年：产区的标准化、品牌的最小可行渠道、'
        + '以及一份能算清的库存账。', {
        theme, x: marginX, y: 4.3, w: 5.6, fontSize: theme.sizes.body + 2, color: theme.colors.background
      }),
      {
        type: 'text', text: '图片：Lennartbj，CC BY-SA 4.0（武夷山茶园）。', x: marginX + 0.04, y: 6.72, w: 5.6, h: 0.26,
        fontSize: theme.sizes.micro, color: theme.colors.background, transparency: 32
      }
    ]
  };
}

// ── 21 image credits: derived, not retyped ────────────────────────────────
function creditsPage(slides) {
  return templates.credits({
    theme,
    images: components.collectImageCredits(slides),
    source: '数据来源：中国茶叶流通协会（2025-03-26、2026-04-29）、中商产业研究院（2026-01-29）、公开报道（2025—2026）。'
  });
}

const body = [
  cover(), summary(), sectionLeaf(), leafNumbers(), priceLadder(), pickingPage(),
  sectionProcess(), sixSteps(), processingCost(), dryLeafPage(),
  sectionTrade(), twoRoads(), volumePrice(), marketPage(), definitionsPage(),
  sectionCup(), cupBreakdown(), cupPage(), fiveCalls(), closing()
];

const deck = {
  title: '一片叶子的三次加价',
  language: 'zh-CN',
  pageSize: 'wide',
  theme,
  slides: body.concat([creditsPage(body)])
};

module.exports = { deck };
module.exports.deck = deck;
