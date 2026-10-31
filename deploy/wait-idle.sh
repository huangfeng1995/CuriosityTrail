#!/usr/bin/env bash
#
# 等到没有人在写，再重建容器。
#
# 用法：
#   bash deploy/wait-idle.sh          # 最多等 5 分钟
#   bash deploy/wait-idle.sh 120      # 最多等 120 秒
#
# 为什么需要它：
# 重建容器会发 SIGTERM。虽然应用现在会优雅停机（等在途请求收尾），
# 但正在生成的稿子还是可能只写了一半——SQLite 事务没提交，
# 作者看到的是一句 network error。
# 部署前先看一眼有没有人在写，没有就拆，有就等。
#
# 退出码：
#   0  空闲，可以部署
#   1  超时，仍有人在写（调用方应中止部署）

set -uo pipefail

# 本机回环地址（容器只监听 127.0.0.1:8080）
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/api/health}"
MAX_WAIT="${1:-300}"

log()  { echo "[wait-idle] $*"; }

if ! command -v curl >/dev/null 2>&1; then
	log "没装 curl，跳过检查"
	exit 0
fi

log "等作者写完（最多 ${MAX_WAIT} 秒）"
elapsed=0
while [ "$elapsed" -lt "$MAX_WAIT" ]; do
	body=$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)

	if [ -z "$body" ]; then
		# 服务没起来：没什么在途请求，直接放行
		log "健康检查无响应，服务可能没在跑，直接放行"
		exit 0
	fi

	# 从 JSON 里抠出 activeChats。没有 jq，用最笨的办法，
	# 但对这个形状够用：{"activeChats":0,...}
	chats=$(printf '%s' "$body" | sed -n 's/.*"activeChats"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p')
	chats=${chats:-0}

	if [ "$chats" -eq 0 ]; then
		log "空闲，可以部署"
		exit 0
	fi

	log "还有 $chats 个对话在进行中，再等…"
	sleep 10
	elapsed=$((elapsed + 10))
done

log "等了 ${MAX_WAIT} 秒仍有人在写，中止部署（稍后重试）"
exit 1
