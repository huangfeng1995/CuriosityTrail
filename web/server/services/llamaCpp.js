const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class LlamaCppService {
  constructor() {
    this.modelPath = '/Users/openclaw/Downloads/qwen2_05b_int4.gguf';
    this.llamaPath = null;
    this.initialized = false;
    this.findLlamaCpp();
  }

  findLlamaCpp() {
    const possiblePaths = [
      '/usr/local/bin/llama-cli',
      '/usr/bin/llama-cli',
      path.join(__dirname, '../../../../llama.cpp/main'),
      path.join(__dirname, '../../../llama.cpp/main'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        this.llamaPath = p;
        this.initialized = true;
        break;
      }
    }
  }

  isAvailable() {
    return this.initialized && fs.existsSync(this.modelPath);
  }

  async generate(options = {}) {
    const {
      prompt,
      temperature = 0.7,
      maxTokens = 512,
      nCtx = 2048
    } = options;

    if (!this.isAvailable()) {
      throw new Error('llama.cpp 不可用或模型文件不存在');
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-m', this.modelPath,
        '-p', prompt,
        '-n', maxTokens.toString(),
        '-c', nCtx.toString(),
        '--temp', temperature.toString(),
        '--top-p', '0.9',
        '--repeat-last-n', '64',
        '--repeat-penalty', '1.1',
        '--no-display-prompt'
      ];

      const child = spawn(this.llamaPath, args);
      let output = '';

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.stderr.on('data', (data) => {
        console.error('llama.cpp error:', data.toString());
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({
            success: true,
            response: output.trim()
          });
        } else {
          reject(new Error(`llama.cpp 退出码: ${code}`));
        }
      });

      child.on('error', (error) => {
        reject(error);
      });
    });
  }
}

module.exports = new LlamaCppService();
