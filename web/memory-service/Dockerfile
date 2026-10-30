# 记忆服务 sidecar 镜像。
#
# 构建上下文是仓库根目录（见 docker-compose.yml 的 memory 服务）：
#   docker compose build memory

FROM python:3.10-slim-bookworm

# openviking 0.2.11 的轮子是 cp310-abi3-manylinux_2_31_x86_64，
# bookworm 的 glibc 满足 2.31，原生库直接可用，不需要编译工具链。
WORKDIR /app

COPY web/memory-service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY web/memory-service ./

# 非 root 运行；数据目录先建好并交给运行用户，避免挂载后写不进去。
RUN useradd --create-home --uid 10001 viking \
    && mkdir -p /app/data/viking \
    && chown -R viking:viking /app

USER viking

# 容器内需要被同网络的 app 访问，所以监听 0.0.0.0。
# 这个服务不带鉴权，因此 compose 里**不发布端口**，只有 app 容器能连。
ENV VIKING_HOST=0.0.0.0 \
    VIKING_PORT=8019 \
    VIKING_DATA_DIR=/app/data/viking \
    PYTHONUNBUFFERED=1

EXPOSE 8019

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8019"]
