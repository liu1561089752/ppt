# 迁移台账：HTML 模式 → 原生模式

原 skill 在 `G:\系统默认\桌面\skills\skills\pptx`（下文简称 **原形态**），目标是**保留它的观感，换掉它的载体**：
不再生成 HTML 再转换，而是直接写出可编辑的 OOXML 对象，并且每一页都能被测量、被渲染、被判分。

这张表是为了回答"改造到什么程度了"而存在，每次动到设计系统就更新它。

---

## 1. 原形态清点（实测文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| `SKILL.md` | 38.7 KB / 512 行 | 四阶段流程 + SLIDE QUALITY BAR |
| `html2pptx1.js` | **261 KB** | 单页 HTML → OOXML 的转换器（CSS 盒模型映射） |
| `batch_html2pptx.js` | 7.8 KB | 遍历 `slides/` 按文件名顺序批量转换 |
| `scripts/check_slides.py` | 32.9 KB | playwright 渲染后验（溢出/越界/重叠） |
| `scripts/extract_pptx_style.py` | 9.3 KB | 从既有 pptx 抽主题（当模板用） |
| `ooxml/scripts/*` | 5 个 | 解包/打包/校验 |

阶段：问答 → 研究+图片 → `global.css` + `slides_brief.json` → 扇出写 `slide_NN.html` → `batch_html2pptx.js` 转 pptx。

**美学的载**是 CSS：Tailwind via CDN + `global.css` 的调色板变量（`--bg/--primary/--accent`）与
字号 token（`--fs-display/h1/h2/h3/body/small/micro`）+ 每页自由的 flex/grid 排版。观感由 261 KB 的
转换器替它落地，所以"能做出什么样"取决于那个转换器支持多少 CSS。

## 2. 逐件替代

| 原形态 | 原生实现 | 说明 |
|---|---|---|
| `global.css`（调色板） | `themes/design_system.js` + `themes/presets.js` + 每份 deck 的 `theme.js` | 7 个颜色槽，内置 4 套色板 |
| `global.css`（字号 token） | `theme.sizes {display, title, heading, body, caption, micro}` + `theme.typography` | ✅ 6 档（原 7 档，h2/h3 合并为 heading 与 body 之间的一档） |
| `slides_brief.json` | `deck.js` + `slides_brief.json`（选填） | 顺序即数组顺序，`--check`/`--json` 机器可读 |
| `slide_NN.html` | `slide_NN.js` / `slide_NN.json` 导出 `elements[]` | 一页一个模块，改一页只重建一页 |
| `html2pptx1.js` + `batch_html2pptx.js` | `engine/native_pptx.js` + `cli.js` | 写入后还有 **23 个补丁**（渐变、阴影、渐变文字、列表编号、图表数据标签定位…） |
| `check_slides.py`（渲染后验） | `engine/layout.js` 事前测量 + `visual_golden.py` + `check_all_text_fit.py` + `render_check.py` | 事前测量比事后 eslint 更早、更便宜 |
| `ooxml/scripts/validate.py` | `scripts/verify_native_ooxml.py` | 结构级校验 |
| （无） | `scripts/verify_with_python_pptx.py --round-trip` | 第三方库能不能打开并回存 |

## 3. 美学要素覆盖

✅ = 已实现且被测试/渲染验证过；⚠️ = 部分；❌ = 缺；✋ = 有意放弃。

| 原美学要素 | 原生实现 | 状态 |
|---|---|---|
| 调色板 `bg/primary/accent` | `theme.colors.background/surface/foreground/primary/accent/muted/border`（7 槽） | ✅ 更细 |
| 调色板对比度要求 | `design_system.contrastRatio()` + `tests/native_presets.test.js`（页面与卡片两处都断言 ≥4.5:1） | ✅ 原形态只有一句"要够对比" |
| 字号 token `--fs-*` | `theme.sizes {display, title, heading, body, caption, micro}`（6 档）+ 权重/字距 token | ✅ |
| 字体 `--font-heading/body/cn/num` | `theme.fonts {heading, body, cjk, numeric}`；`numeric` 未声明时回落 heading，KPI 数值默认取它 | ✅ |
| 卡片：圆角/描边/阴影 | `shape.radius`、`shadow`/`innerShadow`、`effects.cardBorder` | ✅ |
| CSS 渐变 | `shape.gradient{stops, angle, transparency}` + `patchGradientFills` | ✅ 示例里用了 5–10 处 |
| `object-fit: cover` / 焦点裁切 | `image.fit`（7 值）+ `crop{left,right,top,bottom}` + `srcRect` 补丁 | ✅ |
| CSS `filter`（灰度/亮度） | `imageFilter {grayscale, brightness, contrast, opacity}` + `patchImageEffects` | ✅ |
| 图片压暗层（文字压在图上） | `shape` + `transparency` 叠层；SKILL 已写成规则 | ✅ |
| 版式：封面 / 章节扉页 / 关键结论 / KPI 行 / 图文分栏 / 时间线 / 对比 / 收尾 | `templates.{cover, section, editorial, kpi, hero, comparison, process}` + `components.{kpiCard, infoCard, processFlow, timeline}` | ✅ 9/10 |
| 版式：**bento 网格** | 只能拿 `infoCard` 手拼，没有网格 helper | ⚠️ |
| 版式：**引用页** | 无模板 | ❌ |
| Material Icons 图标字体 | 无；SKILL 写死 "No icons font" | ✋（理由未写明，见 §4） |
| 数字用数字字体 | `fonts.numeric` → `kpiCard` 的值、以及任何声明 `fontFace: theme.fonts.numeric` 的数字 | ✅（本轮补的，见 §4） |
| 讲稿 `<aside data-notes>` | `slide.notes` → `a:notesSlide`，`python-pptx` 实测读回原文 | ✅ |
| 富文本（一段里多种样式） | `text` 支持 run 数组（各自字号/颜色/加粗/间距） | ✅ |
| 表格（含合并单元格） | `table` + `vMerge/hMerge` 补丁 | ✅ |
| 图表 | 8 类：bar/line/pie/doughnut/area/radar/scatter/bubble | ✅ |
| 竖排文字 / 分栏 | `element.vert`、`patchTextColumns` | ✅ |
| 增删页只改一处 | SKILL 已写明：改 `slides[]` + `deck.js`，不重命名文件 | ✅ |
| 页眉页脚"非强制" | 模板默认不写页脚 | ✅ |

## 4. 缺口

**本轮修掉的（原为文档与实现打架的两处）：**

- ✅ `fonts.numeric`：SKILL 写"Numbers… render in the numeric face the theme declares"，而主题里没有这个
  槽、引擎也从不读它——照文档写 deck 的人会以为数字已经用上等宽数字。现在 `resolveTheme` 建槽
  （未声明时回落 heading），`kpiCard` 的数值默认取它，`tests/native_presets.test.js` 断言两件事：
  默认继承 heading、声明了就真的用上。
- ✅ 字号档：原 `--fs-display/h1/h2/h3/body/small/micro` 七档，我们只有四档。补上 `display`（44pt，
  封面一句话/关键数字）与 `micro`（9pt，轴标、角标、来源行），SKILL 的"只用主题字号"规则同步更新。
  既有 deck 一页没动（新槽没有消费者，`visual_golden` 9/42 页 look unchanged）。

**还开着的：**

1. **引用页模板（quote）** 与 **bento 网格 helper**。前者是原 catalog 明列的版式；后者原形态靠 CSS grid，
   我们只能拿 `infoCard` 手拼，代价是每份 deck 重算一遍坐标。
2. **图标的放弃没有写理由。** SKILL 只写 "No icons font"。真实理由是：图标字体把观感绑在客户端装的字体上，
   与"可编辑 + 可验证"冲突（我们不嵌字体，缺字体就是豆腐块）。要把这条理由写进 SKILL，让后来的人知道
   这是取舍而不是遗漏。

## 5. 复验（改完怎么确认）

```powershell
cd pptx\native
npm test                                              # 单元 + 语料 + 门禁一致性
node cli.js ../examples/native_color_showcase.spec.js out.pptx --strict
python scripts\visual_golden.py                        # 9 deck / 42 页指纹
python scripts\check_all_text_fit.py                   # 逐框测量 vs 真实渲染
python scripts\render_check.py out.pptx --output-dir render # 需要 LibreOffice
```

LibreOffice 位置（本机）：`%LOCALAPPDATA%\lo\extract\program\soffice.exe`，
用环境变量 `LIBREOFFICE_SOFFICE` 指过去即可。
