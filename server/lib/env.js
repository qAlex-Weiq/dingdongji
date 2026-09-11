'use strict';

/**
 * 零依赖 .env 加载器：项目启动时读取根目录 .env（若存在），
 * 将 KEY=VALUE 注入 process.env，不覆盖已有环境变量。
 * 便于本地开发时配置 AMAP_KEY / LLM_API_KEY 等凭据。
 */

const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;

    const key = m[1];
    let val = m[2].trim();
    // 去掉成对引号
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv();
