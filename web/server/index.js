const express = require('express');
const cors = require('cors');
const path = require('path');
const fileUpload = require('express-fileupload');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(fileUpload());

const categoriesRouter = require('./routes/categories');
const reportsRouter = require('./routes/reports');
const documentsRouter = require('./routes/documents');
const exportRouter = require('./routes/export');
const graphRouter = require('./routes/graph');
const agentRouter = require('./routes/agent');

app.use('/api/categories', categoriesRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/export', exportRouter);
app.use('/api/graph', graphRouter);
app.use('/api/agent', agentRouter);

// 先检查是否有 Docker 环境下的 public 目录，再检查本地开发的 dist
const staticPath = path.join(__dirname, 'public');
const fallbackPath = path.join(__dirname, '../client/dist');

if (require('fs').existsSync(staticPath)) {
  app.use(express.static(staticPath));
} else {
  app.use(express.static(fallbackPath));
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  const indexPath = require('fs').existsSync(staticPath) 
    ? path.join(staticPath, 'index.html') 
    : path.join(fallbackPath, 'index.html');
  res.sendFile(indexPath);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
