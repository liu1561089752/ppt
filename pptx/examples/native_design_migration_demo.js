'use strict';

const fs = require('node:fs');
const { generatePptx, templates } = require('../native');

const themePath = process.argv[2] || 'native-theme-profile/theme.json';
const outputPath = process.argv[3] || 'native-design-migration-demo.pptx';
if (!fs.existsSync(themePath)) {
  throw new Error('Theme JSON not found: ' + themePath + '. Run extract_html_design_tokens.py first.');
}
const theme = JSON.parse(fs.readFileSync(themePath, 'utf8'));
const cover = templates.cover({
  theme,
  title: '保留设计语言，而不是退回默认模板',
  subtitle: 'HTML/CSS 视觉 Tokens → Native PowerPoint 原生对象'
});
const extractedGradient = theme.backgrounds && theme.backgrounds.gradient;
const extractedShadow = theme.effects && theme.effects.shadow;
if (extractedGradient && extractedGradient.stops && extractedGradient.stops.length >= 2) {
  cover.elements.push({
    type: 'shape', x: 9.0, y: 1.15, w: 3.2, h: 4.8,
    fill: extractedGradient.stops[0].color, line: false,
    gradient: {
      angle: extractedGradient.angle,
      // CSS opacity is applied to each gradient stop so the vector remains editable.
      stops: extractedGradient.stops.map((stop) => Object.assign({}, stop, {
        transparency: 100 - (100 - (stop.transparency || 0)) * (theme.effects && theme.effects.opacity !== undefined ? theme.effects.opacity : 1)
      }))
    },
    shadow: extractedShadow ? Object.assign({}, extractedShadow, {
      opacity: extractedShadow.opacity * (theme.effects && theme.effects.opacity !== undefined ? theme.effects.opacity : 1)
    }) : undefined,
    rotate: 2
  });
}

const deck = {
  title: 'HTML/CSS design migration preview',
  author: 'PPT project',
  language: 'zh-CN',
  pageSize: 'wide',
  theme,
  slides: [
    cover,
    templates.kpi({
      theme,
      title: '统一视觉规范驱动组件',
      items: [
        { label: '设计 Tokens', value: '100%', note: '颜色、字体、间距、圆角' },
        { label: '原生编辑性', value: 'Native', note: '文本、形状和卡片可编辑' },
        { label: '迁移策略', value: 'Shared', note: 'HTML 与 Native 共用设计语言' }
      ]
    })
  ]
};

generatePptx(deck, outputPath).then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
