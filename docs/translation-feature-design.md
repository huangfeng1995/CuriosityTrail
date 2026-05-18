# 翻译功能设计方案

## 📋 功能概述

为 Curiosity Trail 添加翻译功能，支持三种场景：
1. **报告翻译**：在报告编辑器中翻译整篇报告或选中文字
2. **文献翻译**：在文献库中翻译 PDF 文献
3. **AI 助手翻译**：在 AI 助手中翻译任意文本

---

## 🎨 前端界面设计

### 1. 报告编辑器翻译功能

**位置**：报告编辑器工具栏

**界面元素**：
```
┌─────────────────────────────────────────┐
│ 报告编辑器                                │
├─────────────────────────────────────────┤
│ [保存] [导出▼] [翻译▼] [预览]             │
├─────────────────────────────────────────┤
│                                         │
│  报告内容...                            │
│  (支持选中文字翻译)                      │
│                                         │
└─────────────────────────────────────────┘
```

**翻译按钮下拉菜单**：
- 翻译整篇报告
- 翻译选中文字（选中文字时可用）
- 翻译设置

**翻译结果展示**：
- 弹窗显示翻译结果
- 提供"替换原文"、"复制翻译"、"关闭"按钮

---

### 2. 文献库翻译功能

**位置**：文献列表项操作按钮

**界面元素**：
```
┌─────────────────────────────────────────┐
│ 文献库                                   │
├─────────────────────────────────────────┤
│ 📄 论文1.pdf                            │
│    [查看] [编辑] [翻译] [删除]           │
│                                         │
│ 📄 论文2.pdf                            │
│    [查看] [编辑] [翻译] [删除]           │
└─────────────────────────────────────────┘
```

**翻译流程**：
1. 点击"翻译"按钮
2. 弹窗选择翻译选项：
   - 翻译方式：OCR + 翻译 / 直接翻译（如果 PDF 包含文本）
   - 目标语言：中文 / 英文 / 日文 / ...
   - 输出格式：新建文档 / 覆盖原文
3. 显示翻译进度
4. 翻译完成后预览结果

---

### 3. AI 助手翻译功能

**位置**：AI 助手对话界面

**界面元素**：
```
┌─────────────────────────────────────────┐
│ AI 助手                                  │
├─────────────────────────────────────────┤
│ 用户: 帮我翻译这段文字...                │
│ 助手: 翻译结果...                        │
│                                         │
│ [快捷翻译▼] [发送]                       │
└─────────────────────────────────────────┘
```

**快捷翻译菜单**：
- 翻译为中文
- 翻译为英文
- 翻译为日文
- 自定义翻译

**对话示例**：
```
用户: 翻译这段文字：Hello World
助手: 翻译结果：你好世界

用户: 把这篇报告翻译成英文
助手: 好的，我来帮你翻译这篇报告...
```

---

### 4. 翻译设置界面

**位置**：系统设置页面新增"翻译设置"标签

**界面元素**：
```
┌─────────────────────────────────────────┐
│ 系统设置                                 │
├─────────────────────────────────────────┤
│ [主题] [翻译设置] [备份] [关于]          │
├─────────────────────────────────────────┤
│                                         │
│ 翻译服务                                 │
│ ○ MiniMax API (云端，需 API Key)        │
│ ○ Ollama (本地，需运行 Ollama)          │
│                                         │
│ MiniMax API Key: [________________]     │
│                                         │
│ Ollama 地址: [http://localhost:11434]   │
│ Ollama 模型: [llama3.2:3b ▼]            │
│                                         │
│ 默认目标语言: [中文 ▼]                   │
│                                         │
│ [保存设置]                              │
└─────────────────────────────────────────┘
```

---

## 🔧 后端架构设计

### 1. 翻译服务抽象层

```javascript
// 翻译服务接口
interface TranslationService {
  translate(text: string, targetLang: string): Promise<string>;
  translateDocument(file: Buffer, targetLang: string): Promise<Buffer>;
  ocrAndTranslate(image: Buffer, targetLang: string): Promise<string>;
}

// MiniMax 翻译服务
class MiniMaxTranslationService implements TranslationService {
  // 使用 MiniMax API
}

// Ollama 翻译服务
class OllamaTranslationService implements TranslationService {
  // 使用本地 Ollama
}
```

### 2. API 路由设计

```
POST /api/translate/text          - 翻译文本
POST /api/translate/document      - 翻译文档
POST /api/translate/ocr           - OCR + 翻译
GET  /api/translate/status        - 获取翻译服务状态
POST /api/translate/settings      - 保存翻译设置
GET  /api/translate/settings      - 获取翻译设置
```

### 3. 数据库设计

```sql
-- 翻译设置表
CREATE TABLE translation_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 翻译历史表
CREATE TABLE translation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_text TEXT,
  translated_text TEXT,
  source_lang TEXT,
  target_lang TEXT,
  service TEXT,  -- 'minimax' or 'ollama'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 🚀 实现优先级

### Phase 1: 核心翻译功能（高优先级）
1. ✅ 翻译服务抽象层
2. ✅ MiniMax API 集成
3. ✅ Ollama 集成
4. ✅ 文本翻译 API
5. ✅ 翻译设置界面

### Phase 2: 报告翻译（高优先级）
1. ✅ 报告编辑器翻译按钮
2. ✅ 翻译整篇报告
3. ✅ 翻译选中文字
4. ✅ 翻译结果展示

### Phase 3: 文献翻译（中优先级）
1. ✅ 文献库翻译按钮
2. ✅ PDF OCR + 翻译
3. ✅ 翻译进度显示
4. ✅ 翻译结果保存

### Phase 4: AI 助手翻译（中优先级）
1. ✅ AI 助手翻译对话
2. ✅ 快捷翻译菜单
3. ✅ 翻译上下文记忆

---

## 📝 技术选型

### MiniMax API
- **优势**：专业翻译质量、支持文档处理、稳定可靠
- **劣势**：需要 API Key、网络依赖
- **适用场景**：正式翻译、文档翻译

### Ollama 本地模型
- **优势**：免费、隐私保护、离线可用
- **劣势**：翻译质量可能不如专业 API、需要本地资源
- **适用场景**：快速翻译、隐私敏感内容

---

## 🎯 用户交互流程

### 场景 1：翻译报告
1. 用户打开报告编辑器
2. 点击"翻译"按钮
3. 选择"翻译整篇报告"或"翻译选中文字"
4. 选择目标语言
5. 系统调用翻译服务
6. 显示翻译结果
7. 用户选择"替换原文"或"复制翻译"

### 场景 2：翻译文献
1. 用户在文献库找到 PDF
2. 点击"翻译"按钮
3. 选择翻译选项（OCR + 翻译 / 直接翻译）
4. 选择目标语言和输出格式
5. 系统显示翻译进度
6. 翻译完成，用户预览结果
7. 用户选择保存或下载

### 场景 3：AI 助手翻译
1. 用户在 AI 助手中输入"翻译这段文字：..."
2. 或使用快捷翻译菜单
3. AI 助手调用翻译服务
4. 返回翻译结果
5. 用户可以继续对话优化翻译

---

## 🔄 错误处理

### 网络错误
- MiniMax API 连接失败 → 提示用户检查网络或切换到 Ollama
- Ollama 连接失败 → 提示用户启动 Ollama 服务

### 配置错误
- API Key 无效 → 提示用户检查 API Key
- 模型不可用 → 提示用户下载模型

### 翻译错误
- 文本过长 → 分段翻译
- 语言不支持 → 提示用户选择支持的语言

---

## 📊 性能优化

### 缓存机制
- 缓存翻译结果，避免重复翻译
- 缓存翻译设置，减少数据库查询

### 批量翻译
- 长文本分段并行翻译
- 文档批量翻译

### 进度显示
- 实时显示翻译进度
- 支持取消翻译任务

---

## 🧪 测试计划

### 单元测试
- 翻译服务接口测试
- MiniMax API 调用测试
- Ollama 调用测试

### 集成测试
- 报告翻译流程测试
- 文献翻译流程测试
- AI 助手翻译流程测试

### 性能测试
- 长文本翻译性能
- 文档翻译性能
- 并发翻译性能

---

## 📅 时间估算

- Phase 1: 2-3 天
- Phase 2: 1-2 天
- Phase 3: 2-3 天
- Phase 4: 1-2 天

**总计**: 6-10 天

---

## 🎨 UI 组件清单

### 新增组件
1. `TranslationButton.jsx` - 翻译按钮组件
2. `TranslationModal.jsx` - 翻译结果弹窗
3. `TranslationSettings.jsx` - 翻译设置组件
4. `TranslationProgress.jsx` - 翻译进度组件

### 修改组件
1. `ReportEditor.jsx` - 添加翻译按钮
2. `Documents.jsx` - 添加翻译功能
3. `AgentAssistant.jsx` - 添加翻译对话支持
4. `Settings.jsx` - 添加翻译设置标签

---

## 📚 参考资料

- MiniMax API 文档: https://api.minimax.chat
- Ollama 文档: https://ollama.ai
- MiniMax Skills: https://github.com/MiniMax-AI/skills
