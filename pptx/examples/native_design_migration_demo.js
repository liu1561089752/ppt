'use strict';

const fs = require('node:fs');
const { generatePptx, templates } = require('../native');

const themePath = process.argv[2] || 'native-theme-profile/theme.json';
const outputPath = process.argv[3] || 'native-design-migration-demo.pptx';
if (!fs.existsSync(themePath)) {
  throw new Error('Theme JSON not found: ' + themePath + '. Run extract_html_design_tokens.py first.');
}
const theme = JSON.parse(fs.readFileSync(themePath, 'utf8'));
const hero = templates.hero({
  theme,
  kicker: 'DESIGN SYSTEM / MIGRATION',
  title: '保留设计语言，而不是退回默认模板',
  subtitle: '将 HTML/CSS 的视觉 Tokens 转换为可编辑的 PowerPoint 原生对象。',
  footer: 'EDITABLE OBJECTS  ·  SHARED DESIGN TOKENS'
});

const deck = {
  title: 'HTML/CSS design migration preview',
  author: 'PPT project',
  language: 'zh-CN',
  pageSize: 'wide',
  theme,
  slides: [
    hero,
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
