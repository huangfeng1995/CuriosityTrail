#!/bin/bash
# ============================================================
#  本地版端到端验证
# ------------------------------------------------------------
#  验证「打包产物 → 安装 → 启动 → 登录 → 写作 → 停服 → 数据留存」
#  这条链路。跑在 Mac 上，模拟的是 Windows 用户走的那条路。
#
#  覆盖：打包产物完整性、依赖安装、配置生成、服务启动、静态资源、
#        登录与会话保持、核心写作流程、导出备份、重启后数据留存。
#
#  用法：
#    bash deploy/local/package-windows.sh          # 先打包
#    bash deploy/local/test/e2e-local.sh           # 再验证
#
#  需要 pwsh（PowerShell 7+）来跑 make-config.ps1：
#    PWSH=/path/to/pwsh bash deploy/local/test/e2e-local.sh
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="${WORK:-/tmp/ct-e2e}"
PWSH="${PWSH:-/tmp/pwsh/pwsh}"
ZIP="$ROOT/dist-local/寻迹-windows.zip"
PORT="${PORT:-3991}"
PASS=0
FAIL=0

ok()   { echo "  [OK] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [失败] $1"; FAIL=$((FAIL+1)); }
step() { echo; echo "== $1 =="; }

cleanup() {
  pkill -f "ct-e2e/寻迹/app/web/server/index.js" 2>/dev/null
  pkill -f "ct-e2e" 2>/dev/null
  sleep 1
  rm -f "$WORK/寻迹/data/.instance.lock"
}
trap cleanup EXIT

step "1. 解压打包产物"
rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"
unzip -q "$ZIP" || { echo "解压失败"; exit 1; }
[ -f "寻迹/启动寻迹.cmd" ] && ok "启动器存在" || bad "启动器缺失"
[ -f "寻迹/app/web/server/index.js" ] && ok "服务端代码存在" || bad "服务端代码缺失"
[ -f "寻迹/app/web/client/dist/index.html" ] && ok "前端产物存在" || bad "前端产物缺失"
[ -d "寻迹/app/web/server/node_modules" ] && bad "node_modules 不该进包" || ok "node_modules 未混入（正确）"
find "寻迹" -name '*.node' | grep -q . && bad "混入了 mac 原生模块" || ok "无 mac 原生模块"

step "2. 安装依赖（模拟首次运行）"
cd "$WORK/寻迹/app/web/server"
npm install --omit=dev --no-audit --no-fund --prefix . >/dev/null 2>&1
node -e "require('sqlite3')" 2>/dev/null && ok "sqlite3 原生模块可用" || bad "sqlite3 加载失败"

step "3. 生成配置（make-config.ps1）"
cd "$WORK/寻迹"
if [ ! -x "$PWSH" ]; then
  echo "  [跳过] 没找到 pwsh（PowerShell），配置生成与部分检查未验证"
  echo "         设置 PWSH=/path/to/pwsh 后重跑可验证这部分"
  PWSH=""
else
  "$PWSH" -NoProfile -File "make-config.ps1" -EnvFile "$WORK/寻迹/app/web/.env" -DataDir "$WORK/寻迹/data" -Port "$PORT" > /dev/null 2>&1
fi
if [ -n "$PWSH" ]; then
  [ -f "app/web/.env" ] && ok ".env 已生成" || bad ".env 未生成"
  PW=$(grep '^APP_PASSWORD=' app/web/.env | cut -d= -f2)
  [ -n "$PW" ] && ok "登录密码已写入（${#PW} 位）" || bad "登录密码缺失"
  # 打包时预置的 AI 密钥必须被保留（不能被配置生成覆盖掉）
  KEY=$(grep '^DEEPSEEK_API_KEY=' app/web/.env | cut -d= -f2-)
  if [ -n "$KEY" ]; then
    ok "AI 密钥保留在配置中（${KEY:0:6}****）"
  else
    echo "  [跳过] 本次打包未预置密钥（web/.env 里没有 DEEPSEEK_API_KEY）"
  fi
else
  PW="testpass123"
  printf 'APP_PASSWORD=%s\nPORT=%s\nBACKUP_HOUR=3\nDEEPSEEK_API_KEY=\n' "$PW" "$PORT" > app/web/.env
  ok "跳过配置生成（无 pwsh），改用手写 .env 继续"
fi

step "4. 启动服务"
# 先清掉上一轮可能残留的实例（单实例锁会挡住新服务）
pkill -f "ct-e2e" 2>/dev/null; sleep 1
rm -f "$WORK/寻迹/data/.instance.lock"
cd "$WORK/寻迹/app/web/server"
DATA_DIR="$WORK/寻迹/data" PORT=$PORT NODE_ENV=production COOKIE_SECURE=false \
  node index.js > "$WORK/server.log" 2>&1 &
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && ok "服务已启动" || { bad "服务未启动"; cat "$WORK/server.log"; exit 1; }
# 确认这是本轮新起的进程，不是上一轮残留
if grep -q "启动中止" "$WORK/server.log"; then
  bad "服务被单实例锁挡住（测到旧实例）"; cat "$WORK/server.log"; exit 1
fi
ok "服务为本轮新实例"
grep -q "数据目录: $WORK/寻迹/data" "$WORK/server.log" && ok "数据目录指向正确位置" || bad "数据目录不对"
grep -q "环境: production" "$WORK/server.log" && ok "NODE_ENV 生效" || bad "NODE_ENV 未生效"
grep -q "DEEPSEEK_API_KEY: 已加载" "$WORK/server.log" && ok "服务已读到 AI 密钥" || bad "服务未读到 AI 密钥"

step "5. 首页与静态资源"
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/)" = "200" ] && ok "首页 200" || bad "首页异常"
ASSET=$(curl -s http://127.0.0.1:$PORT/ | grep -oE '/assets/[^"]+\.js' | head -1)
[ -n "${ASSET}" ] && ok "前端 JS 可访问 (${ASSET})" || bad "前端 JS 未找到"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}${ASSET}")" = "200" ] && ok "静态资源 200" || bad "静态资源异常"

step "6. 登录与会话保持"
rm -f "$WORK/cookie.txt"
LOGIN=$(curl -s -D "$WORK/h.txt" -c "$WORK/cookie.txt" -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"password\":\"$PW\",\"remember\":true}")
echo "$LOGIN" | grep -q authenticated && ok "登录成功" || bad "登录失败: $LOGIN"
grep -qi 'set-cookie:.*ct_session' "$WORK/h.txt" && ok "下发会话 cookie" || bad "未下发 cookie"
grep -qi 'set-cookie:.*Secure' "$WORK/h.txt" && bad "本地版 cookie 带 Secure（http 下会失效）" || ok "本地版 cookie 无 Secure（正确）"
curl -s -b "$WORK/cookie.txt" "http://127.0.0.1:$PORT/api/auth/session" | grep -q '"authenticated":true' \
  && ok "会话保持有效" || bad "会话未保持"
WRONG=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/login" -H 'Content-Type: application/json' -d '{"password":"wrong"}')
echo "$WRONG" | grep -q "密码错误" && ok "错误密码被拒绝" || bad "错误密码未被拒绝"

step "7. 核心业务：建作品 → 建章节 → 写正文 → 存版本"
AUTH="-b $WORK/cookie.txt"
WORK_ID=$(curl -s $AUTH -X POST "http://127.0.0.1:$PORT/api/works" -H 'Content-Type: application/json' \
  -d '{"title":"测试长篇"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id || JSON.parse(require('fs').readFileSync(0,'utf8')).work?.id || ''")
[ -n "$WORK_ID" ] && ok "作品已创建（id=${WORK_ID}））" || bad "建作品失败"
CH_ID=$(curl -s $AUTH -X POST "http://127.0.0.1:$PORT/api/works/$WORK_ID/chapters" -H 'Content-Type: application/json' \
  -d '{"title":"第一章"}' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id || ''")
[ -n "$CH_ID" ] && ok "章节已创建" || bad "建章节失败"
SAVE=$(curl -s $AUTH -X PUT "http://127.0.0.1:$PORT/api/chapters/$CH_ID" -H 'Content-Type: application/json' \
  -d '{"content":"他推开那扇门。屋里没人。\n\n桌上留着一杯还温着的茶。"}')
echo "$SAVE" | grep -qiE 'wordCount|content' && ok "章节正文已保存" || bad "保存失败: $SAVE"
LIST=$(curl -s $AUTH "http://127.0.0.1:$PORT/api/works/$WORK_ID")
echo "$LIST" | grep -q "第一章" && ok "作品详情能读回章节" || bad "读回章节失败"

step "8. 导出与备份（数据在本地）"
EXP=$(curl -s -o "$WORK/out.txt" -w '%{http_code}' $AUTH "http://127.0.0.1:$PORT/api/export/work/$WORK_ID/markdown")
[ "$EXP" = "200" ] && ok "导出接口可用（${EXP}））" || bad "导出异常（${EXP}））"
BK=$(curl -s $AUTH -X POST "http://127.0.0.1:$PORT/api/export/backups" -o "$WORK/bk.json" -w '%{http_code}')
[ "$BK" = "200" ] && ok "手动备份接口可用" || bad "备份接口异常（${BK}））"

step "9. 停服 → 重启 → 数据留存"
pkill -f "ct-e2e" 2>/dev/null; sleep 2
lsof -ti :${PORT} 2>/dev/null | xargs kill -9 2>/dev/null
rm -f "$WORK/寻迹/data/.instance.lock"
cd "$WORK/寻迹/app/web/server"
DATA_DIR="$WORK/寻迹/data" PORT=$PORT NODE_ENV=production COOKIE_SECURE=false \
  node index.js > "$WORK/server2.log" 2>&1 &
for i in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && ok "重启成功" || bad "重启失败"
# 重新登录（模拟新会话）再查数据
rm -f "$WORK/cookie2.txt"
curl -s -c "$WORK/cookie2.txt" -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"password\":\"$PW\"}" >/dev/null
AGAIN=$(curl -s -b "$WORK/cookie2.txt" "http://127.0.0.1:$PORT/api/chapters/$CH_ID")
echo "$AGAIN" | grep -q "推开那扇门" && ok "重启后正文仍在（数据持久化正确）" || bad "重启后数据丢失"
[ -f "$WORK/寻迹/data/curiosity.db" ] && ok "SQLite 库在 data 目录" || bad "库文件位置不对"

echo
echo "================================"
echo "  通过 $PASS 项，失败 $FAIL 项"
echo "================================"
exit $FAIL
