'use strict';

const { generatePptx, templates } = require('../native');
const outputPath = process.argv[2] || 'native-layouts-demo.pptx';
const theme = {
  colors: { background: '101820', foreground: 'F5F7F8', primary: 'F2AA4C', accent: '00A6A6', muted: 'AAB7C4', surface: '1B2836', border: '344657' },
  fonts: { heading: 'Aptos Display', body: 'Aptos', cjk: 'Microsoft YaHei' },
  sizes: { title: 36, heading: 22, body: 16, caption: 10 },
  backgrounds: { gradient: { angle: 135, stops: [{ position: 0, color: '142536' }, { position: 0.58, color: '234B61' }, { position: 1, color: 'E56A42' }] } },
  effects: { shadow: { color: '000000', opacity: 0.2, blur: 8, angle: 45, distance: 3 } }
};
const deck = {
  title: 'Native visual layout patterns',
  language: 'zh-CN',
  pageSize: 'wide',
  theme,
  slides: [
    templates.hero({ theme, kicker: 'PRODUCT / LAUNCH', title: '为重要信息建立视觉重心', subtitle: '不对称构图、渐变表面和清晰层级，全部由可编辑原生对象组成。' }),
    templates.editorial({ theme, kicker: 'STRATEGY / INSIGHT', title: '编辑式双栏信息布局', lead: '先明确观点，再通过两组证据和行动路径展开。', leftHeading: '市场与机会', leftBody: '解释背景、受众和变化趋势。控制段落长度，避免信息堆叠。', rightHeading: '策略与行动', rightBody: '说明差异化策略、关键指标与执行步骤。' })
  ]
};
generatePptx(deck, outputPath).then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
