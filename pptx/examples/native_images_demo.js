'use strict';

// Demonstrates the native image pipeline: cover / contain / explicit crop,
// focal points, zoom, rounded corners, outlines, shadows, and transparency.
// All pictures stay editable PowerPoint picture frames with editable crop
// rectangles — nothing is rasterized into a background image.

const path = require('node:path');
const { generatePptx, components } = require('../native');
const { writePngFixture, gradientPainter, quadrantPainter } = require('../native/scripts/sample_image');

const outputPath = process.argv[2] || 'native-images-demo.pptx';
const assetDir = process.argv[3] || path.join(process.cwd(), 'native-image-assets');

const theme = {
  colors: {
    background: 'F7F7F4', foreground: '202321', primary: '183B3A', accent: 'D36B45',
    muted: '6B7470', surface: 'FFFFFF', border: 'DCE2DE'
  },
  fonts: { heading: 'Aptos Display', body: 'Aptos', cjk: 'Microsoft YaHei' },
  sizes: { title: 30, heading: 20, body: 14, caption: 9 },
  spacing: { pageX: 0.62, pageY: 0.5 },
  effects: { shadow: { color: '1B2A28', opacity: 0.16, blur: 10, angle: 45, distance: 3 } }
};

// Landscape 4:3, portrait 3:4, and a wide panorama give visibly different crops.
const landscape = writePngFixture(assetDir, 'sample-landscape.png', 800, 600,
  gradientPainter([24, 59, 58], [211, 107, 69]));
const portrait = writePngFixture(assetDir, 'sample-portrait.png', 600, 900,
  gradientPainter([32, 48, 66], [0, 166, 166]));
const panorama = writePngFixture(assetDir, 'sample-panorama.png', 1200, 400,
  gradientPainter([245, 240, 230], [24, 59, 58]));
// A smooth gradient makes every fit mode look the same; this pattern has
// quadrants, a frame and corner ticks so crops, focus and zoom are visible.
const pattern = writePngFixture(assetDir, 'sample-pattern.png', 800, 600, quadrantPainter());
const patternTall = writePngFixture(assetDir, 'sample-pattern-tall.png', 600, 900, quadrantPainter());

const margin = theme.spacing.pageX;
const caption = (text, x, y, w) => ({
  type: 'text', text, x, y, w, h: 0.22,
  fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: theme.colors.muted
});

const deck = {
  title: 'Native image pipeline',
  language: 'zh-CN',
  pageSize: 'wide',
  theme,
  slides: [
    {
      background: theme.colors.background,
      elements: [
        components.title('图片适配：cover / contain / stretch', {
          theme, x: margin, y: 0.52, w: 11.9, h: 0.62, fontSize: theme.sizes.title
        }),
        components.divider({ theme, x: margin + 0.02, y: 1.24, w: 11.85 }),
        caption('COVER · 铺满并裁切，保持比例', margin, 1.55, 3.4),
        { type: 'image', path: pattern, x: margin, y: 1.82, w: 3.4, h: 3.6, fit: 'cover', radius: 0.1 },
        caption('CONTAIN · 完整显示，保留比例', margin + 3.72, 1.55, 3.4),
        { type: 'image', path: pattern, x: margin + 3.72, y: 1.82, w: 3.4, h: 3.6, fit: 'contain',
          lineColor: theme.colors.border, lineWidth: 0.75, lineDash: 'dash' },
        caption('STRETCH · 拉伸填充（默认）', margin + 7.44, 1.55, 3.4),
        { type: 'image', path: pattern, x: margin + 7.44, y: 1.82, w: 3.4, h: 3.6, fit: 'stretch', radius: 0.1 },
        {
          type: 'text', text: '三种模式都是原生图片对象：cover 写入 a:srcRect 裁切矩形，contain 直接收敛图片框，stretch 保留旧行为。',
          x: margin, y: 5.7, w: 11.2, h: 0.55, fontFace: theme.fonts.body,
          fontSize: theme.sizes.body, color: theme.colors.foreground, valign: 'top'
        }
      ]
    },
    {
      background: theme.colors.surface,
      elements: [
        components.title('裁切焦点与缩放', { theme, x: margin, y: 0.52, w: 11.9, h: 0.62 }),
        components.divider({ theme, x: margin + 0.02, y: 1.24, w: 11.85 }),
        caption('FOCUS TOP', margin, 1.55, 2.6),
        { type: 'image', path: patternTall, x: margin, y: 1.82, w: 2.6, h: 3.4, fit: 'cover', focus: 'top', radius: 0.08 },
        caption('FOCUS CENTER', margin + 2.9, 1.55, 2.6),
        { type: 'image', path: patternTall, x: margin + 2.9, y: 1.82, w: 2.6, h: 3.4, fit: 'cover', focus: 'center', radius: 0.08 },
        caption('FOCUS BOTTOM', margin + 5.8, 1.55, 2.6),
        { type: 'image', path: patternTall, x: margin + 5.8, y: 1.82, w: 2.6, h: 3.4, fit: 'cover', focus: 'bottom', radius: 0.08 },
        caption('ZOOM 1.8 · 更紧的取景', margin + 8.7, 1.55, 3.0),
        { type: 'image', path: pattern, x: margin + 8.7, y: 1.82, w: 3.0, h: 3.4, fit: 'cover', zoom: 1.8, radius: 0.08 },
        {
          type: 'text', text: 'focus 支持 nine-grid 预设或 { x, y } 归一化坐标；zoom ≥ 1 在保持宽高比的前提下收紧取景。',
          x: margin, y: 5.55, w: 11.2, h: 0.4, fontFace: theme.fonts.body,
          fontSize: theme.sizes.body, color: theme.colors.foreground
        }
      ]
    },
    {
      background: theme.colors.background,
      elements: [
        components.title('图片表面：圆角、描边、阴影、透明度', { theme, x: margin, y: 0.52, w: 11.9, h: 0.62 }),
        components.divider({ theme, x: margin + 0.02, y: 1.24, w: 11.85 }),
        { type: 'image', path: landscape, x: margin, y: 1.9, w: 3.3, h: 2.6, fit: 'cover', radius: 0.22,
          shadow: { color: '1B2A28', opacity: 0.22, blur: 12, angle: 45, distance: 4 } },
        { type: 'image', path: landscape, x: margin + 3.7, y: 1.9, w: 3.3, h: 2.6, fit: 'cover', radius: 0.22,
          lineColor: theme.colors.accent, lineWidth: 2.25 },
        { type: 'image', path: landscape, x: margin + 7.4, y: 1.9, w: 3.3, h: 2.6, fit: 'cover', radius: 0.22,
          transparency: 55 },
        {
          type: 'text', text: '圆角通过 a:prstGeom roundRect + adj 实现，描边写入 a:ln，阴影写入 a:effectLst，透明度写入 a:alphaModFix —— 全部是可编辑的 DrawingML。',
          x: margin, y: 4.85, w: 11.2, h: 0.7, fontFace: theme.fonts.body,
          fontSize: theme.sizes.body, color: theme.colors.foreground, valign: 'top'
        },
        {
          type: 'shape', x: margin, y: 5.85, w: 11.2, h: 0.02, fill: theme.colors.border, line: false
        },
        caption('以上效果在 PowerPoint 中均可通过“设置图片格式”再次编辑。', margin, 6.05, 8)
      ]
    },
    {
      background: theme.colors.primary,
      elements: [
        { type: 'image', path: panorama, x: 0, y: 0, w: 13.333, h: 7.5, fit: 'cover', focus: 'center' },
        {
          type: 'shape', x: 0, y: 2.35, w: 13.333, h: 5.15, fill: theme.colors.primary, fillTransparency: 12, line: false
        },
        {
          type: 'text', text: 'FULL BLEED / IMAGE', x: margin, y: 3.15, w: 5.4, h: 0.26,
          fontFace: theme.fonts.body, fontSize: theme.sizes.caption, bold: true, color: theme.colors.accent
        },
        components.title('满版图片 + 可编辑蒙层', {
          theme, x: margin, y: 3.55, w: 7.4, h: 1.0, color: 'FFFFFF'
        }),
        {
          type: 'text', text: '图片用 cover 铺满页面，蒙层是独立的半透明矩形，标题仍然是原生文本框。',
          x: margin, y: 4.72, w: 7.0, h: 0.8, fontFace: theme.fonts.body,
          fontSize: theme.sizes.body, color: 'E8EDEB', valign: 'top'
        },
        { type: 'shape', x: margin, y: 5.72, w: 1.1, h: 0.07, fill: theme.colors.accent, line: false }
      ]
    }
  ]
};

generatePptx(deck, outputPath)
  .then((result) => {
    console.log(JSON.stringify({
      outputPath: result.outputPath,
      slides: result.report.length,
      warnings: result.report.reduce((sum, slide) => sum + slide.warnings.length, 0),
      assets: { landscape, portrait, panorama }
    }, null, 2));
  })
  .catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
