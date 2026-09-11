# 叮咚机 · 旅行规划

一个轻量的旅行规划演示项目，按「**车票 / 酒店 / 景点 / 美食**」四大模块组织。每模块独立路由、独立数据源，前后端分离、统一 UI 风格。

## 模块概览

| 模块 | 路径 | 状态 | 主要能力 |
|---|---|---|---|
| 车票 | `/ticket.html` | 可用 | 机票 + 火车票同屏对比，按价格/时长排序，出发 ⇄ 到达城市交换 |
| 酒店 | `/hotel.html` | 占位 | 预留入口 |
| 景点 | `/sight.html` | 占位 | 预留入口 |
| 美食 | `/food.html` | 可用 | 特色菜品推荐 / 餐厅筛选（菜系、人均、营业时段、营业中）/ 个性化推荐（自然语言需求） |

## 快速开始

```bash
npm install
npm start
# 打开 http://localhost:3000
```

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cities` | 全部支持的城市列表（各模块共享） |
| GET | `/api/ticket/search` | 机票 + 火车票查询 |
| GET | `/api/food/cuisines` | 菜系列表 |
| GET | `/api/food/specialties?city=&category=` | 目的地特色菜品 |
| GET | `/api/food/restaurants?city=&cuisines=&priceMin=&priceMax=&slot=&openNow=&sort=` | 餐厅筛选 |
| POST | `/api/food/personalize` | 个性化推荐（body: `{city, query}`） |

## 测试

```bash
node scripts/smoke-test.js   # 38 项端点 + 资源可达
node scripts/e2e-check.js    # 完整 e2e 流程（需 Playwright Chromium）
```

## 美食模块 · 数据来源说明

`server/data/food.js` 内的所有数据（**18 个菜系 / 65 道特色菜 / 80+ 家餐厅 / 城市地标 / 营业时间 / 人均消费**等）均为 **为本次演示原创编写的虚构占位数据**，并非来自任何真实餐饮平台。

目的：

- 让前端能完整跑通"查菜 / 筛餐厅 / 个性化推荐"三种交互
- 让 e2e / smoke 脚本有可重复断言的稳定 fixture
- 让协作成员在没接入真实数据源时也能本地启动与调试

### 替换为真实数据

`server/providers/foodProvider.js` 暴露三个 async 函数（`getSpecialties` / `searchRestaurants` / `personalize`），与现有 flight / train provider 同风格。接入真实数据时只需：

- 替换三个函数实现为对真实 API（大众点评 / 美团 / 携程 / 高德 / 自有后台等）的调用
- 或改为读数据库 / 缓存，保持同名 + 同返回结构即可
- 路由层 `server/routes/food.js` 与前端 `/public/food.html` 不需要改动

如需在 `server/data/` 之外放置真实数据文件（如 `food.local.js`），把它加入 `.gitignore` 即可。

## 目录结构

```
server/
  app.js                # Express 入口
  index.js              # 启动脚本
  data/                 # 演示数据（food.js / cities.js）
  providers/            # 数据提供层（flight / train / food）
  routes/               # 路由
  lib/                  # 工具（geo / 随机等）
public/
  *.html                # 4 个模块页面
  css/style.css         # 全局样式 + 各模块扩展
  js/                   # 前端逻辑
scripts/
  smoke-test.js         # 端点 + 边界
  e2e-check.js          # Playwright 端到端
```

## 协作约定

- UI 风格统一收敛在 `public/css/style.css`；新增模块沿用 `.search-card` / `.field` / `.tab` / `.chip` / `.result-section` 等约定
- 后端 provider 异步、同返回结构，便于替换实现
- 提交前跑一遍 `smoke-test.js`；涉及前端改动跑 `e2e-check.js`
- `.pilotdeck/` 目录被 `.gitignore` 排除（个人 work / 截图 / 辅助脚本）
