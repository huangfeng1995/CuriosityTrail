# 多阶段构建：前端 → 后端依赖 → 运行时
#
# 构建上下文是仓库根目录（见 fly.toml 的 [build] dockerfile）。
# .dockerignore 已排除 node_modules 与 data/：
#   - node_modules 必须排除，否则 macOS 上编好的 sqlite3 原生模块会覆盖
#     镜像里 npm ci 装好的 Linux 版本，容器启动直接崩。
#   - data/ 里有 SQLite 库、上传素材和 .app-password 密码文件，绝不能进镜像。

# ---------------------------------------------------------------------------
# 1. 前端：编译成静态资源
# ---------------------------------------------------------------------------
FROM node:20-slim AS client-builder

WORKDIR /app

COPY web/client/package*.json ./web/client/
RUN cd web/client && npm ci --no-audit --no-fund

COPY web/client ./web/client/
RUN cd web/client && npm run build

# ---------------------------------------------------------------------------
# 2. 后端依赖：单独一层，装编译工具
#
# sqlite3 用 prebuild-install 拉预编译二进制。绝大多数情况拉得到，
# 但拉不到时会退回 node-gyp 源码编译 —— node:20-slim 里没有 python3/make/g++，
# 编译会直接失败导致整个部署挂掉。所以这一层装上编译工具兜底。
#
# 这一层不进最终镜像：编译工具只用来保证依赖装得上。
# ---------------------------------------------------------------------------
FROM node:20-slim AS server-deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/web/server

COPY web/server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# 3. 运行时：后端代码 + 已装好的依赖 + 前端静态资源
# ---------------------------------------------------------------------------
FROM node:20-slim

WORKDIR /app

COPY web/server/package*.json ./web/server/
# 从依赖层整体搬 node_modules，不在本层执行 npm ci
COPY --from=server-deps /app/web/server/node_modules ./web/server/node_modules

COPY web/server ./web/server/

# 前端产物
COPY --from=client-builder /app/web/client/dist ./web/server/public

# 数据目录：SQLite 库、上传素材、备份都落在这里
# 生产环境这块由 Fly.io volume 挂载覆盖
RUN mkdir -p /app/data/uploads /app/data/documents /app/data/temp

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data

EXPOSE 8080

WORKDIR /app/web/server
CMD ["node", "index.js"]
