#!/usr/bin/env bash
#
# 一键部署脚本（单机 Linux，阿里云/腾讯云轻量服务器通用）
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/huangfeng1995/CuriosityTrail/main/deploy/deploy.sh | bash
#
# 或者已经 clone 了仓库：
#   bash deploy/deploy.sh
#
# 带域名（自动 HTTPS）：
#   bash deploy/deploy.sh 你的域名 你的邮箱
#
# 注意：sudo 默认会清空环境变量（env_reset），所以
#   sudo DOMAIN=x bash deploy.sh   ← 这里的 DOMAIN 传不进去
# 用位置参数，或 sudo -E：
#   bash deploy/deploy.sh 你的域名 你的邮箱
#
# 做的事：
#   1. 检查并安装 Docker + Docker Compose
#   2. 克隆/更新仓库
#   3. 生成 .env.production（密码、JWT 密钥自动生成）
#   4. 构建镜像并启动
#   5. 安装配置 Caddy（自动 HTTPS）
#   6. 健康检查
#
# 幂等：重复跑安全。已存在的内容不会重复生成。

set -euo pipefail

REPO_URL="https://github.com/huangfeng1995/CuriosityTrail.git"
INSTALL_DIR="/opt/curiosity-trail"

# 本脚本的真实路径。git reset --hard 可能把正在执行的脚本自己覆盖掉，
# bash 会按文件偏移继续往下读，结果跑到错位的分支上。
# 所以更新完代码后用这个路径重新 exec 一遍自己。
SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || true)"

# 域名与邮箱：位置参数优先于环境变量
# （sudo 默认 env_reset，环境变量方式不可靠，位置参数最稳）
DOMAIN="${1:-${DOMAIN:-}}"
EMAIL="${2:-${EMAIL:-admin@example.com}}"

log()  { echo -e "\n\033[1;36m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m[警告] $*\033[0m"; }
die()  { echo -e "\033[1;31m[错误] $*\033[0m" >&2; exit 1; }

# 必须 root
if [[ "${EUID}" -ne 0 ]]; then
	# 轻量服务器默认就是 root 登录。如果不是，重新用 root 跑：
	#   sudo bash deploy/deploy.sh 你的域名 你的邮箱
	die "需要 root 权限。轻量服务器默认就是 root 登录；若不是，请用：
  sudo bash deploy/deploy.sh 你的域名 你的邮箱
（注意 sudo 会清空环境变量，域名请用位置参数传）"
fi

# ---------------------------------------------------------------------------
# 1. Docker
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
	log "安装 Docker"
	if command -v apt-get >/dev/null 2>&1; then
		apt-get update -qq
		apt-get install -y -qq ca-certificates curl gnupg
		install -m 0755 -d /etc/apt/keyrings
		curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
			| gpg --dearmor -o /etc/apt/keyrings/docker.gpg
		chmod a+r /etc/apt/keyrings/docker.gpg
		echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
			> /etc/apt/sources.list.d/docker.list
		apt-get update -qq
		apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	elif command -v yum >/dev/null 2>&1; then
		yum install -y -q docker docker-compose-plugin
		# CentOS/RHEL 系需要手动启动
		systemctl enable --now docker
	else
		die "未识别的包管理器，请手动安装 Docker 后重跑本脚本"
	fi
fi
systemctl enable --now docker 2>/dev/null || true
docker compose version >/dev/null 2>&1 || die "缺少 docker compose 插件（docker-compose-plugin）"

# ---------------------------------------------------------------------------
# 2. 代码
# ---------------------------------------------------------------------------
if [[ -d "$INSTALL_DIR/.git" ]]; then
	log "更新已有代码"
	cd "$INSTALL_DIR"
	git fetch --all --tags
	git reset --hard origin/main
	# 脚本自己可能被这次 reset 换掉了（内容变了的话，bash 继续按旧偏移读会跑错）。
	# 重新 exec 一遍新的自己，位置参数原样传下去。
	# CT_DEPLOY_REEXEC 是守卫：重新执行后不会再触发，否则会无限循环。
	if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" && "${CT_DEPLOY_REEXEC:-0}" != "1" ]]; then
		log "代码已更新，重新执行最新脚本"
		export CT_DEPLOY_REEXEC=1
		exec bash "$SCRIPT_PATH" "$@"
	fi
else
	log "克隆仓库到 $INSTALL_DIR"
	mkdir -p "$INSTALL_DIR"
	cd "$INSTALL_DIR"
	if git clone "$REPO_URL" . 2>/dev/null; then
		:
	else
		# 没有 git 或者 clone 失败时，退化为下载 tar 包
		warn "git clone 失败，改用 tar 包下载"
		rm -rf ./*
		curl -fsSL "https://codeload.github.com/huangfeng1995/CuriosityTrail/tar.gz/refs/heads/main" \
			| tar xz --strip-components=1
	fi
fi

mkdir -p data data-offsite

# 记忆服务的落盘目录。容器内以 uid 10001 运行（见 web/memory-service/Dockerfile），
# 宿主机目录若归 root，sidecar 启动会 PermissionError: '/app/data/viking/_system'。
mkdir -p data/viking && chown -R 10001:10001 data/viking

# ---------------------------------------------------------------------------
# 3. 环境变量
# ---------------------------------------------------------------------------
ENV_FILE="$INSTALL_DIR/deploy/.env.production"
if [[ ! -f "$ENV_FILE" ]]; then
	log "生成环境变量文件"
	cat > "$ENV_FILE" <<EOF
# 自动生成于 $(date '+%Y-%m-%d %H:%M:%S')
# 权限 600，仅 root 可读

# 会话签名密钥。保持不变，改了会让所有人重新登录。
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')

# 阿里云短信（登录要用）。四项都要填，否则用户收不到验证码。
# 模板变量必须是 \${code}，例如：「您的验证码为\${code}，5分钟内有效。」
ALIYUN_SMS_ACCESS_KEY_ID=
ALIYUN_SMS_ACCESS_KEY_SECRET=
ALIYUN_SMS_SIGN_NAME=
ALIYUN_SMS_TEMPLATE_CODE=

# 临时：短信还没配好时，给指定手机号开一个固定验证码通道。
# 两项都填才生效；SMS_FIXED_PHONE 支持多个号码，用逗号分隔。
# 短信配好后删掉这两行、docker compose up -d，后门就没了。
SMS_FIXED_CODE=
SMS_FIXED_PHONE=

# DeepSeek API Key（https://platform.deepseek.com 创建）。
# 没有它 AI 对话不可用，会回退到本地 Ollama。
DEEPSEEK_API_KEY=

# 长期记忆（viking sidecar）。sidecar 已迁到 openviking 0.2.11（Linux 可装），
# 默认开启；sidecar 起不来时 Node 侧自动降级，对话照常。
MEMORY_ENABLED=true
EOF
	chmod 600 "$ENV_FILE"
	echo "    已生成 $ENV_FILE"
	echo "    登录方式：手机号 + 短信验证码（需先填好上面的阿里云短信配置）"
else
	log "环境变量文件已存在，保留原值"
fi

# 老服务器上的 .env.production 是之前生成的，没有 MEMORY_ENABLED。
# 补一行默认关闭：老机器的 /opt/curiosity-trail/data 未必有 sidecar 依赖，
# 先别自动打开。确认冒烟测试通过后手动改成 true 即可。
# 已经有这个键就不动——用户主动改过的值不能被覆盖。
if ! grep -q '^MEMORY_ENABLED=' "$ENV_FILE"; then
	echo 'MEMORY_ENABLED=false' >> "$ENV_FILE"
fi

# 记忆服务自己的环境文件：ARK key 只给 sidecar，绝不进 app 容器。
MEM_FILE="$INSTALL_DIR/deploy/.env.memory"
if [[ ! -f "$MEM_FILE" ]]; then
	log "生成记忆服务环境变量文件"
	# 复用 app 环境文件里已有的 ARK key（通常没有，那就留空待填）
	ark=$(grep -m1 '^ARK_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
	cat > "$MEM_FILE" <<EOF
# 自动生成于 $(date '+%Y-%m-%d %H:%M:%S')
# 只给记忆服务容器使用，不进 app 容器，也不进版本库。

# 火山方舟 embedding 凭据（vision 模型，唯一可用的一类）
ARK_API_KEY=${ark}
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_EMBEDDING_MODEL=doubao-embedding-vision-251215
ARK_EMBEDDING_INPUT=multimodal
ARK_EMBEDDING_DIM=2048

# 索引数据目录（派生数据，可随时重建）
VIKING_DATA_DIR=/app/data/viking
VIKING_PORT=8019
VIKING_EMBED_TIMEOUT_SECONDS=10
VIKING_INDEX_TIMEOUT_SECONDS=8
VIKING_LOG_LEVEL=WARNING
EOF
	chmod 600 "$MEM_FILE"
	echo "    已生成 $MEM_FILE"
	if [[ -z "$ark" ]]; then
		warn "记忆服务还缺 ARK_API_KEY：填进 $MEM_FILE 后 docker compose up -d memory。"
		warn "在此之前记忆层不可用（对话、写作不受影响）"
	fi
else
	log "记忆服务环境变量文件已存在，保留原值"
fi

# ---------------------------------------------------------------------------
# 4. 构建并启动
# ---------------------------------------------------------------------------
log "构建 app 镜像（首次约 3-8 分钟，取决于服务器到 npm 源的速度）"
docker compose build app

# 记忆服务单独构建：openviking 的依赖较重，2 核 / 1.7G 的机器上有可能失败。
# 它失败了不能连累 app 上线，所以单独 try 一次，只做降级提示。
memory_ok=1
log "构建记忆服务镜像"
docker compose build memory || memory_ok=0
if [[ "$memory_ok" -eq 0 ]]; then
	warn "记忆服务镜像构建失败：本次只启动 app，记忆层不可用（对话与写作不受影响）"
fi

log "启动服务"
docker compose up -d app
if [[ "$memory_ok" -eq 1 ]]; then
	docker compose up -d memory
fi

# ---------------------------------------------------------------------------
# 5. Caddy
# ---------------------------------------------------------------------------
if [[ -n "$DOMAIN" ]]; then
	if ! command -v caddy >/dev/null 2>&1; then
		log "安装 Caddy"
		apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
		curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
			| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
		chmod a+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
		echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/debian any main" \
			> /etc/apt/sources.list.d/caddy-stable.list
		apt-get update -qq
		apt-get install -y -qq caddy
	fi

	log "配置 Caddy（域名：$DOMAIN）"
	install -d /etc/caddy
	sed -e "s/your-domain\.example\.com/$DOMAIN/g" -e "s/admin@example\.com/$EMAIL/g" \
		"$INSTALL_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
	systemctl enable caddy
	systemctl restart caddy
else
	warn "未提供域名，跳过 Caddy 配置"
	warn "当前只能通过 http://服务器IP:8080 访问（未加密）"
	warn "配好域名后重跑（域名用位置参数传，别用环境变量，sudo 会清空环境变量）："
	warn "  bash deploy/deploy.sh 你的域名 你的邮箱"
fi

# ---------------------------------------------------------------------------
# 6. 健康检查
# ---------------------------------------------------------------------------
log "健康检查"
ok=0
for i in $(seq 1 30); do
	if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
		ok=1
		break
	fi
	sleep 2
done

if [[ "$ok" -eq 1 ]]; then
	echo -e "\033[1;32m✓ 服务已启动\033[0m"
	[[ -n "$DOMAIN" ]] && echo "  访问地址：https://$DOMAIN" \
		|| echo "  访问地址：http://$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}'):8080"
	echo "  登录方式：手机号 + 短信验证码"
	echo
	echo "接下来："
	echo "  1. 填阿里云短信：sudo sed -i 's|^ALIYUN_SMS_ACCESS_KEY_ID=.*|ALIYUN_SMS_ACCESS_KEY_ID=你的key|' $ENV_FILE，其余三项同理，然后 cd $INSTALL_DIR && docker compose up -d"
	echo "  2. 设置 DeepSeek key：sudo sed -i 's|^DEEPSEEK_API_KEY=.*|DEEPSEEK_API_KEY=sk-你的key|' $ENV_FILE && cd $INSTALL_DIR && docker compose up -d"
	echo "  3. 认领老数据：cd $INSTALL_DIR && docker compose exec app node scripts/migrate-owner.js 你的手机号"
	echo "  4. 配置异地备份：见 deploy/README.md"
	echo "  5. 长期记忆（viking）：sidecar 已迁到 openviking 0.2.11。先确认 $MEM_FILE 里 ARK_API_KEY 已填，"
	echo "     跑一次冒烟（docker compose run --rm -e VIKING_DATA_DIR=/tmp/viking-smoke memory python smoke_test.py），"
	echo "     通过后再把 $ENV_FILE 的 MEMORY_ENABLED 改为 true 并 docker compose up -d"
else
	die "服务没起来，看日志：cd $INSTALL_DIR && docker compose logs --tail=50 app"
fi
