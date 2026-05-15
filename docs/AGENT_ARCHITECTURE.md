# CuriosityTrail Agent 系统架构设计

## 🎯 架构概览

基于主流 Agent 架构（LangChain Agent、AutoGPT、CrewAI），设计一个专为科学探索记录优化的知识探索 Agent 系统。

---

## 🏗️ 核心架构组件

### 1. **Agent Orchestrator（Agent 编排器）**
负责协调整个 Agent 工作流程的核心引擎

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Orchestrator                     │
├─────────────────────────────────────────────────────────┤
│  1. 理解用户意图 (Intent Understanding)                  │
│  2. 规划任务路径 (Task Planning)                         │
│  3. 编排工具调用 (Tool Orchestration)                   │
│  4. 管理执行流程 (Execution Flow)                        │
│  5. 处理结果整合 (Result Integration)                   │
└─────────────────────────────────────────────────────────┘
```

### 2. **Tool System（工具系统）**
Agent 可以调用的各种工具

```
Tools
├── 🔍 Research Tools (研究工具)
│   ├── WebSearch - 网络搜索
│   ├── LiteratureSearch - 文献搜索
│   └── KnowledgeGraphQuery - 知识图谱查询
│
├── 📝 Writing Tools (写作工具)
│   ├── ReportGenerator - 报告生成
│   ├── ContentExpander - 内容扩展
│   ├── SummaryGenerator - 摘要生成
│   └── OutlineGenerator - 大纲生成
│
├── 🧠 Analysis Tools (分析工具)
│   ├── KeywordExtractor - 关键词提取
│   ├── CitationAnalyzer - 引用分析
│   ├── ContentAnalyzer - 内容分析
│   └── TrendAnalyzer - 趋势分析
│
└── 📊 Visualization Tools (可视化工具)
    ├── GraphBuilder - 图谱构建
    └── ChartGenerator - 图表生成
```

### 3. **Memory System（记忆系统）**
三层记忆架构，模拟人类认知

```
Memory System
├── 🧺 Short-term Memory (短期记忆)
│   └── 当前会话上下文（最近 N 条对话）
│
├── 🗄️ Long-term Memory (长期记忆)
│   ├── 报告历史
│   ├── 文献库
│   └── 知识图谱
│
└── 📋 Semantic Memory (语义记忆)
    └── 提取的知识、概念、关系
```

### 4. **Planning Engine（规划引擎）**
将复杂任务分解为可执行的步骤

```
Planning
├── 任务拆解 (Task Decomposition)
│   └── 将复杂目标分解为子任务
│
├── 执行计划 (Execution Plan)
│   ├── 顺序执行
│   ├── 并行执行
│   └── 条件执行
│
└── 反思优化 (Reflection & Refinement)
    └── 评估结果，优化下一步
```

---

## 🔄 Agent 工作流程

### 典型交互流程

```
用户: "帮我研究光合作用的最新进展"

    ↓
    
[1. 意图理解]
    ↓
    分析用户意图：主题探索 + 最新进展调研
    
    ↓
    
[2. 任务规划]
    ↓
    分解任务：
    - 搜索最新研究文献
    - 分析关键发现
    - 整理研究趋势
    - 生成调研报告
    
    ↓
    
[3. 工具调用]
    ↓
    Tool: WebSearch
    Tool: LiteratureSearch
    Tool: ContentAnalyzer
    Tool: ReportGenerator
    
    ↓
    
[4. 结果整合]
    ↓
    整合所有工具输出
    生成结构化报告
    
    ↓
    
[5. 知识沉淀]
    ↓
    保存到报告库
    更新知识图谱
    提取关键词
    
    ↓
    
[6. 反馈输出]
    ↓
    向用户展示结果
    询问是否需要深入
```

---

## 🎯 核心功能模块

### 1. **智能写作助手**
- 📝 基于模板生成报告
- ✨ 内容自动扩展和优化
- 📋 大纲生成和调整
- 🔍 逻辑检查和改进建议

### 2. **文献分析引擎**
- 📚 批量分析 PDF 文献
- 🎯 提取关键信息
- 🔗 识别引用关系
- 📊 生成摘要和要点

### 3. **知识探索向导**
- 🔬 引导式科学探究
- 📈 研究趋势分析
- 🎯 关键问题识别
- 💡 假设生成和验证

### 4. **研究助手**
- 🔍 相关文献推荐
- 📝 研究方向建议
- 🎯 假设检验支持
- 📊 数据分析建议

---

## 🛠️ 技术实现架构

### 后端架构

```
server/
├── agent/
│   ├── orchestrator.js          # Agent 编排器核心
│   ├── planner.js               # 任务规划引擎
│   ├── memory/
│   │   ├── shortTerm.js         # 短期记忆
│   │   ├── longTerm.js          # 长期记忆
│   │   └── semantic.js          # 语义记忆
│   └── tools/
│       ├── research.js           # 研究工具
│       ├── writing.js            # 写作工具
│       ├── analysis.js           # 分析工具
│       └── visualization.js     # 可视化工具
│
├── routes/
│   ├── agent.js                 # Agent API 路由
│   └── chat.js                  # 对话 API 路由
│
└── services/
    ├── ollama.js                # Ollama 模型服务
    └── prompt.js                # 提示词管理
```

### 前端架构

```
client/src/
├── components/
│   ├── AgentChat.jsx            # Agent 对话界面
│   ├── AgentPanel.jsx           # Agent 控制面板
│   ├── ToolSelector.jsx         # 工具选择器
│   └── MemoryViewer.jsx         # 记忆查看器
│
├── hooks/
│   ├── useAgent.js              # Agent 状态管理
│   ├── useTools.js              # 工具调用管理
│   └── useMemory.js             # 记忆管理
│
└── store/
    └── agentStore.js           # Agent 全局状态
```

---

## 🔌 模型集成

### Ollama 本地模型

```javascript
// 支持的模型
const MODELS = {
  // 通用意图理解
  intent: 'llama3.2:3b',
  
  // 写作和生成
  writer: 'llama3.2:3b',
  
  // 分析和推理
  analyzer: 'qwen2.5:7b',
  
  // 代码和技术任务
  coder: 'codellama:7b',
  
  // 轻量快速响应
  fast: 'llama3.2:1b'
}
```

---

## 📊 系统能力矩阵

| 功能 | 描述 | 工具依赖 | 模型建议 |
|------|------|---------|----------|
| 意图理解 | 理解用户查询意图 | - | llama3.2 |
| 任务规划 | 分解复杂任务 | - | qwen2.5 |
| 文献分析 | 提取文献关键信息 | PDF Reader | qwen2.5 |
| 报告生成 | 生成结构化报告 | ReportGenerator | llama3.2 |
| 内容扩展 | 扩展和完善内容 | ContentExpander | llama3.2 |
| 摘要生成 | 生成摘要和要点 | SummaryGenerator | qwen2.5 |
| 关键词提取 | 提取关键概念 | KeywordExtractor | qwen2.5 |
| 知识图谱 | 构建知识网络 | GraphBuilder | llama3.2 |

---

## 🚀 部署架构

### 开发环境
```
本地 Ollama (localhost:11434)
    ↓
Express API Server (localhost:3001)
    ↓
React Frontend (localhost:5173)
```

### 生产环境
```
用户本地 Ollama / 云端 Ollama
    ↓
Express API Server (Railway/Render)
    ↓
React Frontend (Vercel/Netlify)
```

---

## 📈 性能优化

1. **流式响应**：使用 Server-Sent Events 实现打字机效果
2. **缓存机制**：缓存常用查询结果
3. **异步处理**：长时间任务后台执行
4. **模型选择**：根据任务复杂度选择合适模型
5. **批量处理**：文献批量分析

---

## 🔒 安全考虑

1. **输入验证**：防止恶意提示词注入
2. **输出过滤**：过滤不当内容
3. **资源限制**：限制单次调用 token 数量
4. **日志审计**：记录所有 Agent 操作
5. **权限控制**：不同用户不同权限

---

## 🎯 下一步实现计划

1. ✅ 设计架构文档
2. ⏳ 实现 Ollama 集成
3. ⏳ 实现 Agent 编排器
4. ⏳ 实现工具系统
5. ⏳ 实现记忆系统
6. ⏳ 实现前端界面
7. ⏳ 测试和优化

---

## 💡 核心价值

这个 Agent 系统将帮助用户：

1. **降低研究门槛**：AI 引导式探究，降低科学探索难度
2. **提升效率**：自动化文献分析和报告生成
3. **发现洞察**：从知识图谱中发现隐藏关联
4. **持续学习**：记忆系统帮助积累知识
5. **协作增强**：人机协作，发挥各自优势
