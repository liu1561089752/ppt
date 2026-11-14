# ChatPPT —— 原生 PPTX 生成站

用户提交主题 → 联网调研 + LLM 规划 → LLM 产出 **Deck Spec(JSON)** → 原生引擎生成**可编辑的 `.pptx`** → 在线预览 + 下载。
配套卡密兑换积分、任务历史、管理后台(用户 / 卡密 / 流水 / 公告 / 日志)。

- **技术栈**:Next.js 16(standalone)· React 19 · Prisma + SQLite · Tailwind v4 · bun
- **LLM / 服务**:DeepSeek(主力)· 博查搜索(主力)· Kimi(兜底)· Unsplash(配图)
- **生成引擎**:仓库内原生引擎 `pptx/native`(纯 JS,产物是真正的 DrawingML:文字、表格、图表、图片都是原生对象)
- **运行环境**:生产 Linux(Ubuntu 22.04 / 24.04)。`config.ts` 只在生产拦 Windows 风格路径,开发机(Windows)可正常 `bun run dev`

## 生成链路

```
S2 调研   Bocha / Kimi 搜索 + Unsplash 取图        → facts + images
S3 规划   LLM 出大纲(主题预设 + 页面原型 + 每页要点)  → OutlinePlan
S4 规格   LLM 出完整 Deck Spec(JSON)              → 引擎 schema 校验,不过则带错误重试 ≤3 次
S5 构建   node <engine>/cli.js spec.json out.pptx  → 原生 pptx + 构建报告(warnings/objects/bytes/几何)
S6 交付   落标准位 + 下载 token,deckSpec/engineReport 入库供预览
```

一次 8 页的真实运行(本机实测):**2.0 s 构建,175 KB,`warnings 0`**,对象普查 `text 36 · container 8 · shape 2 · chart 1 · table 1 · image 1`。

> 旧链路(LLM 渲染 HTML → `html2pptx1.js` 转换 → 几何修复)已整体删除:站点不含 HTML 幻灯片、不含 Playwright 截图、不含 Tailwind CDN 与自托管字体,`skills/` 目录已移出。引擎的契约(能画什么、画不出来什么)见 `pptx/SKILL.md` 与 `pptx/native/LIMITS.md`。

## 文档

| 文档 | 内容 |
|---|---|
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | 部署与运维:运行形态、环境变量、数据库、构建、验证、纪律 |
| [`deploy/cloud/DEPLOY-CLOUD.md`](deploy/cloud/DEPLOY-CLOUD.md) | 云服务器(Ubuntu + Caddy + systemd)全流程 |

## 快速开始(本地开发)

```bash
bun install
cp .env.example .env                 # JWT_SECRET、DATABASE_URL=file:../db/custom.db、LLM/搜索密钥
mkdir -p db && bun run db:push       # 同步 schema 到 SQLite
ADMIN_PASSWORD='<至少8位>' bun scripts/seed-admin.mjs
bun run dev                          # http://localhost:3000
```

开发机需要引擎在 `../pptx/native`(与站点同仓的兄弟目录);若放在别处,设 `NATIVE_ENGINE_DIR`。

## 验证(不依赖任何 API Key)

```bash
bun run engine:doctor                 # 引擎就绪探针:根目录 + 依赖 + 最小 spec --check
bun run e2e:native                    # 固定 spec → 真构建 → OOXML 完整性
bun run e2e:pipeline                  # mock LLM 跑完整管线(真引擎 + 真 DB),断言任务 succeeded
bun run verify                        # 上面三步 + typecheck + lint,一条命令全跑
```

`e2e:pipeline` 默认走 mock LLM(`NATIVE_MOCK_LLM`),不花一分钱、不需要密钥;加 `--real` 才走真实模型。

## 目录

```
src/app/api/         32 个接口(auth / redeem / generate / tasks / download / spec / credits / admin / health)
src/lib/pipeline/    生成管线:native(引擎桥) · spec(S4) · plan(S3) · research(S2) · theme · mock · events · credits
src/lib/             配置、鉴权、限流、外部服务客户端、文件存储、维护任务
src/components/      前端视图与 UI 组件(预览为基于 Deck Spec 的纸卡渲染)
scripts/             构建、发布冒烟、引擎探针、两个 e2e、清库、播种管理员
deploy/cloud/        云服务器部署(初始化脚本 + 指南 + 上传脚本)
prisma/              schema(SQLite)
```

站点与引擎的边界:站点**只通过 CLI 子进程**调用引擎(`node <engine>/cli.js`),不 import 引擎源码,
因此引擎自带的 `node_modules`(pptxgenjs / fontkit / image-size / jszip)与站点依赖完全隔离。
