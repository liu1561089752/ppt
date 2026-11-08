'use strict';

/**
 * Multi-slide stress generator for the HTML -> native pipeline.
 *
 * The fixtures each prove one capability on two or three carefully composed pages. This
 * generator answers a different question: does the pipeline hold up when a *deck* is
 * produced the way a person would produce one - dozens of pages, each a different
 * composition, with real text lengths, tables, charts and the layout primitives mixed on
 * one canvas?
 *
 * It also carries the invariants that a page-level check cannot see: nothing may leave the
 * slide box, every slide must keep the elements it should, and the deck must stay
 * declarative (no silent fallback to absolute boxes).
 *
 * Deterministic: the same `seed` always produces the same deck, so a failure is
 * reproducible from the numbers in the message.
 */

const ARCHETYPES = ['cover', 'cards', 'steps', 'grid', 'data', 'columns', 'metrics'];

/** A tiny deterministic PRNG (numerical recipes LCG) - no randomness across runs. */
function makeRandom(seed) {
  let state = (Number(seed) || 1) % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

const TOPICS = [
  ['交付节奏', '把一次改版拆成可验证的小步，每一步都留在可回滚的位置'],
  ['设计口径', '颜色、间距与字号来自同一份 token，而不是每页各写一遍'],
  ['原生对象', '文本、形状、表格与图表都是 PowerPoint 自己的对象，双击即可编辑'],
  ['排版规则', '网格与弹性容器在浏览器里怎么排，导出的幻灯片就怎么排'],
  ['可验证性', '每一页都经过几何、枚举与渲染三道检查，而不是靠肉眼确认'],
  ['可维护性', '一页 HTML 对应一页幻灯片，改文案不需要重新排版'],
  ['性能', '四十页的 deck 仍然在几秒内产出，因为布局是纯函数计算'],
  ['边界', '当 CSS 超出可翻译范围时，元素退回绝对坐标并如实记录，而不是猜'],
  ['表与图', '同一条数据管线既能出原生表格，也能出可切换类型的图表'],
  ['字体', '中英混排时按字体族挑字面，避免整页被替换成默认字体'],
  ['层级', '表面、文本与装饰分层发射，顺序由 z-index 决定'],
  ['收尾', '每一页都要能单独讲清楚一件事，并且经得起放大看细节']
];

function pick(random, list) {
  return list[Math.floor(random() * list.length) % list.length];
}

// A deck that repeats the same sentence on one page reads like a bug, so the pool is
// walked as a permutation: no topic reappears until every topic has been used.
let topicCursor = 0;
let topicOrder = [];
function nextTopic() {
  if (topicCursor >= topicOrder.length) {
    topicOrder = TOPICS.map((_, index) => index);
    for (let index = topicOrder.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(randomSource() * (index + 1));
      const held = topicOrder[index];
      topicOrder[index] = topicOrder[swap];
      topicOrder[swap] = held;
    }
    topicCursor = 0;
  }
  return TOPICS[topicOrder[topicCursor++]];
}

let randomSource = () => 0.5;

function sentences(random, count) {
  randomSource = random;
  const picked = [];
  for (let index = 0; index < count; index += 1) picked.push(nextTopic());
  return picked;
}

function coverSlide(index, total, random) {
  const [title, lede] = sentences(random, 2);
  return [
    '<main class="slide cover">',
    '  <div class="band"></div>',
    '  <div class="glow"></div>',
    '  <div class="kicker">Native pipeline · ' + String(index + 1).padStart(2, '0') + ' / ' + total + '</div>',
    '  <h1>' + title[0] + '：' + title[1] + '</h1>',
    '  <p class="lede">' + lede[1] + '。这一页复用与其它页完全相同的 token：深色底、一支强调色、两段正文宽度。</p>',
    '  <div class="meta">2026 · native-ppt-engine</div>',
    '</main>'
  ].join('\n');
}

function cardsSlide(index, total, random) {
  const cards = sentences(random, 3);
  return [
    '<main class="slide">',
    '  <div class="kicker accent">' + String(index + 1).padStart(2, '0') + ' · 卡片行</div>',
    '  <h2 class="title">' + pick(random, TOPICS)[0] + '</h2>',
    '  <p class="sub">三张卡片等宽排在一行，标签条按声明宽度换行，附注跟在最后一行下面。</p>',
    '  <div class="cards">',
    ...cards.map(([name, copy], position) => '    <div class="card"><h3>' + name + '</h3><p>'
      + copy.slice(0, 30 + position * 8) + '</p></div>'),
    '  </div>',
    '  <div class="tags">',
    ...cards.map(([name]) => '    <div class="tag">' + name + '</div>'),
    '    <div class="tag">可编辑</div><div class="tag">原生对象</div><div class="tag">几何一致</div>',
    '  </div>',
    '  <p class="foot">第 ' + (index + 1) + ' 页 · 卡片高度由内容决定，标签条按可用宽度换行。</p>',
    '</main>'
  ].join('\n');
}

function stepsSlide(index, total, random) {
  const steps = sentences(random, 4);
  return [
    '<main class="slide">',
    '  <div class="kicker accent">' + String(index + 1).padStart(2, '0') + ' · 流程</div>',
    '  <h2 class="title">四步走完一次迁移</h2>',
    '  <p class="sub">四个等宽步骤共用一条基线，序号与标题同色，说明文字用同一行高。</p>',
    '  <div class="steps">',
    ...steps.map(([name, copy], position) => [
      '    <div class="step">',
      '      <div class="num">0' + (position + 1) + '</div>',
      '      <h3>' + name + '</h3>',
      '      <p>' + copy.slice(0, 34) + '</p>',
      '    </div>'
    ].join('\n')),
    '  </div>',
    '  <p class="foot">第 ' + (index + 1) + ' 页 · 步骤等宽来自 flex: 1，间距来自 gap。</p>',
    '</main>'
  ].join('\n');
}

function gridSlide(index, total, random) {
  const tiles = sentences(random, 6);
  return [
    '<main class="slide">',
    '  <div class="kicker accent">' + String(index + 1).padStart(2, '0') + ' · 网格</div>',
    '  <h2 class="title">三列网格，一块跨两列</h2>',
    '  <p class="sub">网格列宽由 fr 决定，跨列的元素自带声明宽度，文字在单元格内居中。</p>',
    '  <div class="grid">',
    ...tiles.map(([name, copy], position) => '    <div class="tile'
      + (position === 0 ? ' wide' : '') + '"><b>' + name + '</b><span>' + copy.slice(0, 26) + '</span></div>'),
    '  </div>',
    '  <p class="foot">第 ' + (index + 1) + ' 页 · 第一块跨两列，其余各占一格。</p>',
    '</main>'
  ].join('\n');
}

function dataSlide(index, total, random) {
  const rows = [1, 2, 3, 4].map((quarter) => {
    const revenue = 260 + Math.round(random() * 340);
    const cost = 180 + Math.round(random() * 160);
    return '      <tr><td>Q' + quarter + '</td><td>' + revenue + '</td><td>' + cost + '</td></tr>';
  });
  return [
    '<main class="slide">',
    '  <div class="kicker accent">' + String(index + 1).padStart(2, '0') + ' · 数据</div>',
    '  <h2 class="title">同一条数据，两种原生对象</h2>',
    '  <p class="sub">左半是原生表格，右半是同一份数据画出的原生柱状图；两者都可双击编辑。</p>',
    '  <div class="split">',
    '    <div class="pane">',
    '      <table class="plain">',
    '        <thead><tr><th>季度</th><th>收入</th><th>成本</th></tr></thead>',
    '        <tbody>',
    ...rows,
    '        </tbody>',
    '      </table>',
    '    </div>',
    '    <div class="pane">',
    '      <table class="plain" data-chart="bar" data-chart-title="收入与成本"',
    '        data-chart-colors="#D98A4B,#4FA398" data-chart-legend="bottom" data-chart-grid="false"',
    '        data-chart-axis-titles="季度|万元" data-chart-text-color="#3F5450" data-chart-labels="value">',
    '        <thead><tr><th>季度</th><th>收入</th><th>成本</th></tr></thead>',
    '        <tbody>',
    ...rows,
    '        </tbody>',
    '      </table>',
    '    </div>',
    '  </div>',
    '  <p class="foot">第 ' + (index + 1) + ' 页 · 表格与图表由同一份 DOM 生成。</p>',
    '</main>'
  ].join('\n');
}

function columnsSlide(index, total, random) {
  const notes = sentences(random, 6);
  return [
    '<main class="slide">',
    '  <div class="kicker accent">' + String(index + 1).padStart(2, '0') + ' · 列换行</div>',
    '  <h2 class="title">竖着排满一列，再开下一列</h2>',
    '  <p class="sub">六条说明按容器高度断成两列，列间用 column-gap，列内用 gap。</p>',
    '  <div class="board">',
    ...notes.map(([name], position) => '    <div class="note"><div class="no">0'
      + (position + 1) + '</div><div class="label">' + name + '</div></div>'),
    '  </div>',
    '  <p class="foot">第 ' + (index + 1) + ' 页 · 断列规则与行方向换行共用一套算术。</p>',
    '</main>'
  ].join('\n');
}

function metricsSlide(index, total, random) {
  const metrics = [1, 2, 3, 4].map(() => (20 + Math.round(random() * 380)).toString());
  return [
    '<main class="slide">',
    '  <div class="kicker accent">' + String(index + 1).padStart(2, '0') + ' · 指标</div>',
    '  <h2 class="title">四个数字，一条基线</h2>',
    '  <p class="sub">数字用同一字号，说明用同一行高，卡片高度由最长的说明决定。</p>',
    '  <div class="metrics">',
    ...metrics.map((value, position) => '    <div class="metric' + (position === 0 ? ' lead' : '') + '"><div class="value">' + value
      + '</div><div class="label">' + sentences(random, 1)[0][0] + (position % 2 ? '（本月）' : '') + '</div></div>'),
    '  </div>',
    '  <p class="foot">第 ' + (index + 1) + ' 页 · 指标行同样由 flex 均分。</p>',
    '</main>'
  ].join('\n');
}

const RENDERERS = {
  cover: coverSlide,
  cards: cardsSlide,
  steps: stepsSlide,
  grid: gridSlide,
  data: dataSlide,
  columns: columnsSlide,
  metrics: metricsSlide
};

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "PingFang SC", "Noto Sans SC", sans-serif; }
  .slide { position: relative; width: 1280px; height: 720px; padding: 44px 56px; background: #F7F5F1; }
  .kicker { font-size: 12px; letter-spacing: 3px; text-transform: uppercase; color: #86AFA4; }
  .kicker.accent { color: #D98A4B; }
  h2.title { margin: 10px 0 6px; font-size: 30px; color: #1D2A2E; }
  .sub { margin: 0 0 20px; font-size: 14px; line-height: 1.9; color: #6B7B7F; width: 900px; }
  .foot { margin-top: 16px; font-size: 11px; color: #8A9A9E; }

  .cover { background: #10303A; }
  .cover .band { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; background: #10303A; }
  .cover .glow { position: absolute; right: -120px; top: -160px; width: 520px; height: 520px; border-radius: 260px; background: #1C4B57; }
  .cover h1 { margin: 16px 0 0; font-size: 40px; line-height: 1.25; color: #FFFFFF; width: 900px; }
  .cover .lede { margin: 18px 0 0; width: 760px; font-size: 15px; line-height: 1.9; color: #CFE0DA; }
  .cover .meta { position: fixed; left: 56px; bottom: 40px; font-size: 12px; letter-spacing: 1px; color: #7E9C95; }

  .cards { display: flex; flex-direction: row; gap: 18px; width: 1168px; }
  .card { flex: 1; padding: 16px; background: #FFFFFF; border-radius: 12px; }
  .card h3 { margin: 0 0 8px; font-size: 16px; color: #1D2A2E; }
  .card p { margin: 0; font-size: 12.5px; line-height: 1.8; color: #566; }
  .tags { display: flex; flex-wrap: wrap; gap: 8px; width: 1168px; margin-top: 16px; }
  .tag { flex: 0 0 150px; padding: 6px 10px; background: #E7EFEC; border-radius: 6px; font-size: 12px; color: #2C444A; white-space: nowrap; }

  .steps { display: flex; flex-direction: row; gap: 16px; width: 1168px; }
  .step { flex: 1; padding: 16px; background: #FFFFFF; border-radius: 12px; border-top: 3px solid #D98A4B; }
  .step .num { font-size: 12px; letter-spacing: 2px; color: #D98A4B; }
  .step h3 { margin: 8px 0 6px; font-size: 16px; color: #1D2A2E; }
  .step p { margin: 0; font-size: 12px; line-height: 1.75; color: #566; }

  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; width: 1168px; justify-items: center; }
  .tile { width: 100%; padding: 14px 16px; background: #FFFFFF; border-radius: 10px; border: 1px solid #E6E0D6; }
  .tile.wide { grid-column: span 2; }
  .tile b { display: block; font-size: 14px; color: #1D2A2E; margin-bottom: 6px; }
  .tile span { font-size: 12px; line-height: 1.75; color: #566; }

  .split { display: flex; flex-direction: row; gap: 20px; width: 1168px; }
  .pane { flex: 1; padding: 14px 16px; background: #FFFFFF; border-radius: 12px; }
  table.plain { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.plain th { text-align: left; padding: 8px 6px; color: #566; border-bottom: 1px solid #DCD7CE; }
  table.plain td { padding: 7px 6px; border-bottom: 1px solid #ECE7DF; color: #2B3B3F; }

  .board { display: flex; flex-direction: column; flex-wrap: wrap; gap: 12px; width: 1168px; height: 240px; align-content: space-between; }
  .note { width: 560px; padding: 14px 16px; background: #FFFFFF; border-radius: 10px; border: 1px solid #E6E0D6; display: flex; flex-direction: row; align-items: center; gap: 12px; }
  .note .no { flex: 0 0 30px; height: 30px; border-radius: 15px; background: #D98A4B; display: flex; align-items: center; justify-content: center; color: #FFFFFF; font-size: 12px; line-height: 1.2; font-weight: 600; }
  .note .label { font-size: 13px; line-height: 1.6; color: #1D2A2E; }

  .metrics { display: flex; flex-direction: row; gap: 18px; width: 1168px; }
  .metric { flex: 1; padding: 18px; background: #FFFFFF; border-radius: 12px; }
  .metric.lead { background: linear-gradient(135deg, #1D3B3F, #2C5A52); }
  .metric.lead .value, .metric.lead .label { color: #F3EFE7; }
  .metric .value { font-size: 34px; line-height: 1.15; color: #1D3B3F; font-weight: 600; }
  .metric .label { margin-top: 6px; font-size: 12.5px; line-height: 1.7; color: #6B7B7F; }
`;

/** Build the HTML for `slides` pages. The first page is always the cover. */
function generate(options = {}) {
  topicCursor = 0;
  topicOrder = [];
  const total = Math.max(1, Math.min(200, Number(options.slides) || 12));
  const random = makeRandom(options.seed === undefined ? 1 : options.seed);
  const parts = [];
  for (let index = 0; index < total; index += 1) {
    const kind = index === 0 ? 'cover' : ARCHETYPES[(index - 1) % (ARCHETYPES.length - 1) + 1];
    parts.push((RENDERERS[kind] || cardsSlide)(index, total, random));
  }
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Multi-slide stress deck (' + total + ' pages)</title>',
    '<style>' + STYLE + '</style>',
    '</head>',
    '<body>',
    '',
    parts.join('\n\n'),
    '',
    '</body>',
    '</html>'
  ].join('\n');
}

/** Every element must sit inside the slide it belongs to. */
function checkBounds(deck, pageSize, tolerance = 0.02) {
  const problems = [];
  deck.slides.forEach((slide, index) => {
    const visit = (elements) => (elements || []).forEach((element) => {
      const x = Number(element.x);
      const y = Number(element.y);
      const w = Number(element.w);
      const h = Number(element.h);
      if ([x, y, w, h].every((value) => Number.isFinite(value))) {
        // A decorative shape may hang off the page: CSS would clip it, and the slide edge
        // clips it too, so only something *entirely* outside is an error. Text is held to
        // the stricter rule - a text box that leaves the canvas means a layout mistake,
        // because its glyphs can spill past the edge.
        const outside = x + w <= 0 || y + h <= 0 || x >= pageSize.width || y >= pageSize.height;
        const spills = x < -tolerance || y < -tolerance
          || x + w > pageSize.width + tolerance || y + h > pageSize.height + tolerance;
        const strict = element.type === 'text';
        if (outside || (strict && spills)) {
          problems.push({
            slide: index + 1,
            type: element.type,
            box: [x, y, w, h].map((value) => Number(value.toFixed(3))),
            label: typeof element.text === 'string' ? element.text.slice(0, 24) : undefined
          });
        }
      }
      visit(element.children);
    });
    visit(slide.elements);
  });
  return problems;
}

/** The invariants a generated deck has to keep, whatever `slides` asks for. */
function checkDeck(result, options = {}) {
  const pageSize = options.pageSize || {
    width: result.deck.pageSize ? result.deck.pageSize.width : 13.3333,
    height: result.deck.pageSize ? result.deck.pageSize.height : 7.5
  };
  const expected = options.slides;
  const problems = [];
  if (expected !== undefined && result.deck.slides.length !== expected) {
    problems.push({ kind: 'slide-count', expected, actual: result.deck.slides.length });
  }
  const unsupported = (result.report.unsupportedDetails || []).map((entry) => entry.property + ' :: ' + entry.reason);
  if (unsupported.length) problems.push({ kind: 'unsupported', details: unsupported.slice(0, 6) });
  if ((result.report.containerFallbacks || []).length) {
    problems.push({ kind: 'fallback', details: result.report.containerFallbacks.slice(0, 6) });
  }
  if (Number(result.report.maxBoxDelta) > 0.012) {
    problems.push({ kind: 'box-delta', delta: result.report.maxBoxDelta });
  }
  const bounds = checkBounds(result.deck, pageSize);
  if (bounds.length) problems.push({ kind: 'out-of-bounds', details: bounds.slice(0, 6) });
  const empty = [];
  result.deck.slides.forEach((slide, index) => {
    if (!(slide.elements || []).length) empty.push(index + 1);
  });
  if (empty.length) problems.push({ kind: 'empty-slide', details: empty });
  return problems;
}

module.exports = { generate, checkDeck, checkBounds, ARCHETYPES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = args.indexOf('--' + name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const fs = require('node:fs');
  const path = require('node:path');
  const slides = Number(flag('slides', 12));
  const seed = Number(flag('seed', 1));
  const out = flag('out', null);
  const pptx = flag('pptx', null);
  const html = generate({ slides, seed });
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, html);
    console.log('wrote ' + out + ' (' + slides + ' pages)');
  }
  const pipeline = require('../pipeline');
  const started = Date.now();
  const result = pipeline.convertHtml(html);
  const elapsed = Date.now() - started;
  const problems = checkDeck(result, { slides });
  const shapes = result.deck.slides.reduce((sum, slide) => sum + (slide.elements || []).length, 0);
  console.log('slides=' + result.deck.slides.length + ' top-level-elements=' + shapes
    + ' text=' + result.report.textElements + ' tables=' + result.report.tables
    + ' charts=' + result.report.charts + ' in ' + elapsed + 'ms');
  if (pptx) {
    const { generatePptx } = require('../engine/native_pptx');
    fs.mkdirSync(path.dirname(path.resolve(pptx)), { recursive: true });
    generatePptx(result.deck, path.resolve(pptx)).then((written) => {
      console.log('wrote ' + written.outputPath + ' (' + written.report.length + ' slides)');
    });
  }
  if (problems.length) {
    problems.forEach((problem) => console.log('PROBLEM ' + JSON.stringify(problem)));
    process.exit(1);
  }
  console.log('OK: ' + slides + ' generated page(s) kept every invariant');
}
