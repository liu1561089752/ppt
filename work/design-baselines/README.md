# 版式基准(人工确认过的参考排版)

这里的文件不是产品,是**验收用的参照物**:站点的"AI 设计每一页"到底应该长什么样,
必须有一个不依赖模型、不依赖 API key 的答案,否则每次讨论"好不好看"都只能靠印象。

两份 deck,各管一件事:

| 文件 | 是什么 | 谁生成 |
| --- | --- | --- |
| `probe.js` | 12 种页面原型各一页,**手写**的构图参考(只用 JSON 流式规格,和站点交给引擎的是同一条契约) | 人写 |
| `recipes.json` | 阶段 4 提示词里那 13 段元素骨架拼成的一份 deck | `cd site && npx tsx scripts/recipe-probe.ts --deck ../work/design-baselines/recipes.json` |

两者都不写坐标:所有盒子由引擎的布局算。所以它们同时是三件事的探针 ——
(1) 站点的提示词配方还能不能通过引擎 `--check`;(2) 引擎的构图能力有没有退化;
(3) 同一份内容在不同原型下的实际观感。

## 重新生成

```powershell
# 1) 手写构图:构建 + 逐页渲染 + 联系表
node pptx/native/cli.js work/design-baselines/probe.js work/design-baselines/probe.pptx `
     --strict --json --report work/design-baselines/report.json --layout-out work/design-baselines/layout.json
python pptx/native/scripts/preview_deck.py work/design-baselines/probe.pptx `
     --output-dir work/design-baselines/preview --sheet work/design-baselines/preview/sheet.png

# 2) 提示词配方:先过引擎校验,再拼成 deck 渲染
cd site
npx tsx scripts/recipe-probe.ts --deck ../work/design-baselines/recipes.json
cd ..
node pptx/native/cli.js work/design-baselines/recipes.json work/design-baselines/recipes.pptx --strict --json
python pptx/native/scripts/preview_deck.py work/design-baselines/recipes.pptx `
     --output-dir work/design-baselines/recipes-preview --sheet work/design-baselines/recipes-preview/sheet.png
```

`probe.js` 以 `--strict` 构建必须 0 警告:它是 CI 里 `native-ppt.yml` 的一步。
`recipe-probe.ts` 在 CI 里逐步检查 13 段骨架(`pipeline-e2e.yml`)。

## 看图时该看什么

- **节奏**:整份 deck 不该是"标题 + 三个等宽卡片"重复 12 次。停顿页(封面/章节/引语)
  与论证页的密度必须明显不同。
- **版心**:`columnTracks` 做出来的不对称两栏(左文右数据、图表 2:1、表 2:1)才是版式,
  等分栏只用于"同类项并列"。
- **卡片**:`background: true` 才画底;渲染出来没有卡片面的,都是漏了这个开关。
- **留白**:内容塌在页面上三分之一就是没写完;`review.ts` 里 62% 的像素判据来自这里的观感。

渲染用的是引擎自带的 Pillow 预览器(`preview_deck.py`),它画的是 OOXML 的真实几何,
但**不画图表数据**、**不画阴影**:图表页在预览里是占位框,这一点不代表真实放映效果。
