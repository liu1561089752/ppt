# 部署与运维

> 本目录 = ChatPPT 站点(Next.js 16 + Prisma/SQLite + bun)。生成 PPT 依赖同仓的原生引擎 `../pptx/native`。
> 生产只跑 Linux;Windows 用于开发与上传。

## 1. 这是什么

- **业务**:管理员发卡密 → 用户兑换积分 → 提交主题生成 PPT → 在线预览 → 下载 `.pptx`;含管理后台(用户/卡密/流水/公告/日志)。
- **生成链路**:`调研(博查/Kimi + Unsplash) → 规划大纲 → LLM 产出 Deck Spec → 原生引擎构建 pptx → 校验 → 交付`。
  站点不含 HTML 幻灯片、不含 Playwright、不含 Tailwind CDN、不含自托管字体——这些随旧转换链一起删除了。
- **站点与引擎的边界**:站点用 `child_process.spawn` 调 `node <engine>/cli.js`。引擎目录自带 `node_modules`
  (pptxgenjs / fontkit / image-size / jszip),与站点依赖互不干扰,升级互不影响。

## 2. 两种运行形态

| 形态 | 代码位置 | 引擎位置 | 构建/启动 |
|---|---|---|---|
| 本地开发 | 任意 | 默认 `../pptx/native`(与站点同仓) | `bun run dev`;`.env` 用相对路径 |
| 云服务器生产 | `/home/chatppt/app` | `/home/chatppt/app/engine`(`NATIVE_ENGINE_DIR` 指向它) | `bash scripts/build-linux.sh` → systemd `chatppt` → Caddy |

## 3. 环境变量

模板见 [`.env.example`](.env.example)。要点:

| 变量 | 生产要求 |
|---|---|
| `JWT_SECRET` | ≥32 字符,缺失服务拒绝启动 |
| `PROJECT_ROOT` | 生产**必须**指向仓库根(如 `/home/chatppt/app`) |
| `DATABASE_URL` | 绝对路径 + 目录先建好,例:`file:/home/chatppt/data/custom.db` |
| `NATIVE_ENGINE_DIR` | **必填**:引擎目录(含 `cli.js`),例 `/home/chatppt/app/engine` |
| `LIBREOFFICE_SOFFICE` | 可选。配了才会生成逐页 PNG 预览/深度版式校验;不配只做引擎结构校验 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | 主力 LLM |
| `BOCHA_API_KEY` | 联网搜索主力 |
| `KIMI_BASE_URL` / `KIMI_API_KEY` / `KIMI_MODEL` | 搜索兜底 + LLM 备用 |
| `UNSPLASH_ACCESS_KEY` | 可选;不配则生成时自动跳过配图 |
| `TRUST_PROXY` | 反代后为 true;3000 直接暴露公网时必须 false |

**每台机器各持一份 .env,禁止跨机复制**——`PROJECT_ROOT` / `DATABASE_URL` / `NATIVE_ENGINE_DIR` 都是环境相关路径。

## 4. 数据库

```bash
bun run db:push                       # 同步 schema(本仓无 prisma/migrations/)
ADMIN_PASSWORD='<至少8位>' bun scripts/seed-admin.mjs   # 初始化管理员(余额 999)
bun scripts/reset-db.mjs [--db-only]  # 清业务数据、保留管理员,自动备份
```

任务表与预览相关的两列:

| 列 | 内容 |
|---|---|
| `deckSpec` | 整份 Deck Spec JSON(预览与重下载的唯一来源) |
| `engineReport` | 引擎构建报告 JSON:`warnings` / `objects` / `bytes` / `layout`(逐页最终几何) |

> ⚠️ `prisma migrate deploy` 在本仓不适用(没有迁移历史)。schema 变更只有 `db push`,没有版本审计与回滚点。

## 5. 构建与发布

```bash
bash scripts/build-linux.sh    # tsc --noEmit → next build → static/public 同步 → engine-doctor 探针
sudo systemctl restart chatppt
curl -s http://127.0.0.1:3000/api/health
```

`build-linux.sh` 是**唯一**构建入口,它比 `bun run build` 多做两件事:引擎就绪探针(`--check` 真跑一遍),
以及删掉 Next 复制进 standalone 的 `.env`(密钥泄漏)。

发布冒烟(真实生成 → 下载 → 解包断言):

```bash
BASE_URL=http://127.0.0.1:3000 SMOKE_USER=admin SMOKE_PASS='<口令>' bun run smoke
```

改动提示词、引擎或 spec 结构时必须跑。无密钥的机器用 mock 链路验收:

```bash
bun run engine:doctor && bun run e2e:native && bun run e2e:pipeline
```

## 6. 目录速览

| 路径 | 说明 |
|---|---|
| `src/app/api/**` | 32 个接口(auth / redeem / generate / tasks / download / **spec** / credits / announcements / admin / health) |
| `src/lib/pipeline/**` | `native.ts`(引擎桥)· `spec.ts`(S4)· `plan.ts`(S3)· `research.ts`(S2)· `theme.ts`(预设)· `mock.ts` · `events.ts` · `credits.ts` · `index.ts`(编排) |
| `src/lib/*.ts` | 配置(config)、数据库(db)、鉴权(jwt/session/password)、限流、外部服务(kimi/search/unsplash)、文件存储、维护 |
| `src/components/**` | 视图(landing / generate / chat / history / profile / redeem / admin);预览是 `deckSpec + engineReport.layout` 的纸卡渲染 |
| `scripts/**` | `build-linux.sh` · `engine-doctor.mjs` · `e2e-native.ts` · `e2e-pipeline.ts` · `release-smoke.mjs` · `reset-db.mjs` · `seed-admin.mjs` |
| `deploy/cloud/**` | 云服务器部署(初始化脚本 + 指南 + 上传脚本) |
| `data/generated/**` | 运行时产物(pptx),gitignore |

## 7. 纪律

1. `.env` 每机一份,禁止手工拷贝;新增字段同步改 `.env.example`。
2. 代码用 git 同步,**禁止手工 cp 源码**到生产目录。
3. 生产构建只走 `scripts/build-linux.sh`(引擎探针 + 密钥清理都在里面)。
4. 发版先跑发布冒烟;改引擎或提示词必须跑。
5. 引擎目录必须与站点一起部署,`NATIVE_ENGINE_DIR` 指错时 `engine-doctor` 会在构建期失败,不要绕过它。
6. schema 变更后记得 `bun run db:generate`(Prisma client 不跟着 schema 自动更新)。

## 8. 已知边界

- **没有 PowerPoint 的机器无法证明**「双击打开不弹修复提示」。本机验证手段是 LibreOffice / WPS / python-pptx 三个阅读器 + 引擎的结构校验。
- 引擎画不出来的东西逐条列在 `../pptx/native/LIMITS.md`(由引擎代码生成),不要在站点侧假装能画。
- 预览是 **spec 级纸卡**(几何取自引擎 `layout` 报告),不是位图;若配置了 `LIBREOFFICE_SOFFICE`,可另接 PNG 预览而不改链路。
