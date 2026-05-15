#!/bin/bash

# Curiosity Trail 部署脚本
# 使用方法：bash deploy.sh

echo "🚀 Curiosity Trail 部署脚本"
echo "=========================="
echo ""

# 1. 检查 Fly CLI
echo "📦 检查 Fly CLI..."
if ! command -v flyctl &> /dev/null; then
    echo "❌ Fly CLI 未安装，正在安装..."
    curl -L https://fly.io/install.sh | sh
    
    # 添加到 PATH
    export FLYCTL_INSTALL="$HOME/.fly"
    export PATH="$FLYCTL_INSTALL/bin:$PATH"
else
    echo "✅ Fly CLI 已安装"
fi

# 2. 登录
echo ""
echo "🔐 登录 Fly.io..."
flyctl auth login

# 3. 初始化应用
echo ""
echo "⚙️ 初始化 Fly.io 应用..."
read -p "请输入应用名称 (直接回车使用 curiosity-trail): " app_name
app_name=${app_name:-curiosity-trail}

# 4. 创建数据卷
echo ""
echo "💾 创建数据卷..."
flyctl volumes create curiosity_trail_data --region hkg --size 1

# 5. 部署
echo ""
echo "🚀 开始部署..."
flyctl deploy

# 6. 检查状态
echo ""
echo "📊 检查应用状态..."
flyctl status

echo ""
echo "✅ 部署完成！"
echo "访问你的应用: https://${app_name}.fly.dev"
