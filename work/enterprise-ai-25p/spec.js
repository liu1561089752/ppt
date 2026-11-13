'use strict';

/**
 * 企业级 AI 应用落地路径:从试点到规模化运营 — 25 页,只走引擎
 *
 * 这份 spec 不经过站点的 LLM 链路:内容由人写,版式用引擎的 templates/components 描述,
 * 坐标由布局引擎算。用来和「站点一键生成」的同一主题做对比。
 *
 *   node pptx/native/cli.js work/enterprise-ai-25p/spec.js work/enterprise-ai-25p/deck.pptx \
 *        --strict --json --report work/enterprise-ai-25p/report.json --layout-out work/enterprise-ai-25p/layout.json
 */

const path = require('node:path');
const { templates, components } = require('../../pptx/native');
const { presets } = require('../../pptx/native/themes/presets');

// 预设只给调色板/字号,字体要走真实系统字面(否则文字高度只能估算,PowerPoint 里会重新换行)
const theme = Object.assign({}, presets.sage, {
  fonts: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' },
  // 预设里没有渐变:hero 的右侧面板会退化成一张白卡(实测),所以这里补一条
  backgrounds: { gradient: { angle: 135, stops: [{ color: '1F4438', position: 0 }, { color: '16302A', position: 1 }] } },
});
// 预设只带颜色/字号/行距,layouts 由引擎的 resolveTheme 补齐;
// 手写坐标用的页边距与 DESIGN_SYSTEM 保持一致。
const M = 0.78;

/** 文字页骨架:标题 + 分隔线(给手写元素页用) */
function head(title, options = {}) {
  const size = options.titleSize || theme.sizes.title;
  return [
    components.title(title, {
      theme, x: M, y: 0.52, w: 11.9,
      h: components.measuredHeight(title, 11.9, size, theme) + 0.16,
      fontSize: size, color: options.titleColor || theme.colors.primary,
    }),
    components.divider({ theme, x: M + 0.02, y: 1.3, w: 11.85, color: options.ruleColor || theme.colors.border }),
  ];
}

/** 页脚口径/来源行 */
function sourceLine(text, y = 6.62) {
  return [components.paragraph(text, {
    theme, x: M + 0.04, y, w: 11.6, h: 0.3,
    fontSize: theme.sizes.caption, color: theme.colors.muted,
  })];
}

const deck = {
  title: '企业级 AI 应用落地路径:从试点到规模化运营',
  author: 'Native PowerPoint Engine',
  language: 'zh-CN',
  pageSize: 'wide',
  theme,
  slides: [
    // 01 封面
    templates.cover({
      theme,
      title: '企业级 AI 应用落地路径',
      subtitle: '从试点到规模化运营  ·  面向业务一号位与数字化负责人  ·  2026',
      titleSize: 40,
    }),

    // 02 核心判断
    templates.hero({
      theme,
      kicker: 'KEY MESSAGE / 核心判断',
      title: '卡住规模化的不是模型,是底座与运营',
      subtitle:
        '试点阶段拼的是场景与技术选型;进入规模化,决定成败的变成三件事:平台能不能承接、流程能不能改、责任能不能落到业务侧。'
        + '把这三件事补齐,AI 才会从"演示"变成"生产资料"。',
      footer: 'PLATFORM  ·  PROCESS  ·  OPERATION',
      titleSize: 34,
    }),

    // 03 章节一
    templates.section({
      theme,
      kicker: 'CHAPTER 01',
      title: '现状:试点遍地,规模化稀少',
      subtitle: '为什么同样通过了验证,有的企业开始复制,有的仍停在单个场景?',
    }),

    // 04 四个数字
    templates.kpi({
      theme,
      title: '四个数字看清所处阶段',
      items: [
        { label: '进入生产部署', value: '64%', note: '完成 POC 并接入真实业务' },
        { label: '跨团队部署', value: '34%', note: '两个以上业务线复用同一能力' },
        { label: '进入核心流程', value: '10%', note: '进入决策/交易/服务主链路' },
        { label: '仍以孤岛为主', value: '>70%', note: '缺少统一平台与治理口径' },
      ],
    }),

    // 05 漏斗图
    {
      background: theme.colors.background,
      elements: [
        ...head('从部署到深度使用,漏斗一级比一级窄'),
        {
          type: 'chart', chartType: 'bar',
          x: M + 0.02, y: 1.9, w: 7.9, h: 3.9,
          data: [{ name: '企业占比(%)', labels: ['进入生产部署', '跨团队部署', '进入核心流程'], values: [64, 34, 10] }],
          options: { barDir: 'col', showLegend: false, dataLabels: true, chartColors: [theme.colors.primary] },
        },
        ...components.infoCard({
          theme, x: M + 8.2, y: 1.9, w: 3.85, h: 3.9,
          title: '为什么越往下越少',
          body:
            '部署只需要一个团队和一个场景;跨团队需要统一权限与成本口径;进入核心流程则要求可审计、可回滚、可追责。\n\n'
            + '每往下一级,门槛都从"技术可行"变成"组织可用"。',
        }),
        ...sourceLine('口径:示意数据,用于版式演示;正式版需替换为一手调研或公开报告口径。纵轴自 0 起。'),
      ],
    },

    // 06 角色转移
    templates.editorial({
      theme,
      kicker: 'INSIGHT / 角色转移',
      title: '从"聊天窗口"到"数字员工":重心已经转移',
      lead: 'AI 的定位从"给员工配一个问答窗口",转为"以数字员工形态承接可度量的业务结果"。',
      leftHeading: '形态变化',
      leftBody:
        '第一阶段的形态是对话框:人问、机器答,结果由人再加工。规模化的形态是流程节点:系统调用,结果直接进入业务单据、工单或决策流。'
        + '形态一变,评价方式也随之从"好不好用"变成"准不准、稳不稳、能不能追责"。',
      rightHeading: '衡量变化',
      rightBody:
        '不再统计"有多少人在用",而是统计"有多少业务量由 AI 承接"、"错误率与人工兜底率"、"单笔处理成本"。'
        + '这三个指标一上,能进入生产的环境就少了一半 —— 这正是规模化真正的门槛。',
    }),

    // 07 两种起点
    templates.comparison({
      theme,
      title: '直连通用 API  vs  企业级 AI 平台',
      left: {
        title: '直连通用模型 API',
        body:
          '+ 起步快,几天即可出演示\n'
          + '+ 无需前期平台投入\n'
          + '+ 适合单点验证与探索\n'
          + '− 缺企业上下文与系统对接\n'
          + '− 权限、审计、合规需自建\n'
          + '− 场景一多就重复开发',
      },
      right: {
        title: '企业级 AI 平台',
        body:
          '+ 统一接入多模型与工具\n'
          + '+ 打通数据资产与业务系统\n'
          + '+ 权限、审计、治理内置\n'
          + '+ 能力可复用于新场景\n'
          + '− 需要前期建设与组织配套\n'
          + '− 见效慢于直连,但可复制',
      },
      takeaway: '判断标准很简单:当第二个、第三个场景开始重复造轮子时,就该上平台了。',
    }),

    // 08 四项制约
    templates.bento({
      theme,
      title: '四项系统性制约,单点突破解决不了',
      grid: {
        columns: 4,
        rowHeight: 1.55,
        items: [
          { title: '组织壁垒', body: '部门与业务线之间难以协同,AI 能力归属不清,没人对端到端结果负责。预算与 KPI 各管一段,试点能过、上线难推。' },
          { title: '数据孤岛', body: '数据无法在场景间流通复用,每个场景都要重新对接一遍数据源。取数靠人,口径靠文档,结果没法互相比。' },
          { title: '平台与人才', body: '缺统一底座,也缺兼具体业务理解与 AI 使用能力的复合角色。能力留在个人与供应商手里。' },
          { title: '价值衡量薄弱', body: '缺少效果跟踪与 ROI 核算闭环,预算只能凭感觉追加或削减。说不清效果,也就争不到下一年的钱。' }
        ],
      },
      footnote: '四项相互强化:单点试点越成功,越容易积累各自独立的工具与数据,反而抬高后续整合成本。',
    }),

    // 09 金句
    templates.quote({
      theme,
      background: theme.colors.primary,
      quote: '未来只有两种公司 —— AI 原生型公司,与 AI 边缘型公司。',
      attribution: '行业判断(转述)',
      role: '关键不在于"有没有用 AI",而在于是否进入主价值链的分工。',
    }),

    // 10 章节二
    templates.section({
      theme,
      kicker: 'CHAPTER 02',
      title: '诊断:先评估,再选路',
      subtitle: '不评估就选型,等于用预算试错。先把起跑线说清楚。',
    }),

    // 11 就绪度评估
    templates.table({
      theme,
      title: '就绪度评估:六个维度定位缺口',
      intro: '逐项打分(0–3 分),总分决定今年该做"补底座"还是"扩场景"。',
      colWidths: [2.0, 4.3, 4.3, 1.6],
      rows: [
        ['维度', '看什么', '典型缺口信号', '满分'],
        ['战略与预算', '是否有跨年度预算与业务侧 KPI 挂钩', '只有创新预算,无业务预算', '3'],
        ['数据就绪', '核心数据是否可被场景按需调用', '数据在系统里,取一次批一次', '3'],
        ['平台能力', '是否有统一接入、编排与治理底座', '每个项目自建一套调用链', '3'],
        ['流程与制度', 'AI 结果能否进入正式流程与审批', 'AI 输出只作参考,不进单据', '3'],
        ['组织与人才', '是否有复合角色与明确 owner', '全靠外部供应商推动', '3'],
        ['安全合规', '是否具备数据分级与审计留痕', '拿不到合规签字就上不了生产', '3'],
      ],
      takeaway: '低于 10 分优先补底座;10–14 分可边补边扩;15 分以上直接进入规模化扩张。',
      source: '打分口径为本方法论自定,不引用外部评级。',
    }),

    // 12 三种起点
    templates.kpi({
      theme,
      title: '三类常见的起跑线',
      items: [
        { label: '试点泛滥型', value: '40+', note: '场景多、复用少,先收敛再扩' },
        { label: '平台初建型', value: '1 套', note: '有底座无治理,先补制度再扩' },
        { label: '集团统建型', value: '多租户', note: '有治理缺场景,先做标杆再复制' },
      ],
    }),

    // 13 评估五步
    templates.process({
      theme,
      title: '评估五步:两周内出一版可决策的结论',
      steps: [
        { title: '拉齐口径', body: '统一"什么算落地"的定义,避免各部门各说各话。' },
        { title: '盘点资产', body: '数据、系统接口、已有模型与工具,列成可调用清单。' },
        { title: '场景打分', body: '按价值×可行性打分,只保留前 30% 进入试点。' },
        { title: '缺口排序', body: '把缺口按"阻塞/拖慢/无影响"分级,只解阻塞项。' },
        { title: '定年度路线', body: '形成一页纸路线图,明确预算、owner 与验收口径。' },
      ],
    }),

    // 14 场景取舍
    templates.editorial({
      theme,
      kicker: 'METHOD / 场景取舍',
      title: '选场景不是选"最想做的",是选"最该先做的"',
      lead: '一个场景值得先做,必须同时满足三点:高频、有明确责任方、错一次不至于出大事。',
      leftHeading: '优先做',
      leftBody:
        '高频重复的信息处理与判断辅助:单据审核、客服分流、报告生成、代码与测试补全、知识检索。'
        + '共同点是输入结构化、结果可校验、人工兜底成本低。',
      rightHeading: '先别做',
      rightBody:
        '直接对外的定价与承诺、跨部门利益再分配、责任边界模糊的决策、以及"没人愿意签字"的场景。'
        + '这类场景一旦出错,损失的不是效率,而是信任。',
    }),

    // 15 选路矩阵
    templates.table({
      theme,
      title: '按规模与成熟度选路:四种路径',
      colWidths: [2.4, 3.0, 3.4, 3.0],
      rows: [
        ['企业形态', '当前状态', '建议路径', '关键动作'],
        ['中小企业', '预算有限、无底座', '先用平台化 SaaS', '选两三个高频场景直接采购'],
        ['单业务线集团', '有场景无治理', '业务内建小平台', '统一接入与审计,先跑一条线'],
        ['多业务集团', '有底座无场景', '平台+标杆双轮', '做一个标杆场景,再横向复制'],
        ['强监管行业', '合规优先', '私有化+可审计', '先过合规,再谈效率'],
      ],
      takeaway: '四种路径的共同点:都要先把"谁负责、怎么验收"写下来,再谈技术方案。',
    }),

    // 16 章节三
    templates.section({
      theme,
      kicker: 'CHAPTER 03',
      title: '方法:从能跑到可交付',
      subtitle: '试点验收的标准不是"效果不错",而是"能复制、能回滚、能追责"。',
    }),

    // 17 四步落地
    templates.process({
      theme,
      title: '落地四步:评估 → 试点 → 平台化 → 规模化',
      steps: [
        { title: '评估', body: '定口径、盘资产、排场景,输出一页路线图。' },
        { title: '试点', body: '选一个高频场景,按生产标准做,不做"演示版"。' },
        { title: '平台化', body: '把试点里的能力沉淀成可复用组件与治理规则。' },
        { title: '规模化', body: '按业务线复制,用同一套验收口径度量每个新场景。' },
      ],
    }),

    // 18 项目制 vs 产品化
    templates.comparison({
      theme,
      title: '项目制交付  vs  可持续运营的 AI 产品',
      left: {
        title: '项目制交付',
        body:
          '· 目标:本期验收通过\n'
          + '· 边界:需求清单内\n'
          + '· 成功标志:演示效果好\n'
          + '· 生命周期:验收即结束\n'
          + '· 风险:能力留在供应商手里',
      },
      right: {
        title: '可持续运营的产品',
        body:
          '· 目标:业务指标持续改善\n'
          + '· 边界:持续迭代,允许试错\n'
          + '· 成功标志:使用率与准确率可追踪\n'
          + '· 生命周期:上线才开始\n'
          + '· 风险:需要自己的 owner 与预算',
      },
      takeaway: '把 AI 当产品运营,是唯一能让第二十个场景比第一个场景更便宜的做法。',
    }),

    // 19 平台六能力
    templates.bento({
      theme,
      title: '平台要承接的六项能力',
      grid: {
        columns: 3,
        rowHeight: 1.5,
        items: [
          { title: '统一接入', body: '多模型、多云、本地模型同一套调用面,切换成本低。' },
          { title: '编排与工具', body: '把模型、函数、系统接口编排成可复用的业务动作。' },
          { title: '知识资产', body: '企业知识可检索、可更新、可追溯来源。' },
          { title: '权限与审计', body: '谁能用、用了什么、结果如何,全链路留痕。' },
          { title: '评测与监控', body: '上线前后都有质量基线,退化能被发现。' },
          { title: '成本治理', body: '按场景、按部门核算 token 与算力开销。' },
        ],
      },
      footnote: '六项里只要缺一项,规模化就会在那一项上卡住 —— 这是平台建设最常见的漏项。',
    }),

    // 20 为什么必须平台
    templates.editorial({
      theme,
      kicker: 'ARGUMENT / 平台价值',
      title: '为什么"再做一个场景"必须比第一个便宜',
      lead: '规模化的经济性只有一种来源:复用。复用不了,每多一个场景就多一份人力与运维成本。',
      leftHeading: '没有平台时',
      leftBody:
        '每个场景独立选模型、独立对接数据、独立做权限与日志。第十个场景的成本与第一个几乎一样,'
        + '而且多出十套需要维护的调用链、十个需要解释的口径。',
      rightHeading: '有平台后',
      rightBody:
        '接入、权限、审计、评测、成本核算都由平台提供,新场景只写业务逻辑。'
        + '边际成本随场景数下降,失败场景的沉没成本也随之下限可控。',
    }),

    // 21 路线图
    templates.table({
      theme,
      title: '12 个月路线图:三个阶段,各有交付物',
      colWidths: [2.2, 4.6, 4.9],
      rows: [
        ['阶段', '关键动作', '交付物(验收口径)'],
        ['0–3 月 打底', '选定标杆场景;统一接入与审计;定义验收指标', '一个进入生产的场景 + 一份指标基线'],
        ['4–8 月 沉淀', '把场景能力拆成可复用组件;建立评测与成本核算', '组件清单 + 评测报告 + 成本看板'],
        ['9–12 月 复制', '横向复制到两到三条业务线;固化治理流程', '复用率、覆盖率、单笔成本三项指标达标'],
      ],
      takeaway: '每个阶段都要有"可被验收的交付物",否则路线图会退化成时间表。',
      source: '时间跨度为本方法论建议值,可按企业节奏压缩或拉长。',
    }),

    // 22 90 天
    templates.kpi({
      theme,
      title: '90 天内可以拿到的三样东西',
      items: [
        { label: '一页路线图', value: '1 页', note: '预算、owner、验收口径写在同一页' },
        { label: '一个标杆场景', value: '1 个', note: '按生产标准上线,不是演示' },
        { label: '一套指标基线', value: '3 项', note: '使用率、准确率、单笔成本' },
      ],
    }),

    // 23 章节四
    templates.section({
      theme,
      kicker: 'CHAPTER 04',
      title: '运营:让 AI 进入日常',
      subtitle: '上线只是开始。日常运营决定了这套能力会在一年后变成资产还是负债。',
    }),

    // 24 组织与治理
    templates.bento({
      theme,
      title: '组织与治理的三条主线',
      grid: {
        columns: 3,
        rowHeight: 1.6,
        items: [
          {
            title: '责任主线',
            body: '每个场景有明确的业务 owner 与技术支持人;验收由业务签字,不由技术自评。',
          },
          {
            title: '质量主线',
            body: '上线前有基线,上线后每周抽样复核;退化触发回滚预案,而不是等投诉。',
          },
          {
            title: '能力主线',
            body: '把复用组件、提示词、评测集当成产品资产维护,有版本、有归属、有更新节奏。',
          },
        ],
      },
      footnote: '三条主线各自独立运转,任何一条缺失,另外两条都会在半年内失效。',
    }),

    // 25 总结
    {
      background: theme.colors.primary,
      elements: [
        components.paragraph('SUMMARY / 行动建议', {
          theme, x: M, y: 1.15, w: 8.0, h: 0.34,
          fontSize: theme.sizes.caption + 2, bold: true, color: theme.colors.background, charSpacing: 1.6,
        }),
        components.title('总结:先跑通一个,再复制一批', {
          theme, x: M, y: 1.62, w: 10.6, h: 1.1,
          fontSize: Math.round(theme.sizes.title * 1.3), color: theme.colors.background,
        }),
        components.divider({ theme, x: M, y: 2.86, w: 1.7, color: theme.colors.accent, width: 2.4 }),
        components.paragraph(
          '一、用就绪度评估定起跑线,别用预算试错。\n'
          + '二、选一个高频、可校验、责任清晰的场景,按生产标准做。\n'
          + '三、把试点的能力沉淀成平台组件,让下一个场景更便宜。\n'
          + '四、用使用率、准确率、单笔成本三项指标运营,而不是用"上线了多少场景"汇报。',
          {
            theme, x: M + 0.04, y: 3.3, w: 10.4, h: 2.1,
            fontSize: theme.sizes.body + 4, color: theme.colors.background, transparency: 12,
          },
        ),
        components.paragraph('下一步:两周内完成一版就绪度评估与场景清单。', {
          theme, x: M + 0.04, y: 5.72, w: 10.4, h: 0.4,
          fontSize: theme.sizes.body + 2, bold: true, color: theme.colors.background,
        }),
      ],
    },
  ],
};

// 补白:过程页与 KPI 页的骨架只占上半页,底部用一行结论收口(不留空)
function addLine(index, body, y) {
  deck.slides[index].elements.push(components.paragraph(body, {
    theme, x: M + 0.04, y, w: 11.6, h: 0.6,
    fontSize: theme.sizes.body + 1, color: theme.colors.foreground,
  }));
}

// 过程页下半页空着:补一排"输入/输出/常见失败"卡片(过程骨架本身只占上半页)
function addCards(index, cards, y = 4.62) {
  const gap = 0.28;
  const w = (13.333 - M * 2 - gap * (cards.length - 1)) / cards.length;
  cards.forEach((card, i) => {
    deck.slides[index].elements.push(...components.infoCard({
      theme, x: M + i * (w + gap), y, w, h: 1.5, title: card.title, body: card.body,
    }));
  });
}

addCards(12, [
  { title: '输入', body: '数据清单、系统接口、场景候选与业务口径。' },
  { title: '输出', body: '一页路线图、场景打分表、缺口分级清单。' },
  { title: '常见失败', body: '只打分不定 owner,评完没人认领。' },
]);

addLine(12, '两周内能出结论的关键不是工具,而是先把"什么算落地"写成可打分的清单 —— 清单不定,评估就会变成部门之间的表态。', 3.95);
addCards(16, [
  { title: '输入', body: '路线图、预算与一个明确的业务 owner。' },
  { title: '输出', body: '可复用组件、评测基线与运营指标。' },
  { title: '常见失败', body: '试点做完不留沉淀,下一个场景从零开始。' },
]);

addLine(16, '四步之间没有捷径:跳过"平台化",规模化就会变成"再做一遍试点",每一批场景都重付一次成本。', 3.9);
addLine(21, '90 天的目标不是"做完",而是"能决策":拿到这三样东西,下一年的预算与优先级才有依据。', 4.55);

module.exports = deck;
