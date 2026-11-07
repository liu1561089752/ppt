'use strict';

const { generatePptx } = require('../native');

const deck = {
  title: 'Native PowerPoint demo',
  author: 'PPT project',
  language: 'zh-CN',
  pageSize: 'wide',
  slides: [
    {
      background: 'F7F7F4',
      elements: [
        { type: 'text', text: '从 HTML 转换，走向原生 PPT', x: 0.75, y: 0.8, w: 11.7, h: 0.75, fontSize: 30, bold: true, color: '183B3A', fontFace: 'Microsoft YaHei' },
        { type: 'text', text: '文字、形状和图片都是独立 PowerPoint 对象，可直接编辑。', x: 0.78, y: 1.75, w: 10.8, h: 0.65, fontSize: 18, color: '394541', fontFace: 'Microsoft YaHei' },
        { type: 'shape', x: 0.8, y: 3.0, w: 3.55, h: 1.55, fill: 'FFFFFF', lineColor: 'DCE2DE' },
        { type: 'text', text: '原生文本框', x: 1.05, y: 3.35, w: 3.0, h: 0.4, fontSize: 20, bold: true, color: '183B3A', align: 'center', fontFace: 'Microsoft YaHei' },
        { type: 'shape', x: 4.85, y: 3.0, w: 3.55, h: 1.55, fill: 'FFFFFF', lineColor: 'DCE2DE' },
        { type: 'text', text: '原生形状', x: 5.1, y: 3.35, w: 3.0, h: 0.4, fontSize: 20, bold: true, color: '183B3A', align: 'center', fontFace: 'Microsoft YaHei' },
        { type: 'shape', x: 8.9, y: 3.0, w: 3.55, h: 1.55, fill: 'FFFFFF', lineColor: 'DCE2DE' },
        { type: 'text', text: '可编辑组件', x: 9.15, y: 3.35, w: 3.0, h: 0.4, fontSize: 20, bold: true, color: '183B3A', align: 'center', fontFace: 'Microsoft YaHei' },
        { type: 'line', x: 0.8, y: 5.25, w: 11.6, h: 0, color: 'D36B45', width: 2 }
      ]
    },
    {
      background: 'FFFFFF',
      elements: [
        { type: 'text', text: '结构化页面描述', x: 0.8, y: 0.7, w: 11.5, h: 0.6, fontSize: 28, bold: true, color: '183B3A' },
        { type: 'text', text: '通过 Deck Spec 描述内容与设计意图，由布局引擎计算坐标，再映射为 PowerPoint 原生对象。', x: 0.8, y: 1.6, w: 11.5, h: 0.8, fontSize: 18, color: '202321' },
        { type: 'table', x: 0.8, y: 3.0, w: 11.6, h: 2.0, rows: [
          [{ text: '层级', options: { bold: true } }, { text: '职责', options: { bold: true } }],
          ['Content Spec', '内容、结论、数据与来源'],
          ['Design Spec', '页面类型、主题、视觉组件'],
          ['Render Spec', '坐标、字体、尺寸与 PPTX 参数']
        ] }
      ]
    }
  ]
};

const output = process.argv[2] || 'native-demo.pptx';
generatePptx(deck, output).then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
