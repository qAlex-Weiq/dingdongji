'use strict';

const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;

const app = createApp();

app.listen(PORT, () => {
  console.log('[dingdongji] 叮咚机 · 行程助手已启动');
  console.log(`[dingdongji] 请访问 http://localhost:${PORT}`);
});
