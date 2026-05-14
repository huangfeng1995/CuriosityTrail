# 使用 Node.js 20 作为基础镜像
FROM node:20-slim

# 设置工作目录
WORKDIR /app

# 复制后端 package 文件
COPY package*.json ./

# 安装后端依赖
RUN npm ci --only=production

# 复制后端代码
COPY . .

# 复制前端文件（先在本地构建好）
# 注意：需要先在 web/client 中运行 npm run build
COPY ../client/dist ./public

# 创建数据目录（用于存储 SQLite 数据库和上传的文件）
RUN mkdir -p /app/data
RUN mkdir -p /app/data/uploads

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data

# 暴露端口
EXPOSE 8080

# 启动应用
CMD ["node", "index.js"]
