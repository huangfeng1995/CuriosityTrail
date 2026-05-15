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

app.use('/api/categories', categoriesRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/export', exportRouter);
app.use('/api/graph', graphRouter);

app.use(express.static(path.join(__dirname, '../client/dist')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
