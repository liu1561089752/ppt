# STRUCTURE — 这个仓库里每个文件是什么，为什么在这儿

> 本文是一份**文件级核对表**，不是使用手册。分工如下：
>
> | 想知道 | 看 |
> | --- | --- |
> | 怎么生成一份 deck、spec 怎么写、设计规则 | [`README.md`](README.md)、[`../SKILL.md`](../SKILL.md) |
> | 从 HTML 管线迁到原生引擎，每一步的账 | [`MIGRATION.md`](MIGRATION.md) |
> | 删掉了什么、为什么删、每道门禁换成了什么 | [`REMOVAL.md`](REMOVAL.md) |
> | 部署、性能、并发、运维 | [`DEPLOY.md`](DEPLOY.md) |
> | 引擎**画不出来**的东西（拒绝清单） | [`LIMITS.md`](LIMITS.md)（由写入器自动生成） |
> | **某个文件是什么、能不能删、要不要提交** | 就是本文 |

_last verified: 2026-02, `git rev-parse HEAD` 见提交记录；本文所有数字都由下面的命令重新算过，不是抄的。_

---

## 1. 三条判据

整理仓库时只需要三条规则，其余都是推论。

1. **生成物不入库。** `.pptx`、`.pdf`、渲染出的 `.png`、`__pycache__`、报告 JSON——它们都能由某个 spec 重新生成，而且**没有任何代码会读回它们**。入库只会让 `git status` 变脏、让 diff 变噪音。
   例外：**经过人眼评审的基线**（`baselines/`、`golden/`）必须入库，否则门禁失去意义。
2. **输入和产物分开放。** 一个目录里既有输入（照片、spec、主题 profile）又有输出（deck、pdf、预览图）时，人迟早会删错东西。所以：
   输入 → `examples/`、`native-theme-profile/`（入库）；输出 → `acceptance/`、`tea/`、`render-*/`、`preview/`（不入库）。
3. **文档里的数字必须能重新跑出来。** 这一轮修掉的三处文档错误（`7 decks / 35 pages`、`262 boxes`、`1.15 s`）都是因为当初写数字时没记命令。现在每个数字后面都跟命令。

---

## 2. 地图

```
F:\native-ppt-engine\
├── .github/workflows/native-ppt.yml   CI：构建 → 审计 → 渲染 → 三阅读器校验（148 行）
├── .gitignore                          生成物的边界，与本文第 11 节一一对应
├── README.md                           仓库入口（84 行）
└── pptx\
    ├── SKILL.md                        写作代理的完整说明书（805 行）
    ├── batch_native_pptx.js            批量构建 CLI（spec JSON → 多个 deck）
    ├── examples\                       ★输入：spec / 演示脚本 / 照片 / 设计参考
    ├── native\                         ★引擎本体 + 工具 + 基线 + 交付产物
    ├── ooxml\                          原样引入的上游 OOXML 校验/打包工具
    ├── scripts\                        3 个 HTML 时代的提取/检查脚本（2 个已不可运行）
    └── tests\                          7 个测试文件（153 条）
```

体积账（当前工作区）：

| | 文件数 | 体积 |
| --- | --- | --- |
| git 跟踪 | 105 | 4.12 MB（其中 2.96 MB 是 6 张茶园照片） |
| 在磁盘、故意不入库 | 6 个交付产物 | 10.1 MB |
| 依赖 | — | 14.7 MB（`node_modules/`，不入库） |

---

## 3. 根目录

| 文件 | 是什么 | 谁写 | git |
| --- | --- | --- | --- |
| `README.md` | 仓库门面：这是什么、怎么跑第一个 deck、门禁一览 | 人 | ✔ |
| `.gitignore` | 生成物边界；每个模式都对应第 11 节的某一行 | 人 | ✔ |
| `.github/workflows/native-ppt.yml` | CI。**注意**：它调用的 16 个 npm script 与 12 个文件路径都必须存在，由 `check_housekeeping.js` 逐个核对 | 人 | ✔ |

---

## 4. `pptx/`

| 文件 | 是什么 | 谁调用 | git |
| --- | --- | --- | --- |
| `SKILL.md` | 写作代理的说明书：四阶段流程、设计语言、质量检查表、引擎契约（附录）、编辑既有 pptx 的两种做法。62 KB / 805 行 | 人读；代理执行 | ✔ |
| `batch_native_pptx.js` | 批量构建：读一份 spec JSON，输出多个 deck + 汇总报告。`npm run batch`，CI 也会跑 | `package.json`、CI、`tests/native_engine.test.js` | ✔ |

---

## 5. `pptx/examples/` — 输入：spec、演示、参考

**判断方法**：这些文件都是"人写的输入"。除了 `design-reference.*` 和 `assets/`，其余每一个都被 `golden/specs.json`、某个 npm script 或某个测试引用。

| 文件 | 是什么 | 谁调用 |
| --- | --- | --- |
| `native_deck_spec.js`（186 行） | **主示例**：6 页，四种模板 + 原生图表 + 表格 + 备注 | `npm run deck:example`、`golden` 的 `spec-flagship` |
| `native_deck.json`（57 行） | 同一份 deck 的 JSON 形态，证明"JSON 是便携契约" | `npm run batch` |
| `native-cover.spec.json`（156 行） | 单页封面 spec（纯 JSON 路径的最小例子） | `npm run deck:json`、`golden` 的 `spec-cover` |
| `native-deploy-smoke.spec.json`（103 行） | 部署冒烟 deck | `golden` 的 `deploy-smoke` |
| `native_color_showcase.spec.js`（200 行） | 配色系统展示页（8 页），`preset()` 的回归样本 | `golden` 的 `color-showcase` |
| `native_demo.js`（48 行） | 最小 demo：三页 | `npm run demo` |
| `native_components_demo.js`（85 行） | 组件演示（kpiCard / infoCard / timeline / processFlow） | `npm run demo:components` |
| `native_layouts_demo.js`（24 行） | 版式演示 | `npm run demo:layouts` |
| `native_images_demo.js`（148 行） | 图片能力演示：fit / crop / 圆角 / 蒙版 / 平铺 | `npm run demo:images` |
| `native_stress_deck.js`（754 行） | 生成式压力 deck（40/120/300 页） | `npm run demo:stress`、`golden` 的 `demo-stress` |
| `native_design_migration_demo.js`（46 行） | 用 `native-theme-profile/theme.json` 复刻 HTML 时代的设计（迁移证据） | `npm run demo:theme` |
| `native_design_parity_demo.js`（43 行） | 设计对齐演示（渐变、阴影、透明度） | `npm run demo:parity` |
| `native_tea_deck.js`（644 行） | **第二份验收 deck**：21 页、6 张照片、鸣谢由图片 credit 生成 | `golden` 的 `tea-photo`、`pptx/native/tea/` 的产物 |
| `design-reference.html` / `.css`（169 / 144 行） | HTML 时代的**设计参考原件**：配色、字号、间距、渐变、阴影的出处。原生引擎的 `themes/presets.js` 就是按它逐条对的 | `parity/README.md`、根 `README.md` 引用；不参与构建 |
| `stress-photo.png`（5.9 KB） | 压力测试用的小照片（引擎里 `native_pptx.js` 引用它做尺寸计算样例） | 引擎代码 |
| `assets/tea/*.jpg`（6 张，2.96 MB） | 茶 deck 的照片，全部 Wikimedia Commons，逐张带许可 | `native_tea_deck.js` |

### 5.1 `examples/assets/tea/` — 6 张照片与它们的许可

| 文件 | 内容 | 作者 · 许可 | 体积 |
| --- | --- | --- | --- |
| `garden-hangzhou.jpg` | 杭州茶园小径 | Takashishin · CC BY 4.0 | 712 KB |
| `zhejiang-picking.jpg` | 浙江茶区采茶（1987） | Matti & Keti Lorenz · CC BY-SA 4.0 | 564 KB |
| `longjing-dry.jpg` | 龙井干茶 | Romain Guy · CC BY-SA 2.0 | 169 KB |
| `kunming-market.jpg` | 昆明茶叶市场 | Steve Evans · CC BY 3.0 | 105 KB |
| `bubble-tea.jpg` | 珍珠奶茶 | sam651030 · CC0 | 402 KB |
| `wuyishan.jpg` | 武夷山茶园 | Lennartbj · CC BY-SA 4.0 | 1007 KB |

许可不只写在这里：每张图的 `credit` 字段写在 spec 里，deck 的最后一页由 `components.collectImageCredits()` 自动生成——**同一个事实只有一个出处**。

---

## 6. `pptx/native/` — 引擎本体

### 6.1 入口

| 文件 | 是什么 | 谁调用 | git |
| --- | --- | --- | --- |
| `index.js`（27 行） | 包的公开出口：`{ cli?, templates, components, themes, layout, writer }` 的门面 | 外部脚本 | ✔ |
| `cli.js`（347 行） | 命令行：`node cli.js <spec> [out.pptx] [--strict] [--json] [--check]`。所有门禁都经过它 | npm scripts、CI、测试 | ✔ |

### 6.2 五层内核

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `core/schema.js` | 530 | Deck Spec 校验：字段类型、范围、互斥（唯一含"拒绝"的地方之一）。共 **113 条**约束 |
| `core/units.js` | 24 | 英寸/EMU/磅换算，全仓库唯一换算出口 |
| `engine/layout.js` | 751 | 版式：盒模型、换行、溢出判定、重叠检测、`measuredHeight` 的真实来源 |
| `engine/text_measure.js` | 250 | 真字形度量（fontkit + 系统字体），无字形时退化并记录 |
| `engine/font_manager.js` | 284 | 字体发现/匹配（含 CJK 回退），`fc-match` 路径 |
| `engine/east_asian_font.js` | 39 | 中日韩字体的选择规则 |
| `engine/flex_lines.js` / `flex_size.js` | 109 / 50 | flex 容器的断行与尺寸分配 |
| `engine/grid_place.js` | 296 | 网格放置（bento / grid container 的落位算法） |
| `engine/image_fit.js` | 477 | 图片 fit / crop / 圆角 / 蒙版 / 平铺几何，以及 `altText`/`hyperlink` |
| `engine/validation.js` | 39 | 写后校验的入口（与 `scripts/verify_native_ooxml.py` 互补） |
| `engine/native_pptx.js` | 2486 | **写入器**：pptxgenjs → 原生 OOXML，末尾 23 处补丁（表格行高、渐变、透明度、图片裁切、a:tbl 样式…） |
| `components/text.js` | 92 | `title` / `paragraph` / `divider` / `measuredHeight` |
| `components/cards.js` | 206 | `kpiCard` / `infoCard` / `bento`（行高按内容） |
| `components/diagrams.js` | 141 | `processFlow` / `timeline`（接受 `description` 或 `body`） |
| `components/credits.js` | 47 | `collectImageCredits` / `creditRows`：从 deck 里收集图片来源 |
| `components/index.js` | 8 | 组件聚合出口 |
| `templates/index.js` | 439 | 12 个页面模板：`cover / section / hero / content / editorial / kpi / comparison / process / quote / bento / table / credits` |
| `themes/presets.js` | 105 | 4 套配色预设（含 `clay`），全部经过对比度计算 |
| `themes/design_system.js` | 79 | 设计系统常量与 `contrastRatio` |
| `themes/default.js` | 21 | 默认主题 |

### 6.3 `scripts/` — 21 个工具

"工具链"一列是**跑它需要什么**：只写 Python/stdlib 的能在任何机器上跑；需要 LibreOffice 或 WPS 的必须在装了的机器上跑。

| 脚本 | 干什么 | 工具链 | 谁调用 |
| --- | --- | --- | --- |
| `audit_deck.js` | 可编辑性普查：每页形状/图表/表格/图片/文字对象计数，`--min-text-shapes` 判"是不是变成了截图" | node | `npm run audit:images|audit:stress`、CI |
| `check_all_text_fit.py` | **全语料**文本贴合基线：466 个框，统计"需要多一行"和"丢字" | LibreOffice + poppler（真渲染取文本） | `npm run audit:text-fit` |
| `check_text_fit.py` | 单个 deck 的贴合分析（`check_all_text_fit.py` 的实现层） | 同上 | 被上者 import |
| `check_housekeeping.js` | **本文的自动版本**：CI 一致性、游离文件、死引用、生成物越界 | node + git | `npm run housekeeping`、CI |
| `compare_renderers.py` | 两个渲染器的像素对比（缩小后比，抹掉抗锯齿只留版位） | Pillow | `npm run compare:renderers` |
| `compare_all_renderers.ps1` | 同上，批量（LibreOffice vs WPS） | Windows + WPS | `npm run verify:readers` |
| `corpus.py` | 语料模块：把 `golden/specs.json` 的条目构建出来（`{assets}` → 临时目录，所以语料不需要提交二进制） | node | 被 `visual_golden.py`、`check_all_text_fit.py` import |
| `corrupt_anchor.py` | 制造一份"坏"deck（枚举值/锚点被改坏），用来证明校验器真能发现问题 | stdlib | `verify_native_ooxml.py --self-test` |
| `inspect_pictures.js` | 图片对象逐项检查（尺寸、裁切、圆角、透明度） | node | `npm run verify:pictures` |
| `limits_report.js` | 从写入器的 `recordUnsupported` 调用点生成 `LIMITS.md`（66 条拒绝 + 113 条约束） | node | `npm run limits[:update]`、CI |
| `lint_static.js` | 静态风格门禁：无新依赖、无网络、库代码不打印、行宽 ≤ 200 | node | `npm run lint`、`npm test` |
| `preview_deck.py` | Pillow 离线版式预览（**不是** Office 渲染，只验几何与配色） | Pillow | `npm run preview:*` |
| `render_check.py` | LibreOffice 渲染成 PDF+PNG 并校验页数/尺寸。`--slides 3,7-9` 只渲几页 | LibreOffice + poppler | `npm run render:*`、CI、人工验收 |
| `sample_image.js` | 确定性 PNG 编码器：demo 与测试**运行时**生成图片，所以不用提交二进制 | node | 各 demo、`stress_spec.js` |
| `stress_spec.js` | 直接从引擎 API 生成 N 页压力稿（40/120/300），带 180 s 预算 | node | `npm run stress[:big|scale]` |
| `verify_all_with_wps.ps1` | 用第二个阅读器（WPS）打开全部 deck 并报告 | Windows + WPS | `npm run verify:wps` |
| `verify_native_ooxml.py` | OOXML 结构校验：枚举合法性、完整性、图片裁切、渐变、内嵌字体、`uneven_tables` | stdlib | CI、`npm run audit:integrity*` |
| `verify_with_python_pptx.py` | 第三个阅读器（python-pptx）打开 + 往返保存 | python-pptx | `npm run verify:pptx`、CI |
| `verify_with_wps.ps1` | 单 deck 的 WPS 打开/导出 | Windows + WPS | `npm run render:wps` |
| `visual_golden.py` | **视觉基线**：10 deck / 65 页的像素指纹；`--update` 才改基线 | LibreOffice + Pillow | `npm run golden:check[:update]` |
| `visual_regression.py` | 与人工评审过的 `golden/<deck>/*.png` 比对（MAE/SSIM 阈值） | Pillow | CI |

### 6.4 基线与语料（**都入库**）

| 文件 | 是什么 | 谁写 | 更新命令 |
| --- | --- | --- | --- |
| `golden/specs.json` | 语料清单：10 个 deck（9 个 spec/脚本 + 1 个带照片的茶 deck） | 人 | 手工编辑 |
| `golden/README.md` | 怎么加一个 deck 进语料、基线的哲学 | 人 | — |
| `baselines/visual.json` | 65 页的视觉指纹（92 KB） | `visual_golden.py` | `npm run golden:update` |
| `baselines/text-fit.json` | 466 个文本框的贴合基线 | `check_all_text_fit.py` | `npm run baseline:text-fit` |

### 6.5 交付产物（**不入库**，留在磁盘上给人看）

| 路径 | 是什么 | 怎么重建 |
| --- | --- | --- |
| `acceptance/deck.json`（101 KB / 4025 行，**入库**） | 25 页储能 deck 的 spec（唯一来源，可复现） | 人写 |
| `acceptance/storage-2026.pptx`（509 KB） | 那份 deck | `node cli.js acceptance/deck.json acceptance/storage-2026.pptx --strict` |
| `acceptance/storage-2026.pdf` + `contact-sheet.png` | 真渲染与缩略图拼版 | `python scripts/render_check.py acceptance/storage-2026.pptx --output-dir <dir>`，再用 Pillow 拼版（第 12 节的脚本片段） |
| `tea/tea-deck.pptx`（3.4 MB） | 21 页茶 deck | `node cli.js ../examples/native_tea_deck.js tea/tea-deck.pptx --strict` |
| `tea/tea-deck.pdf` + `contact-sheet.png` | 同上 | 同上 |

### 6.6 `native-theme-profile/` — **输入，必须入库**

| 文件 | 是什么 |
| --- | --- |
| `theme.json`（1 KB） | 由 `design-reference.css` 抽出来的主题：配色、字号、间距、渐变、阴影 |
| `design-tokens.json`（5 KB） | 抽出的原始 token（含 CSS 变量原文） |
| `source.css`（3 KB） | 抽取时的 CSS 快照，供核对 |

**这曾经是一个真问题**：`.gitignore` 把整个目录忽略了，但 `npm run demo:theme` / `demo:parity` 把它当**输入**读取——也就是说干净 clone 上这两个 demo 必然失败，CI 也一样。本轮改成入库（9 KB 的 fixture），并在 `.gitignore` 里删掉了那条规则。

### 6.7 其它

| 文件 | 是什么 | git |
| --- | --- | --- |
| `parity/README.md` | 原生输出与 HTML 原件的对齐记录（逐条：配色/字号/间距/渐变/阴影） | ✔ |
| `README.md` / `DEPLOY.md` / `MIGRATION.md` / `REMOVAL.md` / `LIMITS.md` | 见第 0 节分工表。`LIMITS.md` 是**生成物**，但入库（人要 review），CI 会 `--update` 后 `git diff --exit-code` 校验 | ✔ |
| `package.json` / `package-lock.json` | 依赖只有 pptxgenjs + fontkit；所有脚本都在这里 | ✔ |

---

## 7. `pptx/ooxml/` — 原样引入的上游工具（8 个文件）

| 文件 | 是什么 |
| --- | --- |
| `scripts/unpack.py` / `pack.py` | 解包/打包 `.pptx`（就是 zip） |
| `scripts/validate.py` | 校验器的 CLI |
| `scripts/validation/base.py`（949 行） | 上游的 OOXML 规则引擎（含 schema 校验） |
| `scripts/validation/pptx.py` / `docx.py` | 各格式的具体规则 |
| `scripts/validation/redlining.py` | 修订标记规则 |
| `scripts/validation/__init__.py` | 包声明 |

这 8 个文件**保持上游原样**（不按本仓库风格改写），所以 `check_housekeeping.js` 跳过整个 `pptx/ooxml/` 的引用扫描——它内部是动态 import。

---

## 8. `pptx/scripts/` — HTML 时代的三个脚本

| 文件 | 是什么 | 现状 |
| --- | --- | --- |
| `extract_native_design.py`（298 行） | 从一份既有 `.pptx` 抽设计画像（配色/字号/形状签名） | **仍可用**，CI 会跑（`design-profile/`） |
| `check_slides.py`（713 行） | HTML 时代的渲染后验：Playwright 打开 HTML 页查溢出/越界/重叠 | **已不可运行**（仓库里没有 HTML 页了）。保留原因：`MIGRATION.md` 的对照表引用它作为"旧门禁"，删了会让迁移账失去参照。CI 只 `py_compile` |
| `extract_pptx_style.py`（271 行） | 从 `.pptx` 主题抽配色/字体方案 | 半遗产：仍可对任意 pptx 运行，迁移期用过；`MIGRATION.md` 引用 |

> 结论：这三个文件里，**只有 `extract_native_design.py` 是活代码**。另外两个留着是"账本"的一部分，不是工具链的一部分——如果你要删，请同时改 `MIGRATION.md` 第 17–18、36 行。

---

## 9. `pptx/tests/` — 153 条测试

| 文件 | 行数 | 覆盖什么 |
| --- | --- | --- |
| `native_engine.test.js` | 1266 | 引擎主契约：spec→deck、布局测量、容器、图表、表格、批量、导出面 |
| `native_fill.test.js` | 707 | 平铺填充与 fit/crop 几何（在**产出的包**上验，不只看 spec） |
| `native_links.test.js` | 494 | 图片超链接与表格单元格的项目符号（写入器会静默丢弃的东西） |
| `native_cli.test.js` | 205 | CLI 的公开行为：子进程、stdout/stdin、退出码、`--strict` |
| `native_presets.test.js` | 136 | 配色预设的两条规则：卡片要像卡片、文字处处可读（对比度 ≥ 4.5） |
| `native_templates.test.js` | 141 | 这一轮修的四个静默失败：标题实测框、comparison 尺寸+takeaway、`body` 别名、timeline 出界、bento 行高、表格行高、鸣谢去重 |
| `helpers/png.js` | 6 | 测试用的最小 PNG 头（避免二进制夹具） |

跑法：`cd pptx/native && npm test`（实测 11.9 s，含 lint）。CI 里同一命令先跑 lint 再跑测试。

---

## 10. 什么进 git、什么不进

| 类别 | 位置 | `.gitignore` 规则 | 重建 |
| --- | --- | --- | --- |
| deck / pdf | 任意 | `*.pptx` `*.pdf` | `node cli.js <spec>` |
| 渲染图 | `render-*/` `preview/` `visual-regression/` | 同名目录模式 | `python scripts/render_check.py` |
| 引擎根目录报告 | `pptx/native/native-*.json` | 同左 | `--report` 生成，**不读回** |
| 运行时图片夹具 | `native-image-assets/` `native-stress-assets/` | 同左 | 各 demo 运行时生成（`sample_image.js`） |
| Python 缓存 | 任意 | `__pycache__/` `*.pyc` | 自动 |
| 交付产物 | `acceptance/` `tea/` | 逐后缀 | 见 6.5 |
| 依赖 | `node_modules/` | 同左 | `npm install` |
| **基线** | `baselines/` `golden/` | **不忽略**（故意） | `golden:update` / `baseline:text-fit` |
| **输入夹具** | `examples/assets/` `native-theme-profile/` | **不忽略**（故意） | 人写/许可合规 |

---

## 11. 本轮整理记录（2026-02）

### 11.1 方法（可复现）

1. `git ls-files` 逐文件列出 106 个跟踪文件，取体积与行数。
2. **引用扫描**：对每个跟踪文件，在其它所有文本文件里找文件名/主干名；零引用的挑出来人工判断（结论：只有 1 个真死文件 + 一批天然入口文件）。
3. **与账本交叉核对**：把 `REMOVAL.md` 声称"已删除"的条目逐条 `Test-Path`，抓到一个仍在磁盘上的（`baselines/reports.json`）。
4. **CI 一致性**：抽出 workflow 里所有 `npm run X` 与 `pptx/...` 路径，逐个核对是否存在（抓到 4 个不存在的 script 名）。
5. **`.gitignore` 反向核对**：列出所有被忽略的路径，问"如果删了它，有什么东西会坏？"（抓到 `native-theme-profile/` 其实是输入）。
6. 清理后用同一套规则复跑，直到零问题；然后把规则固化成 `scripts/check_housekeeping.js`。

### 11.2 删掉的东西（19 个文件 + 7 个目录，**释放 34.7 MB**）

| 删除对象 | 体积 | 为什么是垃圾 |
| --- | --- | --- |
| `pptx/native/--slides.pptx` | 388 KB | **CLI 参数 bug 的产物**：早期版本把未知参数当成输出文件名。bug 早修了，文件留着没人敢删 |
| `pptx/native/[object Object].pptx` | 47 KB | 同类：参数被当成对象后 `String()` 的结果 |
| `pptx/native/native-deck.json` | ~1 KB | `--report` 留下的报告，没有代码读回 |
| 9 个 `native-*-demo.pptx` / `native-cover.pptx` / `native-deck.pptx` | 552 KB | demo 输出；`npm run demo:*` 一条命令重建 |
| `color-showcase.pptx` | 42 KB | 同上（语料里由 `color-showcase` 条目在临时目录重建） |
| `stress40/120/300.pptx` | 11.1 MB | 压力稿；`npm run stress*` 重建。**这是最大的一坨** |
| `tea-deck.pptx` | 3.4 MB | 与 `tea/tea-deck.pptx` 重复（根目录那份是早期试验的残留） |
| `examples/golden-contact-sheet.html` | **5.0 MB** | HTML 时代的截图拼版；全仓库零引用，且 HTML 管线已删除 |
| `scripts/render_with_libreoffice.py` | 4 KB | 与 `render_check.py` 功能重复的死脚本；npm/CI/文档都不引用（已核实 grep） |
| `baselines/reports.json` | 2.2 KB | `REMOVAL.md` 早就声明删除，实际还在；无写者无读者 |
| `preview/`（59 文件） | 4.2 MB | Pillow 预览输出 |
| `render-check/`（47 文件） | 7.2 MB | LibreOffice 渲染输出 |
| `render-wps/`（37 文件） | 2.2 MB | WPS 渲染输出 |
| `render-showcase/`（9 文件） | 1.0 MB | 早期视觉评审的中间产物（已被 `tea/`、`acceptance/` 的拼版取代） |
| `native-image-assets/`（6 文件） | 54 KB | demo 运行时生成的图片（`sample_image.js`） |
| `native-stress-assets/`（3 文件） | 66 KB | 同上 |
| `scripts/__pycache__/`（11 文件） | 172 KB | Python 缓存 |

### 11.3 看着像垃圾、但**必须留**的东西

| 保留项 | 为什么 |
| --- | --- |
| `examples/design-reference.html` + `.css` | 设计语言的**出处**。`themes/presets.js` 的配色/字距/间距/渐变都能在这两份文件里逐条对上；`parity/README.md` 引用它们作为对齐依据 |
| `examples/stress-photo.png`（5.9 KB） | 引擎代码直接引用的小样本图；删了压力稿的图片分支就没输入 |
| `pptx/ooxml/**`（8 文件） | 上游校验器原样引入：`verify`/`unpack`/`pack` 都靠它，重写没有收益 |
| `pptx/scripts/check_slides.py`、`extract_pptx_style.py` | 迁移账本的参照物（见第 8 节）。不可运行 ≠ 无价值 |
| `native/baselines/*.json` | 门禁的"锚点"。删了 `visual_golden` / `check_all_text_fit` 就退化成"每次都通过" |
| `acceptance/deck.json`（101 KB） | 25 页 deck 的**唯一来源**。它很大，但它是输入，不是产物 |

### 11.4 顺手修掉的三个真问题

1. **CI 会必然失败**：workflow 调了 `npm run batch:example` 和 `npm run render:batch`、`render:theme`、`render:parity` 共 4 个**不存在的** script。前两个改名/删除，后两个补进 `package.json`（并并入 `render:all`）。现在 CI 引用的 16 个 script 全部存在。
2. **`native-theme-profile/` 被忽略却是输入**：干净 clone 上 `npm run demo:theme` 必挂，CI 同理。改为入库。
3. **文档与实际不符**：`REMOVAL.md` 声称删掉的 `baselines/reports.json` 还在；`7 decks / 35 pages`（实为 10/65）、`262 boxes`（实为 466）、`25 页 1.15 s`（实测 3.0 s）三处数字过期。全部按实测更新，并注明测量日期。

---

## 12. 自检：`npm run housekeeping`

```powershell
cd pptx\native
npm run housekeeping          # 或者 node scripts/check_housekeeping.js --quiet
```

它检查五件事，任何一条不满足就退出码 1：

| 规则 | 抓到什么 |
| --- | --- |
| CI 一致性 | workflow 里的 `npm run X` 在 `package.json` 里不存在；`pptx/...` 源文件不存在 |
| 生成物越界 | 被跟踪的 `.pptx`/`.pdf`/`.pyc`，或渲染目录里的 `.png`/`.jpg` |
| 游离文件 | `git status` 里的 `??`——既没提交也没被忽略的文件（**"垃圾文件"最准的信号**） |
| 死引用 | 跟踪的文本文件在别处零引用（入口文件用白名单，`tests/`、`ooxml/` 跳过） |
| 图片体积 | 跟踪的图片总量 > 5 MB 就报（防止再往仓库塞 30 MB 照片） |

输出示例（干净时）：

```
tracked files:   106 (4.15 MB)
generated, kept out of git: 6 path(s), 10.1 MB
  ignored  pptx/native/acceptance/storage-2026.pptx
  ...
housekeeping clean: no stray file, no dead reference, no missing CI script
```

**什么时候跑**：加/删任何文件之后，改 `package.json` 的 scripts 之后，改 workflow 之后，以及每次提交前。

拼缩略图（`.pdf`/`.png` 交付物重建的最后一步，本轮用的就是这段）：

```python
from PIL import Image
import glob, os
files = sorted(glob.glob(r"C:\Users\<you>\AppData\Local\Temp\render\*.png"))
cell, cols = (384, 216), 5
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * cell[0], rows * cell[1]), "white")
for index, path in enumerate(files):
    sheet.paste(Image.open(path).convert("RGB").resize(cell, Image.LANCZOS),
                ((index % cols) * cell[0], (index // cols) * cell[1]))
sheet.save("contact-sheet.png")
```

---

## 13. 已知遗留（诚实清单）

| 遗留 | 说明 |
| --- | --- |
| 9.2 MB 交付产物在磁盘上 | `acceptance/` 2 MB + `tea/` 8.5 MB（deck + pdf + 拼版）。故意不入库，但会占工作区 |
| `node_modules/` 14.7 MB | 只有一个运行时依赖链（pptxgenjs + fontkit）；不入库 |
| 2 个不可运行的 HTML 时代脚本 | 见第 8 节，删之前要改 `MIGRATION.md` |
| `acceptance/deck.json` 101 KB / 4025 行 | 单文件 spec 偏大（25 页全在一个 JSON 里）。可拆成每页一文件，但会失去"一份 spec 一眼看全"的优点 |
| 缩略图没有脚本 | `contact-sheet.png` 目前靠上面的 Python 片段生成，还没做成 `scripts/contact_sheet.py` |
| 无 PowerPoint | 所有"打开正常"的结论来自 LibreOffice / WPS / python-pptx 三个阅读器；PowerPoint 的修复提示无法在本机证明 |

---

## 14. 垃圾是怎么产生的（四个真实来源，都有对策）

| 来源 | 现场证据（真实发生过） | 对策 |
| --- | --- | --- |
| **临时调试脚本** | 我这一轮写了几十个 `tmp_*.js` 跑一次性补丁 | 写在仓库根、跑完立刻删；优先用 `%TEMP%`；`check_housekeeping` 的"游离文件"规则会抓 |
| **CLI 参数写错** | `--slides.pptx`、`[object Object].pptx` | 已修 bug；另外任何"输出文件名以 `-` 开头"都该在 `cli.js` 里拒绝 |
| **`--report` / 渲染目录** | `native-deck.json`、`render-check/`、`preview/` 越攒越多 | 已全部进 `.gitignore`；输出目录默认放 `<项目>/render-*` 或 `%TEMP%` |
| **能力升级后未回写文档** | `7 decks/35 pages`、`262 boxes`、`1.15 s`、`render_with_libreoffice.py` | 数字必须带命令；本轮把"数一遍"变成 `limits_report.js` / `check_housekeeping.js` 两个可执行门禁 |

一句话：**能自动检查的规则才留得住**。这一轮除了删文件，真正的产出是 `scripts/check_housekeeping.js` 和这份文档——下次有人（包括我）往仓库里扔东西，`npm run housekeeping` 会当场说话。
