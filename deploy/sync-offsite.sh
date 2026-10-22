#!/usr/bin/env bash
#
# 异地备份：把本地备份目录同步到对象存储（阿里云 OSS / 腾讯云 COS 等 S3 兼容存储）
#
# 为什么需要它：
#   服务器上的备份和数据库在同一块盘。盘坏了，备份和稿子一起没。
#   同步到对象存储后，那份副本在另一个厂商的机房，才算真"异地"。
#
# 原理：
#   1. 应用内定时备份写到宿主机 ./data-offsite（BACKUP_OFFSITE_DIR 指向它）
#   2. 本脚本每小时把该目录推到对象存储，同步后删除本地副本（省磁盘）
#
# 安装：
#   sudo cp deploy/sync-offsite.sh /usr/local/bin/ && sudo chmod +x /usr/local/bin/sync-offsite.sh
#
# 前置：
#   - 装 ossutil 或 s5cmd（脚本会自动尝试）
#   - 配好对象存储凭证（见 deploy/README.md）
#
# 定时：
#   sudo crontab -e，加一行：
#     17 * * * * /usr/local/bin/sync-offsite.sh >> /var/log/curiosity-sync.log 2>&1

set -euo pipefail

# ---------------------------------------------------------------------------
# 配置（也可用同名环境变量覆盖）
# ---------------------------------------------------------------------------
SYNC_DIR="${SYNC_DIR:-/opt/curiosity-trail/data-offsite}"
# 目标：阿里云 OSS 用 oss://，S3 兼容用 s3://
REMOTE="${REMOTE:-}"
# 用 ossutil 时填 bucket 名，用 s5cmd 时留空
BUCKET="${BUCKET:-}"
PREFIX="${PREFIX:-curiosity-backups/}"
# 保留份数（对象存储侧）
KEEP="${KEEP:-30}"

log()  { echo -e "\033[1;36m[同步]\033[0m $*"; }
die()  { echo -e "\033[1;31m[错误]\033[0m $*" >&2; exit 1; }

[[ -n "$REMOTE" ]] || die "未配置 REMOTE（例：REMOTE=oss:// 或 REMOTE=s3://）"
[[ -d "$SYNC_DIR" ]] || die "同步目录不存在：$SYNC_DIR"

# 找到可用的工具
TOOL=""
if command -v s5cmd >/dev/null 2>&1; then
	TOOL="s5cmd"
elif command -v ossutil >/dev/null 2>&1; then
	TOOL="ossutil"
elif command -v ossutil64 >/dev/null 2>&1; then
	TOOL="ossutil64"
else
	die "没找到 ossutil 或 s5cmd。装一个：
  阿里云 OSS：https://help.aliyun.com/document_detail/120075.html
  或直接用 s5cmd：https://github.com/peak/s5cmd"
fi

# 没有新文件就退出，不做无意义的请求
shopt -s nullglob
files=("$SYNC_DIR"/*.zip)
[[ ${#files[@]} -eq 0 ]] && { log "没有新备份，跳过"; exit 0; }
log "发现 ${#files[@]} 个待同步备份"

case "$TOOL" in
s5cmd)
	[[ -n "$BUCKET" ]] || die "用 s5cmd 时必须设置 BUCKET"
	s5cmd cp "$SYNC_DIR"/*.zip "s3://${BUCKET}/${PREFIX}"
	;;
ossutil|ossutil64)
	if [[ "$REMOTE" == oss://* ]]; then
		# ossutil 的 cp 语法：cp src oss://bucket/prefix/
		"$TOOL" cp "$SYNC_DIR"/*.zip "oss://${BUCKET}/${PREFIX}" --update
	elif [[ "$REMOTE" == s3://* ]]; then
		"$TOOL" cp "$SYNC_DIR"/*.zip "s3://${BUCKET}/${PREFIX}" --update
	else
		die "REMOTE 格式不认识：$REMOTE"
	fi
	;;
esac

log "同步完成"

# ---------------------------------------------------------------------------
# 清理本地已同步的副本，避免占满磁盘
# ---------------------------------------------------------------------------
# 上传后逐个确认远端确实有了再删本地。没确认到的保留，下次还会重传。
for f in "${files[@]}"; do
	name="$(basename "$f")"
	if "$TOOL" ls "${REMOTE}${BUCKET}/${PREFIX}${name}" >/dev/null 2>&1; then
		rm -f "$f"
	else
		log "远端还没找到 $name，保留本地副本"
	fi
done

# ---------------------------------------------------------------------------
# 清理对象存储上的旧备份，只留 KEEP 份
# ---------------------------------------------------------------------------
# ls 输出的最后一列才是对象 key（前面是时间/大小，列数各版本不一致），
# 用 $NF 取，不要写死 $2——那取到的是大小。
old=$("$TOOL" ls "${REMOTE}${BUCKET}/${PREFIX}" 2>/dev/null \
	| awk '{print $NF}' | grep -E '\.zip$' | sort || true)
total=$(printf '%s\n' "$old" | grep -c . || true)
if [[ "$total" -gt "$KEEP" ]]; then
	# 用 head -n N 而不是 head -n -N：BSD head（macOS）不支持负数条数
	excess=$(printf '%s\n' "$old" | head -n "$((total - KEEP))")
	log "清理远端旧备份（保留最近 ${KEEP} 份，删除 $((total - KEEP)) 份）"
	while read -r key; do
		[[ -n "$key" ]] || continue
		# $NF 已经是完整 URI（s3://bucket/prefix/xxx.zip），不要再拼前缀
		"$TOOL" rm "$key" >/dev/null 2>&1 || true
	done <<< "$excess"
fi

log "完成"
