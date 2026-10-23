#!/bin/bash
# ============================================================
#  寻迹 · Windows 本地版打包
# ------------------------------------------------------------
#  在 Mac 上跑这个脚本，产出一个 zip，发给对方解压双击就能用。
#
#  对方不需要装 Node、不需要装任何东西，全在这个 zip 里。
#
#  用法：bash deploy/local/package-windows.sh
#  产物：dist-local/寻迹-windows.zip
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/dist-local"
STAGE="$OUT/寻迹"

cd "$ROOT"

echo "==> 1/5 构建前端"
# 前端产物是静态文件，谁构建都一样（不依赖平台）。
# 服务器端有原生模块（sqlite3），那部分留给对方机器上现装。
if [ ! -d web/client/node_modules ]; then
  (cd web/client && npm install --no-audit --no-fund)
fi
(cd web/client && npm run build)

echo "==> 2/5 准备服务器端代码"
rm -rf "$STAGE"
mkdir -p "$STAGE/app/web/server" "$STAGE/app/web/client" "$STAGE/data"

# 服务器源码（不含 node_modules —— 里面有 mac 的原生模块，拷到 Windows 会崩）
cp -R web/server/. "$STAGE/app/web/server/"
rm -rf "$STAGE/app/web/server/node_modules"
rm -rf "$STAGE/app/web/server/test"
rm -rf "$STAGE/app/web/server/.tmp"
# 空的 agent/ 目录是历史残留，没进版本库，别打进包
rm -rf "$STAGE/app/web/server/agent"

# 前端构建产物
cp -R web/client/dist "$STAGE/app/web/client/dist"

echo "==> 3/5 复制启动脚本"
cp deploy/local/windows/setup-runtime.ps1 "$STAGE/"
cp deploy/local/windows/make-config.ps1 "$STAGE/"
cp "deploy/local/windows/启动寻迹.cmd" "$STAGE/"
cp "deploy/local/windows/停止寻迹.cmd" "$STAGE/"
cp deploy/local/windows/使用说明.txt "$STAGE/"

# data 目录里放一个说明，解释数据在哪
cat > "$STAGE/data/数据说明.txt" <<'TXT'
你的小说、人物卡、素材、备份都在这个文件夹里。

重要：请不要删除这个文件夹，也不要把它放到会被系统自动清理的位置
（不要放桌面、下载目录、微信/QQ 的接收文件目录）。

推荐：放在 C:\寻迹数据 或 文档\寻迹数据
备份：把整个「寻迹」文件夹复制到 U 盘或网盘，就是最完整的备份。
TXT

echo "==> 4/5 打包"
mkdir -p "$OUT"
cd "$OUT"
rm -f "寻迹-windows.zip"
# -r 递归 -X 去掉 macOS 的 __MACOSX 与 ._ 文件（Windows 上是垃圾）
zip -r -X "寻迹-windows.zip" "寻迹" > /dev/null

cd "$ROOT"

echo "==> 5/5 完成"
SIZE=$(du -h "$OUT/寻迹-windows.zip" | cut -f1)
echo
echo "  产物：${OUT}/寻迹-windows.zip  (${SIZE})"
echo
echo "  下一步："
echo "    1. 把这个 zip 发给她（微信/U 盘/网盘都行）"
echo "    2. 她解压后双击「启动寻迹.cmd」"
echo "    3. 第一次会提示下载运行环境，需要联网，约 2-4 分钟"
echo "    4. 之后每次双击都是秒开"
echo
echo "  提醒：别忘了在 app\\web\\.env 里填 DEEPSEEK_API_KEY，否则 AI 写作用不了。"
echo
