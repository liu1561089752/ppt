'use strict';

const { generatePptx, templates, components } = require('../native');

const deck = {
  title: 'Native components preview',
  author: 'PPT project',
  language: 'zh-CN',
  pageSize: 'wide',
  theme: {
    colors: {
      background: 'F7F7F4',
      foreground: '202321',
      primary: '183B3A',
      accent: 'D36B45',
      muted: '6B7470',
      surface: 'FFFFFF',
      border: 'DCE2DE'
    }
  },
  slides: [
    templates.cover({
      title: '原生 PowerPoint 设计系统',
      subtitle: '可编辑对象 · 中文排版 · 可复用组件'
    }),
    templates.kpi({
      title: '关键业务指标',
      items: [
        { label: '年度营收', value: '¥12.8M', note: '同比增长 18%', color: '183B3A' },
        { label: '活跃客户', value: '24,680', note: '覆盖 12 个市场', color: '183B3A' },
        { label: '客户留存', value: '92.4%', note: '高于年度目标', color: 'D36B45' },
        { label: '交付周期', value: '−21%', note: '较去年缩短', color: '183B3A' }
      ]
    }),
    {
      background: 'FFFFFF',
      elements: [
        components.title('从内容到可编辑页面', { x: 0.72, y: 0.55, w: 11.9, h: 0.6, fontSize: 26 }),
        components.divider({ x: 0.74, y: 1.28, w: 11.85 }),
        ...components.infoCard({
          x: 0.75, y: 1.85, w: 3.7, h: 2.3,
          title: '结构化内容',
          body: '先明确结论、证据、数据和来源，再确定每页的信息层级。'
        }),
        ...components.infoCard({
          x: 4.82, y: 1.85, w: 3.7, h: 2.3,
          title: '设计组件',
          body: '根据页面目标选择标题、图文、指标、对比和流程等原生组件。'
        }),
        ...components.infoCard({
          x: 8.89, y: 1.85, w: 3.7, h: 2.3,
          title: '渲染验收',
          body: '检查文字换行、对象边界、字体替换和不同 Office 渲染结果。'
        })
      ]
    },
    {
      background: 'FFFFFF',
      elements: [
        components.title('可编辑原生图表', { x: 0.72, y: 0.55, w: 11.9, h: 0.6, fontSize: 26 }),
        components.divider({ x: 0.74, y: 1.28, w: 11.85 }),
        {
          type: 'chart',
          chartType: 'bar',
          x: 0.9, y: 1.7, w: 11.4, h: 4.8,
          data: [{
            name: '年度营收',
            labels: ['2022', '2023', '2024', '2025'],
            values: [6.2, 7.8, 10.1, 12.8]
          }],
          options: { showLegend: false, showValue: true, valAxisMinVal: 0 }
        }
      ]
    }
  ]
};

const output = process.argv[2] || 'native-components-demo.pptx';
generatePptx(deck, output).then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
