const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3002;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>下载 Curiosity Trail</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            max-width: 600px; 
            margin: 40px auto; 
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
          }
          .card {
            background: white;
            padding: 40px;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
          }
          h1 { color: #333; margin-bottom: 20px; }
          .btn {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 16px 40px;
            font-size: 18px;
            text-decoration: none;
            border-radius: 8px;
            margin: 20px 0;
            font-weight: bold;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            transition: transform 0.2s;
          }
          .btn:hover { transform: translateY(-2px); }
          .instructions {
            text-align: left;
            margin-top: 30px;
            padding: 20px;
            background: #f8f9fa;
            border-radius: 8px;
          }
          .step { margin: 12px 0; }
          .step code { background: #e9ecef; padding: 4px 8px; border-radius: 4px; font-family: monospace; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🎉 Curiosity Trail 下载</h1>
          <p style="color: #666; font-size: 16px; line-height: 1.6;">
            点击下方按钮下载项目压缩包到你自己的电脑
          </p>
          <a href="/download" class="btn">
            📥 下载 curiosity-trail-web.zip
          </a>
          
          <div class="instructions">
            <h3 style="margin-top: 0; color: #333;">快速开始</h3>
            <h4 style="color: #667eea; margin-bottom: 10px;">✨ 给太太用？部署到云端！</h4>
            <p style="margin: 0 0 15px 0; color: #666;">压缩包里有 <code>DEPLOY.md</code> 部署指南，按照步骤几分钟就能搞定！免费稳定～</p>
            
            <h4 style="color: #667eea; margin-bottom: 10px; margin-top: 20px;">💻 自己电脑上运行</h4>
            <div class="step">1️⃣ 下载并解压 <code>curiosity-trail-web.zip</code></div>
            <div class="step">2️⃣ 安装 Node.js (从 nodejs.org 下载)</div>
            <div class="step">3️⃣ 打开终端，进入 <code>web/server</code> 文件夹</div>
            <div class="step">4️⃣ 运行 <code>npm install</code></div>
            <div class="step">5️⃣ 运行 <code>npm start</code></div>
            <div class="step">6️⃣ 在浏览器打开 <code>http://localhost:3001</code></div>
          </div>
        </div>
      </body>
      </html>
    `);
  } else if (req.url === '/download') {
    const filePath = path.join(__dirname, 'curiosity-trail-web.zip');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="curiosity-trail-web.zip"');
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`📥 下载服务器运行在 http://localhost:${PORT}`);
});
