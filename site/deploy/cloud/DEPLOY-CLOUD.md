# ChatPPT 云服务器部署(腾讯云轻量 · Ubuntu · Caddy + systemd)

> 这是本项目**唯一的部署路径**(2026-10-10 起)。本仓只支持 Linux 部署:
> 启动校验 `src/lib/config.ts:assertEnvSafety()` 会拒绝 Windows 风格路径,Windows 侧只用于编辑代码与上传。
> 此前的 Windows 原生面板(cloudflared 隧道)与 WSL 内生产副本已退役,相关脚本/日志已从本仓移除。

## 0. 购买清单

| 项 | 选择 | 说明 |
|---|---|---|
| 机型 | 轻量应用服务器 2核2G | 国内(北京/上海/广东任一) |
| 系统镜像 | Ubuntu 22.04 / 24.04 LTS | 24.04 需 `libasound2t64`,脚本已自动适配 |
| 域名 | 在腾讯云买一个(¥20-80/年) | **免费域名无法备案**;买完做实名认证 |
| 备案 | 腾讯云控制台 → ICP 备案 | 用这台服务器做备案主体,1-2 周;期间用 IP:80(Caddy 入口)测试 |
| 防火墙 | 腾讯控制台放行 22/80/443 | 应用只监听 127.0.0.1:3000,**不需要**放行 3000 |

## 1. 初始化服务器(root,SSH)

```bash
# 上传 deploy/cloud/setup-cloud.sh 后执行(或直接粘贴内容)
bash setup-cloud.sh
```

脚本做的事:创建 `chatppt` 用户与目录(`/home/chatppt/app`、`/home/chatppt/data`)、2G swap、
安装 bun(含 npmmirror 回退)与 Caddy、安装 `fonts-noto-cjk`(原生引擎的文字度量依赖它)、
内核参数、ufw、以及 systemd 单元 `/etc/systemd/system/chatppt.service`。

## 2. 上传代码(二选一,A 为推荐做法)

**A. git 拉取(推荐,保证与仓库一致)**

```bash
sudo -u chatppt git clone https://github.com/liu1561089752/chatppt-v2.git /home/chatppt/app
# 后续更新: cd /home/chatppt/app && sudo -u chatppt git pull --ff-only
```

**B. tar + scp(服务器上没有 git 或不想放仓库地址时)**

```powershell
# Windows 本机:改 deploy/cloud/upload.ps1 顶部的 $Server 后执行
powershell -File deploy\cloud\upload.ps1
```

包内排除:`node_modules`、`.next`、`db`、`data`、`download`、`.env`、`deploy/logs*`。
**.env 永不随包上传**(密钥另配,见第 4 步)。

## 3. 构建(服务器上,chatppt 用户)

```bash
cd /home/chatppt/app
sudo -u chatppt bun install
sudo -u chatppt bash scripts/build-linux.sh      # tsc 类型检查 + next build + 资源/引擎同步
```

`scripts/build-linux.sh` 做的事(= 手工步骤,漏做会导致线上生成 500):

```bash
bun node_modules/typescript/bin/tsc --noEmit
bun node_modules/next/dist/bin/next build
cp -r .next/static .next/standalone/.next/
cp -r public .next/standalone/          # 只剩图标等少量静态资源
node scripts/engine-doctor.mjs          # 原生引擎就绪探针:根目录 + 依赖 + 最小 spec --check
rm -f .next/standalone/.env             # Next 会复制 .env 进产物,必须删(密钥泄漏)
```

> 注意:`bun run build`(package.json)只做 Next 构建,没有引擎探针也没有 `.env` 清理,生产请用上面的脚本。

### 原生引擎必须与站点一起部署

站点不再自带转换器,生成靠兄弟目录的原生引擎(默认 `../pptx/native`)。生产推荐放在
`/home/chatppt/app/engine`,并在 `.env` 里显式指定绝对路径:

```bash
sudo -u chatppt cp -r /path/to/pptx/native /home/chatppt/app/engine
cd /home/chatppt/app/engine && sudo -u chatppt bun install      # 引擎自带依赖:pptxgenjs/fontkit/image-size/jszip
echo 'NATIVE_ENGINE_DIR=/home/chatppt/app/engine' | sudo -u chatppt tee -a /home/chatppt/app/.env
```

引擎目录必须含 `cli.js`、`index.js`、`core/`、`engine/`、`components/`、`templates/`、`themes/` 及其 `node_modules`。
指错时 `engine-doctor` 会在**构建期**失败,不要绕过它去上线。

## 4. 环境变量

```bash
sudo -u chatppt cp .env.example .env
sudo -u chatppt vi .env
```

必填项与要点(完整说明见 `.env.example`):

| 变量 | 值 | 说明 |
|---|---|---|
| `JWT_SECRET` | `openssl rand -hex 32` | 缺失服务拒绝启动 |
| `PROJECT_ROOT` | `/home/chatppt/app` | **不设 = 产物与引擎目录落到 `.next/standalone` 里**(旧仓上线事故根因) |
| `DATABASE_URL` | `file:/home/chatppt/data/custom.db` | 目录先 `mkdir -p /home/chatppt/data` |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | DeepSeek 官方 | 主力 LLM |
| `BOCHA_API_KEY` | 博查 | 联网搜索主力 |
| `KIMI_API_KEY` / `KIMI_BASE_URL` / `KIMI_MODEL` | Moonshot | 搜索兜底 + LLM 备用 |
| `UNSPLASH_ACCESS_KEY` | Unsplash | 可选,不配则跳过配图 |
| `NATIVE_ENGINE_DIR` | `/home/chatppt/app/engine` | **必填**:原生引擎目录(含 cli.js) |
| `NATIVE_BUILD_CONCURRENCY` | `1` | 同时跑的引擎子进程数;2 核 2G 保持 1 |
| `LIBREOFFICE_SOFFICE` | 可选 | 配了才生成逐页 PNG 预览/深度校验;不配只做引擎结构校验 |

| `TRUST_PROXY` 默认**不信任** XFF(安全缺省;未启用时所有请求按 `direct` 共享限流桶)。云服务器部署在 Caddy 反代之后,必须显式设 `TRUST_PROXY=true`(届时取 XFF 最右段);若把 3000 直接暴露公网则保持不设。 |

额度重置说明:每日生成额度按服务器本地时间(脚本已设为 `Asia/Shanghai`)在零点重置。

## 5. 数据库

```bash
cd /home/chatppt/app && sudo -u chatppt bun x prisma db push
```

> ⚠️ 本仓**没有 `prisma/migrations/`**,`prisma migrate deploy` 会直接失败。
> 现阶段用 `db push` 同步 schema;schema 变更即无迁移历史、无审计(见 `agent-ctx/12-linux-site-gap-analysis.md`)。

要沿用家里那套已有数据(可选):本机导出后上传,再 `db push`

```bash
scp /home/chatppt/chatppt-v2/db/custom.db chatppt@<IP>:/home/chatppt/data/custom.db
```

首次或需要重置时,初始化管理员与清库:

```bash
sudo -u chatppt env ADMIN_PASSWORD='<强口令>' bun scripts/seed-admin.mjs
sudo -u chatppt bun scripts/reset-db.mjs --db-only     # 清业务数据,保留管理员(自动备份)
```

> 密码轮换:管理员已存在时重跑脚本默认只提示不改动;重置密码需带 `--reset`
> (`ADMIN_PASSWORD=新密码 bun scripts/seed-admin.mjs --reset`,旧会话全部失效)。

## 6. 引擎与字体

原生引擎是纯 JS(无浏览器、无 Chromium),**不需要** `playwright install`。它需要的是:

1. **CJK 字体**:引擎用 fontkit 读系统字体做真实度量,缺中文字体会退化成估算(布局仍能出,但 `--strict` 的贴合度会下降)。
   `setup-cloud.sh` 已装 `fonts-noto-cjk`。
2. **引擎目录与依赖**:见第 3 节的「原生引擎必须与站点一起部署」。

可选:LibreOffice(只在你要逐页 PNG 预览或深度版式校验时才需要)

```bash
apt-get install -y libreoffice-impress poppler-utils
# .env: LIBREOFFICE_SOFFICE=/usr/bin/soffice
```

## 7. 启动与验收

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chatppt
sudo systemctl status chatppt --no-pager
curl -fsS http://127.0.0.1:3000/api/health      # 期望 200 且顶层 "ok":true(如 {"ok":true,...});503 = env/db 异常
```

验收清单:

- [ ] `/api/health` 返回 ok,`journalctl -u chatppt -n 50` 无异常
- [ ] 管理员可登录,首页/登录/生成/历史/下载全流程通过
- [ ] 发起一次 8 页生成,全链路成功并下载 PPTX(建议直接跑发布冒烟,见下)
- [ ] 手机 4G(非 WiFi)访问正常 —— 这是迁云的核心目标
- [ ] `free -h` 确认 swap 生效;转换大任务不 OOM(`MemoryMax=1900M` 生效后不会拖死整机)
- [ ] 观察一天:内存、月流量(腾讯控制台)符合预期

发布冒烟(真实生成→下载→解包断言,含背景四角 alpha 校验):

```bash
sudo -u chatppt env BASE_URL=http://127.0.0.1:3000 SMOKE_USER=admin SMOKE_PASS='<管理员口令>' \
  bun scripts/release-smoke.mjs
```

## 8. 域名 + HTTPS(备案通过后)

```bash
sudo vi /etc/caddy/Caddyfile
#   chatppt.<你的域名> {
#       reverse_proxy 127.0.0.1:3000
#   }
sudo systemctl reload caddy
# DNS:在腾讯云 DNSPod 加 A 记录 → 服务器 IP;Caddy 自动签发 Let's Encrypt 证书
```

## 9. 日常更新(固定流程,禁止手工 cp 文件)

```bash
cd /home/chatppt/app
sudo -u chatppt git pull --ff-only          # 或重新执行 upload.ps1
sudo -u chatppt bun install                 # 仅依赖变化时需要
sudo -u chatppt bash scripts/build-linux.sh
sudo systemctl restart chatppt
curl -fsS http://127.0.0.1:3000/api/health
```

**部署期间实测的两个坑(2026-10-11,避免重蹈):**

1. **`/etc/caddy/Caddyfile` 不随代码上传**(upload.ps1 只同步 `/home/chatppt/app`)。
   `setup-cloud.sh` 只在**首次初始化**时写它;此后若仓库里的 Caddyfile 模板改了
   (如 M-69 把 `:3000` 改 `:80`),需要**手动**把 `setup-cloud.sh` 里的 heredoc
   段重新贴到服务器 `/etc/caddy/Caddyfile` 并 `systemctl reload caddy`,
   否则线上仍是旧入口(本次实测:公网 404 而本机 200,即此因)。
2. **`header_up` 必须写在 `reverse_proxy { }` 块内**——写在 site 块顶层会
   `unrecognized directive: header_up`,reload 直接失败,网站全下线。
   手改 Caddyfile 后先 `caddy validate --config /etc/caddy/Caddyfile` 再 reload。
   另外 `systemctl reload caddy` 失败时旧进程仍在跑(表象是"配置没生效"而非"宕机"),
   排查时先看 `journalctl -u caddy --since '5 minutes ago'`。

## 10. 备份与回滚

```bash
# 数据库(含 WAL):先停服务再拷,或用 sqlite3 在线备份
sudo systemctl stop chatppt
sudo -u chatppt sqlite3 /home/chatppt/data/custom.db ".backup '/home/chatppt/data/custom.db.bak-$(date +%F)'"
sudo systemctl start chatppt
```

- 产物目录:`/home/chatppt/app/data/generated`(30 天保留由维护任务自动清理——已通过 instrumentation + db 兜底双钩子注册,15s 首轮/每日清理)
- 回滚:`sudo -u chatppt git reset --hard <旧 commit>` → 重新构建 → 重启
- 建议加一条每日 `crontab` 备份 DB 并保留 7 份(**当前没有**,见梳理报告)
- 排查用户口令:仓库自带 `deploy/cloud/check-users.sql`,在服务器上执行

  ```bash
  sudo -u chatppt sqlite3 /home/chatppt/data/custom.db < /home/chatppt/app/deploy/cloud/check-users.sql
  ```

## 11. 与旧部署方式的关系(已退役)

本仓曾有三套入口:Windows 原生面板 + cloudflared 隧道、WSL 内生产副本、云服务器。2026-10-10 起只保留云服务器:

| 已退役 | 位置(归档) | 现状 |
|---|---|---|
| Windows 原生面板 / 隧道启停(`control-panel.ps1`、`控制面板.cmd`、`build.cmd`) | `F:\ppt\_archive\chatppt-v1-windows-era-20261010\deploy\` | 不再需要,已停用 |
| WSL 启停与保活(`wsl-panel.ps1`、`watchdog.ps1`、启停 `.cmd`) | 同上 `deploy\wsl\` | 不再需要,已停用 |
| WSL 内生产副本 `~/chatppt-v2` | WSL 磁盘 | 仅作历史参考,**不再部署** |

仓库里**只有一份**构建逻辑:`scripts/build-linux.sh`(路径自动推导),不要在任何地方再复制第二份。
