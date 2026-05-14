# 多阶段构建：先构建前端，再构建后端
FROM node:20-slim AS client-builder

WORKDIR /app

# 复制前端文件
COPY web/client/package*.json ./web/client/
RUN cd web/client && npm ci

COPY web/client ./web/client/
RUN cd web/client && npm run build

# 最终镜像：后端 + 构建好的前端
FROM node:20-slim

WORKDIR /app

# 复制后端文件
COPY web/server/package*.json ./web/server/
RUN cd web/server && npm ci --only=production

COPY web/server ./web/server/

# 复制构建好的前端
COPY --from=client-builder /app/web/client/dist ./web/server/public

# 创建数据目录
RUN mkdir -p /app/data
RUN mkdir -p /app/data/uploads

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data

# 暴露端口
EXPOSE 8080

# 启动应用
WORKDIR /app/web/server
CMD ["node", "index.js"]
