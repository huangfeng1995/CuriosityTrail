# 国内云服务器部署指南（阿里云 / 腾讯云香港轻量）

面向「一台固定 Linux 服务器 + Docker」的场景。约 20 分钟搞定，之后更新只需一条命令。

**为什么选香港节点**：大陆节点用 80/443 端口对外必须先完成 ICP 备案，流程 1-3 周。香港节点免备案，买完就能上线。代价是国内访问延迟约 30-80ms，对写小说完全无感。

---

## 一、买机器

**阿里云**（推荐）：轻量应用服务器 → 香港地域 → 2核1G 起步

| 项 | 建议 |
|---|---|
| 地域 | 中国香港 |
| 配置 | 2核1G / 2核2G 都够（Node + SQLite 很省内存） |
| 系统 | Ubuntu 22.04 LTS |
| 磁盘 | 40GB 起（数据库 + 素材 + 备份） |
| 带宽 | 按流量计费的够用，别选固定带宽小包 |
| 镜像 | 选「Docker」预装镜像可省掉第 2 步 |

**腾讯云**同理，地域选中国香港。

买完记下**公网 IP**。

---

## 二、准备域名（可选但强烈建议）

没有域名也能跑（`http://IP:8080`），但：
- 明文 HTTP，**登录密码和 DeepSeek key 都在裸奔**
- 每次换 IP 都要改链接

有域名的话，把 A 记录解析到服务器公网 IP。**香港节点不需要备案**。

---

## 三、一键部署

SSH 登录服务器（阿里云控制台给的初始密码，或用密钥）：

```bash
ssh root@你的服务器IP
```

粘贴这一条命令：

```bash
curl -fsSL https://raw.githubusercontent.com/huangfeng1995/CuriosityTrail/main/deploy/deploy.sh | bash
```

脚本会依次完成：
1. 装 Docker + Compose（没有的话）
2. 克隆仓库到 `/opt/curiosity-trail`
3. 生成随机登录密码和 JWT 密钥，写进 `deploy/.env.production`（权限 600）
4. 构建镜像并启动容器
5. 打印登录密码

> 轻量服务器默认就是 root 登录，脚本需要 root 权限。如果提示权限不足，见文末排障。

**想同时配好 HTTPS 和域名**，把域名和邮箱作为**位置参数**传进去：

```bash
curl -fsSL https://raw.githubusercontent.com/huangfeng1995/CuriosityTrail/main/deploy/deploy.sh | bash -s -- writing.example.com you@example.com
```

> ⚠️ **域名必须先解析到这台服务器的 IP**，否则 Caddy 申请证书会失败。
> 解析生效可能需要几分钟到几小时，Caddy 会自动重试，不用管。
>
> ⚠️ **别用 `DOMAIN=xxx sudo bash deploy.sh` 这种写法** —— sudo 默认会清空
> 环境变量（env_reset），域名会静默丢失。用位置参数（上面那条命令），
> 或 `sudo -E`。

**没传域名**的话，只有 `http://IP:8080` 能访问。随时补上：

```bash
cd /opt/curiosity-trail
bash deploy/deploy.sh writing.example.com you@example.com
```

---

## 四、配置 DeepSeek Key

没有 key 的话 AI 对话不可用（会尝试回退到本地 Ollama，而服务器上没有）：

```bash
cd /opt/curiosity-trail
sudo sed -i 's|^DEEPSEEK_API_KEY=.*|DEEPSEEK_API_KEY=sk-你的真实key|' deploy/.env.production
docker compose up -d
```

key 在 [platform.deepseek.com](https://platform.deepseek.com) 充值后创建。

---

## 五、异地备份（重要）

服务器上的备份和数据库在**同一块盘**。盘坏了，稿子和备份一起没。
所以要把备份复制到对象存储（阿里云 OSS / 腾讯云 COS），那才是真正的异地。

### 1. 建 bucket

阿里云 OSS 控制台 → Bucket → 命名（如 `my-backups`）→ 权限选「私有」。
记下 Endpoint 和 AccessKey。

### 2. 装 ossutil

```bash
curl -o ossutil https://gosspublic.alicdn.com/ossutil/1.7.19/ossutil64
chmod +x ossutil && sudo mv ossutil /usr/local/bin/
ossutil config
# 按提示填：AK、SK、Endpoint（用内网 Endpoint 可省公网流量费）
```

### 3. 装同步脚本

```bash
cd /opt/curiosity-trail
sudo cp deploy/sync-offsite.sh /usr/local/bin/ && sudo chmod +x /usr/local/bin/sync-offsite.sh
```

### 4. 配定时任务

```bash
sudo crontab -e
```

加一行（每小时第 17 分钟同步一次，避开整点）：

```
17 * * * * REMOTE=oss:// BUCKET=my-backups PREFIX=curiosity-backups/ /usr/local/bin/sync-offsite.sh >> /var/log/curiosity-sync.log 2>&1
```

> `BUCKET` 填 bucket 名（不带域名），`PREFIX` 是桶内的目录前缀。

### 5. 验证

```bash
# 在网页「设置 → 备份」点一次「立即备份」，然后：
ls -la /opt/curiosity-trail/data-offsite/
sudo cat /var/log/curiosity-sync.log
```

日志出现「同步完成」就说明链路通了。

---

## 六、日常运维

### 更新代码

```bash
cd /opt/curiosity-trail && git pull && docker compose up -d --build
```

数据在宿主机目录里，重建容器不影响。

### 看日志

```bash
cd /opt/curiosity-trail
docker compose logs -f app        # 实时
docker compose logs --tail=100 app # 最近 100 行
```

### 改短信配置

```bash
cd /opt/curiosity-trail
sudo sed -i 's|^ALIYUN_SMS_ACCESS_KEY_ID=.*|ALIYUN_SMS_ACCESS_KEY_ID=新的key|' deploy/.env.production
docker compose up -d
```

### 手动备份 / 恢复

```bash
cd /opt/curiosity-trail
# 备份（网页「设置 → 备份」也一样）
curl -b cookies.txt -X POST https://你的域名/api/export/backups

# 下载一份到本地
curl -b cookies.txt -o backup.zip https://你的域名/api/export/backup
```

恢复走网页「设置 → 备份 → 恢复」，上传之前下载的 zip。

### 磁盘满了

```bash
df -h                        # 看用量
du -sh /opt/curiosity-trail/data/*
# 旧备份可以手动清（保留最近几份就行）
ls -lt /opt/curiosity-trail/data/backups/ | head
```

---

## 七、排障

**提示「需要 root 权限」**
轻量服务器默认就是 root 登录。若不是：
```bash
sudo bash deploy/deploy.sh 你的域名 你的邮箱
```
（`sudo` 会清空环境变量，域名务必用位置参数传）

**打不开网页**
```bash
curl -i http://127.0.0.1:8080/api/health   # 本机不通 → 容器没起
docker compose ps
docker compose logs --tail=50 app
```

**容器反复重启**
```bash
docker compose logs --tail=100 app | grep -iE "启动中止|另一个实例|锁"
```
多半是数据目录残留了实例锁。确认没有别的进程在用后：
```bash
rm -f /opt/curiosity-trail/data/.instance.lock && docker compose restart
```

**AI 没反应**
```bash
docker compose exec app printenv DEEPSEEK_API_KEY   # 确认注入了
docker compose exec app printenv | grep -i deepseek
```
网页「设置 → AI 供应商」有「测试连接」按钮，报错更直接。key 没余额也会报错。

**HTTPS 证书签发失败**
```bash
journalctl -u caddy -n 50 --no-pager
```
最常见原因：域名没解析到这台服务器、80 端口被安全组拦了。
去云厂商控制台的**安全组**放行 80 和 443。

**Caddy 配好了但 443 不通**
检查安全组是否放行 443：
```bash
ss -tlnp | grep -E ':80|:443'
```

---

## 八、安全清单

上线后确认这几项：

- [ ] 用的是 **HTTPS**（不是 `http://IP:8080`）
- [ ] 登录密码不是默认弱口令（`deploy.sh` 生成的随机密码是安全的）
- [ ] `deploy/.env.production` 权限是 600
- [ ] 云厂商安全组只放行 80/443，**不要放行 8080**（容器只监听 127.0.0.1）
- [ ] SSH 禁止密码登录、改用密钥：`sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo systemctl restart sshd`
- [ ] DeepSeek key 只在 `deploy/.env.production` 里，不在代码、不在 git
- [ ] 异地备份跑通了（第五步验证过）

---

## 九、长期记忆（viking）怎么开、怎么关

记忆服务是一个 Python sidecar（`web/memory-service`），现在钉 `openviking==0.2.11`
（Linux 可装的稳定版，轮子自带 AGFS 原生库，不再需要 8018 端口）。
它和 app 一起由 `docker compose` 管理，容器名 `curiosity-trail-memory`。

### 9.1 两个独立的环境文件

| 文件 | 给谁用 | 内容 |
| --- | --- | --- |
| `deploy/.env.production` | app 容器 | `MEMORY_ENABLED`（总开关） |
| `deploy/.env.memory` | memory 容器 | `ARK_API_KEY` 等 embedding 凭据 |

`ARK_API_KEY` 只给 sidecar，app 容器读不到。两个文件都由 `deploy.sh` 生成（权限 600），
都不进版本库。

### 9.2 首次开启（三步）

```bash
cd /opt/curiosity-trail

# 1) 填 embedding 凭据（deploy.sh 生成时留空）
sudo sed -i 's|^ARK_API_KEY=.*|ARK_API_KEY=你的key|' deploy/.env.memory

# 2) 冒烟测试（用临时目录，不碰生产数据），13 项应全 PASS
docker compose run --rm -e VIKING_DATA_DIR=/tmp/viking-smoke memory python smoke_test.py

# 3) 打开总开关并重启
sed -i 's|^MEMORY_ENABLED=.*|MEMORY_ENABLED=true|' deploy/.env.production
docker compose up -d
curl -s http://127.0.0.1:8080/api/memory/status
```

`/api/memory/status` 显示已启用、sidecar 可用即完成。

### 9.3 关掉（回退）

记忆层是加分项，出问题随时关，不用动代码：

```bash
cd /opt/curiosity-trail
sed -i 's|^MEMORY_ENABLED=.*|MEMORY_ENABLED=false|' deploy/.env.production
docker compose up -d app
```

之后召回直接短路（返回 degraded 空结果），写作与对话不受影响；
`data/viking` 是派生数据，留着下次打开直接复用，删掉也不会影响稿件。

### 9.4 注意事项

- `memory` 服务**不发布端口**，只在 compose 内网被 app 访问（它没有鉴权）。
- `app` 不 `depends_on` memory：sidecar 挂了 app 必须照常起。
- 构建 `memory` 镜像较重，2 核 / 1.7G 的机器上失败不影响 app 上线
  （`deploy.sh` 会跳过 memory 并提示）。
- 老服务器的 `.env.production` 里如果没有 `MEMORY_ENABLED`，`deploy.sh` 会补一行
  `false`，避免误连不存在的 sidecar；确认冒烟通过后再手动改 `true`。
- 排查：`docker compose logs --tail=100 memory`。若出现
  `PermissionError: '/app/data/viking/_system'`，是宿主机目录属主不对
  （sidecar 容器内以 uid 10001 运行）：`chown -R 10001:10001 data/viking`。
  `deploy.sh` 已自动处理，只有手工建目录时才会遇到。
