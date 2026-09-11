'use strict';

const path = require('path');
const express = require('express');
const apiRouter = require('./routes/search');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // ---- API ----
  app.use('/api', apiRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

  // ---- 前端静态资源 ----
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

module.exports = { createApp };
