# Curiosity Trail Web 版架构设计

## 1. 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | React + Vite + Tailwind CSS | 简洁留白 UI 风格 |
| 后端 | FastAPI (Python) | API 服务 |
| 数据库 | SQLite | 复用并扩展现有结构 |
| 文件存储 | 服务器本地 | `uploads/` 目录 |
| 认证 | JWT | 用户独立账户 |

## 2. 架构概览

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Browser    │──── │   FastAPI    │──── │   SQLite     │
│   (React)    │     │   Backend    │     │  Database    │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────┴──────┐
                     │  /uploads   │
                     │ (PDF 文献)  │
                     └─────────────┘
```

## 3. 数据库 Schema

### 用户表
```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email VARCHAR(200) NOT NULL UNIQUE,
    password_hash VARCHAR(200) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 报告表
```sql
CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title VARCHAR(200) NOT NULL,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    modified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 文献表
```sql
CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name VARCHAR(200) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    category_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 分类表
```sql
CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 报告-文献关联表
```sql
CREATE TABLE report_documents (
    report_id INTEGER,
    document_id INTEGER,
    PRIMARY KEY (report_id, document_id),
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
```

## 4. API 设计

### 认证
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录 |
| GET | `/api/auth/me` | 获取当前用户 |

### 报告
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/reports` | 列表 |
| POST | `/api/reports` | 创建 |
| GET | `/api/reports/{id}` | 详情 |
| PUT | `/api/reports/{id}` | 更新 |
| DELETE | `/api/reports/{id}` | 删除 |
| GET | `/api/reports/{id}/export?format=txt\|docx` | 导出 |

### 文献
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/documents` | 列表 |
| POST | `/api/documents` | 上传 |
| GET | `/api/documents/{id}` | 详情 |
| DELETE | `/api/documents/{id}` | 删除 |
| GET | `/api/documents/{id}/download` | 下载 PDF |

### 分类
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/categories` | 列表 |
| POST | `/api/categories` | 创建 |
| PUT | `/api/categories/{id}` | 更新 |
| DELETE | `/api/categories/{id}` | 删除 |

## 5. 前端页面

| 页面 | 路由 | 说明 |
|------|------|------|
| 登录 | `/login` | 用户登录 |
| 注册 | `/register` | 用户注册 |
| 报告库 | `/reports` | 报告列表 |
| 文献库 | `/documents` | 文献列表 |
| 系统设置 | `/settings` | 主题切换等 |

## 6. 核心流程

### 报告编辑流程
1. 用户在报告库点击「新建」或「编辑」
2. 进入报告编辑页面，编辑标题和内容
3. 可关联/解除关联文献
4. 自动保存（每 5 分钟）
5. 手动保存或导出

### 文献上传流程
1. 用户在文献库点击「上传 PDF」
2. 选择本地 PDF 文件
3. 文件上传到服务器 `/uploads/{user_id}/` 目录
4. 文献记录保存到数据库

### 导出流程
1. 用户在报告编辑页点击「导出」
2. 后端读取报告内容和关联文献
3. 生成 TXT 或 DOCX 文件
4. 返回文件流，前端触发下载

## 7. 安全设计

- JWT 令牌有效期：7 天
- 密码 bcrypt 加密存储
- 用户只能访问自己的数据（user_id 隔离）
- 文件上传限制：PDF 格式，最大 50MB
- CORS 配置：仅允许部署域名

## 8. 文件结构

```
CuriosityTrail/
├── frontend/               # React 前端
│   ├── src/
│   │   ├── components/    # UI 组件
│   │   ├── pages/         # 页面
│   │   ├── api/           # API 调用
│   │   └── App.jsx
│   └── package.json
├── backend/               # FastAPI 后端
│   ├── main.py
│   ├── auth.py
│   ├── models.py
│   ├── routes/
│   │   ├── reports.py
│   │   ├── documents.py
│   │   └── categories.py
│   └── uploads/          # 文件存储
└── SPEC.md
```

## 9. MVP 范围（第一版）

### 必须实现
- 用户注册/登录
- 报告 CRUD + 关联文献
- 文献上传/查看/删除/分类
- 报告导出 TXT/DOCX
- 浅色/深色主题切换

### 暂时不做
- 数据备份恢复（后续版本）
- 分享功能（不在 MVP 范围）