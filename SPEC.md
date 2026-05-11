# Curiosity Trail（寻迹）产品功能需求文档 SPEC V1.0

## 1. 产品概述

### 1.1 产品定位
一款轻量化纯本地桌面 GUI 工具，专注 **个人科学探索记录 + 文献 PDF 绑定管理**，全程图形按钮操作，零命令行、零注册、零云端上传。

### 1.2 核心价值
- **低门槛**：全可视化按钮操作
- **强专属**：内置科学探究标准模板
- **一体化**：探索报告与 PDF 文献可关联绑定
- **高隐私**：全部数据本地存储
- **易导出**：支持 TXT/Word 双格式报告导出

### 1.3 技术选型
- **GUI框架**：PyQt5（跨平台Windows/macOS）
- **数据库**：SQLite3
- **文档导出**：python-docx（TXT直接Python内置）
- **PDF处理**：PyMuPDF（轻量PDF查看）
- **打包工具**：PyInstaller

---

## 2. UI/UX 规范

### 2.1 窗口规格
- **最小尺寸**：800×600
- **默认尺寸**：1024×700
- **窗口可缩放**：是
- **窗口标题**：Curiosity Trail 寻迹

### 2.2 布局结构

```
┌─────────────────────────────────────────────────────────────┐
│                        顶部操作栏                             │
├──────────┬──────────────────────────────────────────────────┤
│          │                                                  │
│  侧边导航  │              中间内容展示区                       │
│          │                                                  │
│  - 报告库  │                                                  │
│  - 文献库  │                                                  │
│  - 系统设置 │                                                  │
│          │                                                  │
└──────────┴──────────────────────────────────────────────────┘
```

### 2.3 配色方案

#### 浅色模式
| 元素 | 颜色 |
|------|------|
| 主色 | #4A90D9 |
| 次色 | #6BB3F0 |
| 背景 | #F5F7FA |
| 卡片背景 | #FFFFFF |
| 文字主色 | #333333 |
| 文字次色 | #666666 |
| 边框 | #E0E4E8 |
| 成功 | #52C41A |
| 警告 | #FAAD14 |
| 错误 | #F5222D |

#### 深色模式
| 元素 | 颜色 |
|------|------|
| 主色 | #4A90D9 |
| 次色 | #6BB3F0 |
| 背景 | #1E1E1E |
| 卡片背景 | #2D2D2D |
| 文字主色 | #E8E8E8 |
| 文字次色 | #A0A0A0 |
| 边框 | #404040 |
| 成功 | #52C41A |
| 警告 | #FAAD14 |
| 错误 | #F5222D |

### 2.4 字体规范
- **主字体**：Microsoft YaHei UI, SimHei, sans-serif
- **标题**：14px 粗体
- **正文**：12px 常规
- **辅助文字**：11px

### 2.5 间距规范
- **侧边栏宽度**：180px
- **顶部操作栏高度**：50px
- **卡片间距**：12px
- **按钮内边距**：8px 16px
- **列表行高**：40px

---

## 3. 功能模块详细规范

### 3.1 主界面框架

#### 侧边导航栏
- 固定宽度180px
- 三个导航项：报告库、文献库、系统设置
- 当前选中项高亮显示
- 导航切换时内容区无缝切换

#### 顶部操作栏
- 高度50px
- 左侧：应用Logo和标题
- 右侧：搜索框、全局快捷操作
- 高度50px固定

#### 内容展示区
- 报告库视图
- 文献库视图
- 系统设置视图
- 报告编辑视图

---

### 3.2 探索报告模块

#### 3.2.1 报告列表
**展示字段**：
- 报告标题
- 创建时间
- 修改时间
- 关联文献数量

**操作功能**：
- 关键词搜索
- 按时间升序/降序排序
- 右键菜单：查看、编辑、导出、删除

**删除逻辑**：仅删除报告记录，不删除已关联PDF文件

#### 3.2.2 新建报告
**新建模式**：
1. 空白报告：自由从零编写
2. 模板报告：内置标准科学探究固定模板

**模板固定结构**：
```
1. 探索主题
2. 背景介绍
3. 提出问题
4. 猜想与假设
5. 实验材料与工具
6. 实验步骤
7. 实验数据与现象
8. 分析与结论
9. 反思与改进
10. 参考文献
```

**必填项**：报告标题（不能为空、不能重名）

#### 3.2.3 报告编辑
- 富文本编辑：支持常规文字排版、分段、列表
- 自动保存：每5分钟自动存盘
- 关闭未保存弹窗二次确认
- 底部关联文献管理：添加/移除关联文献

#### 3.2.4 报告查看
- 只读模式
- 关联文献列表可直接点击打开对应PDF

#### 3.2.5 报告导出
- **TXT**：保留纯文本与章节结构
- **DOCX**：保留排版、章节层级
- 可自选保存路径、自定义文件名

---

### 3.3 文献管理模块

#### 3.3.1 PDF上传
- 仅支持PDF格式
- 支持单文件/批量多文件上传
- 自动复制到APP专属存储目录
- 默认沿用原文件名作为文献名称

#### 3.3.2 PDF查看
- 双击或右键「查看」
- 调用电脑默认PDF阅读器打开

#### 3.3.3 文献分类
- 默认分类：未分类
- 支持：新建分类、重命名分类、删除分类
- 文献可自由移动到任意分类
- 删除分类后下属文献自动归到「未分类」

#### 3.3.4 文献管理操作
- 列表支持搜索、分类筛选
- 右键功能：查看、重命名、移动分类、删除
- 删除文献：二次确认，同时删除库记录+本地源文件

#### 3.3.5 报告与文献关联
- 一篇报告可绑定多篇PDF
- 一篇文献可被多篇报告关联
- 可随时添加关联、解除关联

---

### 3.4 系统设置模块

#### 3.4.1 数据备份与恢复
- 备份内容：SQLite数据库 + 全部PDF文献
- 备份格式：ZIP压缩包
- 恢复：选择备份包，一键覆盖恢复，恢复前弹窗提醒

#### 3.4.2 存储路径设置
- 可自定义：数据库存储路径、PDF文献存储路径
- 修改路径后自动迁移已有全部数据

#### 3.4.3 主题切换
- 浅色模式
- 深色模式
- 点击立即生效，无需重启

---

## 4. 数据模型

### 4.1 数据库表结构

```sql
-- 报告表
CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title VARCHAR(200) NOT NULL UNIQUE,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    modified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_template BOOLEAN DEFAULT FALSE
);

-- 文献表
CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(200) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    category_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

-- 分类表
CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(100) NOT NULL UNIQUE,
    is_default BOOLEAN DEFAULT FALSE
);

-- 报告-文献关联表
CREATE TABLE report_documents (
    report_id INTEGER,
    document_id INTEGER,
    PRIMARY KEY (report_id, document_id),
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 系统设置表
CREATE TABLE settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT
);
```

### 4.2 默认数据初始化
- 初始化默认分类「未分类」（is_default=True）
- 初始化系统设置（主题、路径等）

---

## 5. 验收标准

### 5.1 功能验收
- [ ] 所有PRD功能全部实现
- [ ] 核心流程走通：新建报告→编辑→关联PDF→导出
- [ ] 备份恢复数据完整，关联关系不丢失

### 5.2 性能要求
- 启动时间 ≤ 3秒
- 百条列表秒加载
- 导出无卡顿

### 5.3 稳定性要求
- 关键操作均有弹窗确认
- 无闪退、无数据丢失
- 自动防丢稿（自动保存）

---

## 6. 项目结构

```
CuriosityTrail/
├── main.py                 # 程序入口
├── config.py               # 配置文件
├── database.py             # 数据库模块
├── models/                 # 数据模型
│   ├── __init__.py
│   ├── report.py
│   ├── document.py
│   └── category.py
├── views/                   # 界面视图
│   ├── __init__.py
│   ├── main_window.py
│   ├── report_view.py
│   ├── document_view.py
│   └── settings_view.py
├── widgets/                 # 自定义组件
│   ├── __init__.py
│   ├── sidebar.py
│   ├── report_editor.py
│   └── dialogs.py
├── services/                # 业务逻辑
│   ├── __init__.py
│   ├── report_service.py
│   ├── document_service.py
│   ├── export_service.py
│   └── backup_service.py
├── utils/                   # 工具函数
│   ├── __init__.py
│   ├── theme.py
│   └── helpers.py
├── assets/                  # 静态资源
│   └── icon.ico
├── data/                    # 数据存储目录（运行时创建）
├── documents/               # PDF存储目录（运行时创建）
├── SPEC.md                  # 本文档
└── requirements.txt         # 依赖清单
```

---

## 7. 依赖清单

```
PyQt5>=5.15.0
python-docx>=0.8.11
PyMuPDF>=1.23.0
pyinstaller>=5.13.0
```
