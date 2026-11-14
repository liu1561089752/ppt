#!/usr/bin/env bash
# ChatPPT 云服务器初始化(腾讯云轻量 · Ubuntu 22.04)
# 用法: root 执行  bash setup-cloud.sh
set -euo pipefail

APP_USER=chatppt
APP_HOME=/home/chatppt
APP_DIR=$APP_HOME/app
DATA_DIR=/home/chatppt/data

echo "=== 1. 基础包 ==="
export DEBIAN_FRONTEND=noninteractive
# 时区设为 Asia/Shanghai:每日生成额度按服务器本地时间重置(M-76),
# 文档需同步说明额度重置以北京时间为准。LXC/容器内可能失败,失败不阻断脚本
timedatectl set-timezone Asia/Shanghai 2>/dev/null || {
  echo "[setup] timedatectl 设置时区失败(容器环境常见),请手动确认服务器时区为 Asia/Shanghai"
}
apt-get update -qq
# caddy 单独装(M-77):系统源安装失败不因 set -e 中断整个脚本,
# 回退 Caddy 官方源重试;仍失败则给出明确提示后退出
apt-get install -y curl unzip ca-certificates ufw sqlite3
if ! apt-get install -y caddy; then
  echo "[setup] 系统源安装 caddy 失败,尝试 Caddy 官方源..."
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy || {
    echo "[setup] caddy 安装失败(系统源与官方源均失败)。"
    echo "[setup] 请参考 https://caddyserver.com/docs/install 手动安装后,重新运行本脚本。"
    exit 1
  }
fi

echo "=== 2. 用户与目录 ==="
id -u $APP_USER &>/dev/null || useradd -m -s /bin/bash $APP_USER
mkdir -p $APP_DIR $DATA_DIR /home/chatppt/logs
chown -R $APP_USER:$APP_USER $APP_HOME

echo "=== 3. swap 2G(2G 内存防 OOM) ==="
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "=== 4. bun 与国内镜像 ==="
sudo -u $APP_USER bash -c 'curl -fsSL https://bun.sh/install | bash' || {
  # 国内回退:npmmirror 镜像
  sudo -u $APP_USER bash -c 'curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun" bash -s -- --mirror https://registry.npmmirror.com/-/binary/bun'
}
ln -sf $APP_HOME/.bun/bin/bun /usr/local/bin/bun
# bun 包安装走 npmmirror(国内服务器直连 npmjs 很慢)
sudo -u $APP_USER bash -c 'cat > ~/.bunfig.toml <<EOF
[install]
registry = "https://registry.npmmirror.com"
EOF'

echo "=== 5. 字体(原生引擎用 fontkit 读系统字体度量) ==="
# 引擎是纯 JS,不需要 Chromium/Playwright;但中文字体必须有 —— 缺字体时度量退化为估算,
# PPT 仍能生成,只是 --strict 的贴合度会下降。
apt-get install -y fonts-noto-cjk fonts-noto-color-emoji

echo "=== 6. 内核参数(转换进程多、文件句柄) ==="
cat > /etc/sysctl.d/90-chatppt.conf <<'EOF'
fs.file-max = 65536
vm.swappiness = 10
EOF
sysctl --system >/dev/null

echo "=== 7. systemd 服务 ==="
cat > /etc/systemd/system/chatppt.service <<EOF
[Unit]
Description=ChatPPT Next.js standalone
After=network.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
Environment=NATIVE_BUILD_CONCURRENCY=1
# NATIVE_ENGINE_DIR 走 EnvironmentFile=$APP_DIR/.env(必须绝对路径指向引擎目录)
# 必须显式指定:standalone 启动时 cwd 会切到 .next/standalone,
# 不设 PROJECT_ROOT 会把 db/ 与产物目录解析到构建产物目录(旧仓上线事故根因)
Environment=PROJECT_ROOT=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_HOME/.bun/bin/bun .next/standalone/server.js
Restart=always
RestartSec=5
# 2G 内存:限制转换子进程累计
MemoryHigh=1600M
MemoryMax=1900M
# 文件句柄与进程数上限(转换引擎会大量 fork)
LimitNOFILE=65535
TasksMax=4096
# 生产运维约定:只允许 systemctl restart chatppt,
# 不要手工 bun 起服务 —— 代码默认转换并发 4,2G 内存会 OOM;
# 本单元已显式设 NATIVE_BUILD_CONCURRENCY=1

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

echo "=== 7.1 journald 日志上限(小盘机器防日志吃满磁盘) ==="
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/90-chatppt.conf <<'EOF'
[Journal]
SystemMaxUse=200M
SystemKeepFree=500M
MaxRetentionSec=14day
EOF
systemctl restart systemd-journald

echo "=== 8. 防火墙 ==="
# 只放行 22/80/443;应用进程仅监听 127.0.0.1:3000,不对外
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "=== 9. Caddy 基础配置(备案通过后填真域名) ==="
cat > /etc/caddy/Caddyfile <<'EOF'
# 备案通过后,把下面注释解开并替换成你的域名,再 systemctl reload caddy
# chatppt.example.com {
#     reverse_proxy 127.0.0.1:3000 {
#         # 显式覆盖 X-Forwarded-For:Caddy 默认对 XFF 是追加不剥离,
#         # 不覆盖时客户端可伪造 XFF 污染限流/审计取到的 IP
#         header_up X-Forwarded-For {remote_host}
#     }
# }

# 备案期间临时入口(测试用,直接走 80 端口):
:80 {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-For {remote_host}
    }
}
EOF
systemctl enable --now caddy

echo "=== 完成 ==="
echo "下一步: 上传代码 → bun install → bash scripts/build-linux.sh → 配 .env → systemctl enable --now chatppt"
echo "数据库: bun x prisma db push   (本仓没有 prisma/migrations/,migrate deploy 会失败)"
echo "备份: 数据都在 $DATA_DIR(SQLite)与 $APP_DIR/uploads,请自行配置每日定时备份(如 rsync/cron)。"
echo "原生引擎(必需,与站点一起部署):"
echo "  sudo -u $APP_USER cp -r /path/to/pptx/native $APP_DIR/engine && cd $APP_DIR/engine && sudo -u $APP_USER bun install"
echo "  echo 'NATIVE_ENGINE_DIR=$APP_DIR/engine' >> $APP_DIR/.env"
echo "  node scripts/engine-doctor.mjs    # 构建期也会自动跑,指错会直接失败"
echo "DB 路径请配 DATABASE_URL=file:$DATA_DIR/custom.db"
