# 🔒 安全配置指南

## 重要！先看这个

在部署或开源项目前，请务必阅读此文档！

---

## ✅ 已实现的安全措施

### 1. `.gitignore` 保护
以下文件/目录**不会被提交到 Git**：
- `data/` - 数据库和 AI 配置文件
- `documents/` - 用户上传的文档
- `.env` - 环境变量（包含 API Key）
- `*.db` - SQLite 数据库文件

### 2. 敏感信息隐藏
- API 返回配置时会隐藏 Key，只显示最后 4 位
- 例如：`sk-1234***5678`

### 3. 环境变量支持
可以通过环境变量配置，完全避免在文件中存储敏感信息！

---

## 🚀 推荐部署方案（最安全）

### 方案 A：环境变量（推荐用于生产环境）

1. 复制 `.env.example` 为 `.env`
2. 在 `.env` 中填入你的真实配置
3. 部署时通过平台的环境变量功能设置（如 Railway 的 Variables）

**示例 `.env`：**
```bash
# MiniMax 配置
MINIMAX_API_KEY=your_real_api_key
MINIMAX_GROUP_ID=your_real_group_id
```

### 方案 B：配置文件（用于本地开发）

在 AI 助手界面直接配置，配置会保存在 `data/ai-config.json`（这个文件已在 `.gitignore` 里）

---

## 🔐 Railway 部署安全设置

1. **不要提交 `.env` 文件**
2. 在 Railway 控制台的 Variables 里设置环境变量
3. 变量名参考 `.env.example`

---

## ⚠️ 安全检查清单

部署前请确认：
- [ ] `.gitignore` 包含 `data/` 和 `.env`
- [ ] 没有 `.env` 文件被不小心提交
- [ ] 敏感信息都通过环境变量设置
- [ ] Railway 变量已正确配置

---

## 📞 有问题？

如果有安全疑问，请先检查上述内容！
