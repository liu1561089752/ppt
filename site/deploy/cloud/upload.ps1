# ChatPPT 代码上传(Windows 本机执行 · 可选路径,推荐用 git clone 代替)
# 用法: 1) 改 $Server  2) powershell -File deploy\cloud\upload.ps1
# 依赖: Windows 10+ 自带 tar / OpenSSH(scp, ssh)
#
# 打包对象是本仓当前工作树(= Linux 版代码)。.env 永不随包上传:
# 本机 .env 里的 PROJECT_ROOT / DATABASE_URL 是 Windows 路径,拷到服务器会让
# src/lib/config.ts 的启动校验直接拒绝服务(所以脚本只做上传,不做密钥搬运)。

$Server = 'root@1.2.3.4'          # TODO: 改成你的服务器 IP
$Src    = 'F:\native-ppt-engine\site'
$Engine = 'F:\native-ppt-engine\pptx\native'   # 原生引擎(纯 JS,依赖在服务器上 bun install)
$EnginePkg = "$env:TEMP\chatppt-engine.tar.gz"
$Pkg    = "$env:TEMP\chatppt-src.tar.gz"

# ---- 打包源码(exclude 必须带 ./ 前缀, 否则不生效) ----
Remove-Item $Pkg -ErrorAction SilentlyContinue
tar -czf $Pkg `
    --exclude='./node_modules' --exclude='./.next' --exclude='./.work' `
    --exclude='./db' --exclude='./data' --exclude='./download' `
    --exclude='./.git' --exclude='./deploy/logs' `
    --exclude='./.env' --exclude='*.tsbuildinfo' `
    -C $Src .
"包大小: {0:N1} MB" -f ((Get-Item $Pkg).Length / 1MB)

# ---- 打包原生引擎(与站点一起部署;排除测试/基线/交付产物与平台相关的 node_modules) ----
Remove-Item $EnginePkg -ErrorAction SilentlyContinue
tar -czf $EnginePkg `
    --exclude='./node_modules' --exclude='./tests' --exclude='./baselines' `
    --exclude='./golden' --exclude='./acceptance' --exclude='./tea' `
    --exclude='./scripts/__pycache__' --exclude='./.git' `
    -C $Engine .
"引擎包大小: {0:N1} MB" -f ((Get-Item $EnginePkg).Length / 1MB)

# ---- 上传并解包(先清空目标目录再解包,避免已删除模块永久留在生产) ----
# 注意:.env(服务器密钥)与 data/(生成产物,/home/chatppt/app/data/generated)必须保留,
# 清掉会让线上丢密钥/丢用户产物,比残留旧模块严重得多。
scp $Pkg "${Server}:/tmp/chatppt-src.tar.gz"
scp $EnginePkg "${Server}:/tmp/chatppt-engine.tar.gz"
ssh $Server "mkdir -p /home/chatppt/app/engine && cd /home/chatppt/app && find . -mindepth 1 -maxdepth 1 ! -name '.env' ! -name 'data' ! -name 'engine' -exec rm -rf {} + && tar -xzf /tmp/chatppt-src.tar.gz && cd engine && tar -xzf /tmp/chatppt-engine.tar.gz && chown -R chatppt:chatppt /home/chatppt/app && rm -f /tmp/chatppt-src.tar.gz /tmp/chatppt-engine.tar.gz"

# ---- 服务器初始化(首次执行;重复执行无害,脚本内部有幂等判断) ----
ssh $Server "bash -s" < "$Src\deploy\cloud\setup-cloud.sh"

Write-Host @'
上传与初始化完成。后续 SSH 进服务器(chatppt 用户):
  1. cd /home/chatppt/app && bun install && cd engine && bun install && cd ..
     bash scripts/build-linux.sh
     # 用脚本而不是 bun run build:它额外跑引擎就绪探针并删掉产物里的 .env
  2. cp .env.example .env && vi .env
     # 必填: JWT_SECRET / PROJECT_ROOT=/home/chatppt/app / DATABASE_URL=file:/home/chatppt/data/custom.db
     #       NATIVE_ENGINE_DIR=/home/chatppt/app/engine
     #       DEEPSEEK_API_KEY / BOCHA_API_KEY / KIMI_API_KEY / UNSPLASH_ACCESS_KEY(可选)
     # 切勿从本机拷贝 .env:本机是 Windows 路径,启动校验会拒绝服务
  3. bun x prisma db push                # 本仓无 prisma/migrations/,不要用 migrate deploy
  4. sudo -u chatppt env ADMIN_PASSWORD='<强口令>' bun scripts/seed-admin.mjs
      # 已存在时仅提示;重置密码需加 --reset(同传 ADMIN_PASSWORD)
  5. sudo systemctl enable --now chatppt && curl -s localhost:3000/api/health
'@
