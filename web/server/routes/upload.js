const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const router = express.Router();

// 统一走 DATA_DIR：容器可替换，容器内相对路径不持久
const uploadsDir = config.uploadsDir;

/**
 * mimetype → 落盘扩展名的映射表。
 *
 * 扩展名只能由这张表决定，不能取自客户端传的 originalname：
 * mimetype 是客户端声明的 Content-Type，originalname 更是纯客户端输入，
 * 两者都不可信。之前从 originalname 取扩展名，攻击者可以声明 image/png
 * 上传 x.html，落盘成 .html 后被 /uploads 静态服务当 HTML 返回，
 * 构成存储型 XSS（在应用源下执行脚本，以登录身份调接口）。
 */
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = EXT_BY_MIME[file.mimetype] || '.png';
    cb(null, 'image-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: function (req, file, cb) {
    if (EXT_BY_MIME[file.mimetype]) {
      cb(null, true);
    } else {
      // 带 400：这是客户端传错了文件，不是服务器故障。
      // 统一错误处理按 status 决定把 message 还是"内部错误"给前端。
      cb(Object.assign(new Error('只支持图片格式'), { status: 400 }));
    }
  }
});

router.post('/image', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择图片文件' });
    }
    
    const imageUrl = `/uploads/${req.file.filename}`;
    res.json({ url: imageUrl, filename: req.file.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/image/:filename', (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(uploadsDir, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '文件不存在' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;