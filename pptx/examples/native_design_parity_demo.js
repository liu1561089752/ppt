'use strict';

const fs = require('node:fs');
const { generatePptx } = require('../native');

const themePath = process.argv[2] || 'native-theme-profile/theme.json';
const outputPath = process.argv[3] || 'native-design-parity-demo.pptx';
if (!fs.existsSync(themePath)) throw new Error('Run extract_html_design_tokens.py before this demo.');
const theme = JSON.parse(fs.readFileSync(themePath, 'utf8'));
const colors = theme.colors || {};
const fonts = theme.fonts || {};
const sizes = theme.sizes || {};
const deck = {
  title: 'HTML to Native visual parity fixture',
  language: 'zh-CN',
  pageSize: 'wide',
  theme,
  slides: [{
    background: colors.background || '101820',
    elements: [
      { type: 'shape', x: 8.65, y: 0, w: 4.68, h: 7.5, fill: colors.surface || '1B2836', line: false },
      { type: 'shape', x: 0.78, y: 0.82, w: 0.12, h: 0.72, fill: colors.accent || '00A6A6', line: false },
      { type: 'text', text: '从 HTML 到原生 PowerPoint', x: 1.08, y: 0.78, w: 7.2, h: 1.0,
        fontFace: fonts.heading, fontSize: sizes.title || 38, bold: true, color: colors.primary || 'F2AA4C' },
      { type: 'text', text: '保留设计语言、信息层级与视觉节奏，让内容对象保持可编辑。',
        x: 1.1, y: 2.05, w: 6.8, h: 1.0, fontFace: fonts.body, fontSize: sizes.body || 18,
        color: colors.foreground || 'F5F7F8', valign: 'top' },
      { type: 'shape', x: 1.08, y: 3.55, w: 6.7, h: 2.05, fill: colors.surface || '1B2836',
        lineColor: colors.border || '344657', lineWidth: 1.0, radius: 0.18 },
      { type: 'text', text: '设计迁移原则', x: 1.42, y: 3.88, w: 5.9, h: 0.48,
        fontFace: fonts.heading, fontSize: sizes.heading || 26, bold: true, color: colors.primary || 'F2AA4C' },
      { type: 'text', text: '颜色、字体、卡片和留白应由同一套设计 Tokens 驱动。',
        x: 1.42, y: 4.55, w: 5.85, h: 0.72, fontFace: fonts.body, fontSize: sizes.body || 18,
        color: colors.foreground || 'F5F7F8', valign: 'top' },
      { type: 'text', text: 'VISUAL SYSTEM / 01', x: 9.05, y: 5.95, w: 3.6, h: 0.3,
        fontFace: fonts.body, fontSize: sizes.caption || 12, bold: true, color: colors.muted || 'AAB7C4' },
      { type: 'shape', x: 9.05, y: 6.42, w: 2.25, h: 0.08, fill: colors.accent || '00A6A6', line: false }
    ]
  }]
};
generatePptx(deck, outputPath).then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
