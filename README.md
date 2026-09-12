# 订懂机 · 旅行规划

一个轻量的旅行规划演示项目，按「**车票 / 酒店 / 景点 / 美食 / 行程规划**」五大内容模块 + 「设置」组织。每模块独立路由、独立数据源，前后端分离、统一 UI 风格。

> **核心亮点**：行程规划页 (`/plan.html`) 由**确定性算法**编排（哪天去哪、几点到几点、按行政区聚类、按就近原则配餐），LLM 仅撰写每日说明（summary）——**结构透明可审计，文案由 Agent 润色**。

## 模块概览

| 模块 | 路径 | 状态 | 主要能力 |
|---|---|---|---|
| 车票 | `/ticket.html` | 可用 | 机票 + 火车票同屏对比，按价格/时长排序，出发 ⇄ 到达城市交换 |
| 酒店 | `/hotel.html` | 可用 | 三档偏好 + 行政区 + 价格区间筛选，详情地图弹窗 |
| 景点 | `/sight.html` | 可用 | 综合排序（评分 × 距离 × 门票）、来源标注、地图弹窗 |
| 美食 | `/food.html` | 可用 | 特色菜品推荐 / 餐厅筛选（菜系、人均、营业时段、营业中）/ 个性化推荐（自然语言需求） |
| 行程规划 | `/plan.html` | 可用 | 一键智能规划（目的地 + 日期 + 天数 + 偏好 + 同行人）/ 行程篮（跨页面 localStorage）/ AI 建议采纳与移除 / 时间轴 / 行前避坑与装备贴士 / 一键复制微信便签 |
| 设置 | `/settings.html` | 可用 | 全局 LLM Key 与网络代理配置 / 联网测试 |

## 快速开始

```bash
npm install
npm start
# 打开 http://localhost:3000
```

> Node ≥ 18（package.json `engines.node` 已声明）。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cities` | 全部支持的城市列表（各模块共享） |
| GET | `/api/ticket/search` | 机票 + 火车票查询 |
| GET | `/api/hotel/search` | 酒店搜索（档位 / 价格区间 / 行政区） |
| GET | `/api/hotel/sources` | 当前酒店数据来源声明 |
| GET | `/api/sight/search` | 景点搜索（综合排序） |
| GET | `/api/sight/sources` | 当前景点数据来源声明 |
| GET | `/api/food/cuisines` | 菜系列表 |
| GET | `/api/food/specialties?city=&category=` | 目的地特色菜品 |
| GET | `/api/food/restaurants?city=&cuisines=&priceMin=&priceMax=&slot=&openNow=&sort=` | 餐厅筛选 |
| POST | `/api/food/personalize` | 个性化推荐（body: `{city, query}`） |
| GET | `/api/settings` | 读取当前 LLM / 代理设置 |
| PUT | `/api/settings` | 写入 LLM / 代理设置 |
| POST | `/api/settings/test` | 联网测试当前设置 |
| POST | `/api/plan` | 行程篮 → 确定性编排 + Agent 文案（body: `{city, days, startDate, items, autoFill}`） |

## 行程规划 · 架构小记

`server/lib/itinerary.js` 的 `buildItinerary()` 是**纯函数**——不触网、不调用 LLM。

编排流程（详见 `itinerary.js` 顶端注释）：
1. **解析行程篮** —— 按 `type` 分桶（ticket / hotel / sight / food / dish）
2. **行政区聚类** —— 用 `lib/district` 从地址推导行政区，同区景点尽量同天
3. **时段编排** —— 每天 ≤ `DAILY_BUDGET_H` 小时，按 `visitHours` 填充
4. **就近配餐** —— 餐厅含真实经纬度，用 haversine 选距当天景点最近者
5. **首尾锚定** —— 抵达车次决定 Day 1 起始时间，返程车次收束末日
6. **LLM 撰写每日 summary** —— 在 `planner.js` 单独进行，仅润色，不改结构

行前避坑与装备贴士来自 `public/js/plan.js` 的本地城市知识库，**瞬时可用、不依赖 LLM**。

## 测试

```bash
node scripts/smoke-test.js                 # 38 项端点 + 资源可达
node scripts/e2e-check.js                  # 完整 e2e（需 Playwright Chromium）
node scripts/test-itinerary.js             # 行程编排纯函数
node scripts/test-strict-tier-filter.js    # 偏好硬性约束
node scripts/test-price-clamps.js          # 价格钳制
node scripts/test-train-multistation.js    # 多站点火车
```

## 演示数据来源说明

`server/data/` 内的演示数据均为**为本次演示原创编写的虚构占位数据**，并非来自任何真实平台。

- `food.js` —— 18 个菜系 / 65 道特色菜 / 80+ 家餐厅 / 城市地标 / 营业时间 / 人均消费
- `hotels.js` / `sights.js` —— 占位商品 + 真实经纬度（用于地图弹窗与就近配餐）
- `cities.js` —— 8 个支持城市

**目的**：

- 让前端能完整跑通"查 / 筛 / 排"三大交互
- 让 e2e / smoke 脚本有可重复断言的稳定 fixture
- 让协作成员在没接入真实数据源时也能本地启动与调试

### 替换为真实数据

`server/providers/` 暴露的 async 函数（`getSpecialties` / `searchRestaurants` / `personalize` / `searchHotels` / `searchSights`）均与 flight / train provider 同风格。接入真实数据时只需：

- 替换实现为对真实 API 的调用（高德 / 美团 / 携程 / 自有后台等）
- 或改为读数据库 / 缓存，保持同名 + 同返回结构即可
- 路由层 `server/routes/*.js` 与前端 `public/*.html` 不需要改动

如需在 `server/data/` 之外放置真实数据文件（如 `food.local.js`），把它加入 `.gitignore` 即可。

## 目录结构

```
server/
  app.js                  # Express 入口（路由挂载）
  index.js                # 启动脚本
  routes/                 # HTTP 路由（6 个模块）
  providers/              # 数据提供层（flight / train / hotel / sight / food / LLM）
  lib/                    # 工具（geo / district / random / planner / itinerary 等）
  data/                   # 演示数据（hotels.js / sights.js / food.js / cities.js）
public/
  index.html              # 首页（hero + 四模块入口）
  ticket.html / hotel.html / sight.html / food.html / plan.html / settings.html
  css/                    # 全局样式 + 各模块扩展
  js/                     # 前端逻辑（含 cart.js 跨页面共享「行程篮」）
docs/
  DEMO_VIDEO_SCRIPT.md    # 产品演示视频脚本
scripts/
  smoke-test.js           # 端点 + 边界
  e2e-check.js            # Playwright 端到端
  test-*.js               # 各模块单元 / 集成测试
  shot-*.js               # 截图工具
```

## 协作约定

- UI 风格统一收敛在 `public/css/style.css`；新增模块沿用 `.search-card` / `.field` / `.pill` / `.btn-secondary` / `.result-section` 等约定
- 后端 provider **异步、同返回结构**，便于替换实现
- 提交前跑一遍 `smoke-test.js`；涉及前端改动跑 `e2e-check.js`
- `.pilotdeck/` 与 `.settings.json` 被 `.gitignore` 排除（个人 work / 截图 / 临时配置）
