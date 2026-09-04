# 误杀归因平台 · 模块改造参考文档

> 本文档为「误杀样本分析 / 素材特征分类 / 误杀问题提需 / 结论沉淀」四大模块的**完整改造手册**。
> 每一模块下设：功能点清单、交互逻辑链、UI 设计、前端实现、后端实现、数据库表结构、涉及文件清单、改造注意事项。
> 文档内容均从当前代码（2026-08-06 代码快照）逐文件核对整理，可直接作为大规模改造的基线。

## 目录结构

```
docs/
├── README.md                          ← 本文件（总览 + 约定 + 时间窗口方案A）
├── 01-误杀样本分析.md
├── 02-素材特征分类.md
├── 03-误杀问题提需.md
├── 04-结论沉淀.md
└── 05-公共支撑与数据口径.md
```

## 项目技术栈基线

| 层 | 技术 | 说明 |
|----|------|------|
| 前端 | Vue 3 + Vite + Hash 路由 | 组件 `<script setup>`，状态用 Pinia store |
| UI | Tailwind 类 + 少量 `<style scoped>` | 设计令牌走 `src/style.css` 的 CSS 变量（`--brand` 等） |
| 图表 | ECharts（自封装 `EChart.vue`） | 柱状/饼/条形图 |
| 后端 | Node.js + Express（位于 `server/`） | 路由在 `server/src/routes/` |
| 数据库 | MySQL（库名 `<DB_NAME>`） | DDL 见 `server/src/db/schema.js` |
| AI 检索 | Python 微服务 TRAG（`server/trag_service/`） | 经 `server/src/routes/trag.js` + `server/src/trag/manager.js` 调用 |
| 鉴权 | 企微 tauth（`/ts:auth/tauth/info.ashx`） | `server/src/middleware/auth.js` 注入 `req.currentUser` |

## 角色模型（影响全部模块可见性）

- `submitter` 提需人：可看分析、分类、沉淀；可发起工单、采纳工单、新增/编辑沉淀。
- `handler` 处理人：可抢单、提交结论、修改问题分类。
- `admin` 管理员：额外可管理数据、用户、审批、删除工单/沉淀。
- 路由守卫见 `src/router/index.js`（`meta.roles`）。无角色用户仅能访问首页/申请页/我的权限页。

## 四大模块对应路由与文件

| 模块 | 前端路由 | 前端主文件 | 后端路由 | 核心表 |
|------|----------|------------|----------|--------|
| 误杀样本分析 | `/analysis`、`/analysis/tag/:id` | `src/views/analysis/AnalysisView.vue`、`TagDetailView.vue` | `server/src/routes/tags.js` | `real_data_tag_precision`、`real_data_samples`、`real_data_tag_precision_samples` |
| 素材特征分类 | `/classify` | `src/views/classify/ClassifyView.vue`、`PreviewAnnotate.vue`、`scriptClassify.js`、`ChatClassify.vue` | `server/src/routes/materials.js`、`classifyUpload.js` | `material_category`、`material_category_relation`、`material_conclusion`、`uploaded_classify_data` |
| 误杀问题提需 | `/tickets` | `src/views/tickets/TicketsView.vue` | `server/src/routes/tickets.js` | `tickets`、`ticket_timeline` |
| 结论沉淀 | `/sediment` | `src/views/sediment/SedimentView.vue` | `server/src/routes/sediments.js` | `sediments`、`sediment_updates` |

## 时间窗口方案 A（全模块联动基线）★

四个模块当前均围绕「**时间窗口**」展开数据联动。核心在前端 `DateRangeFilter` + 后端 `useSampleAggregation()`：

1. **无时间窗口（默认 / 全量）**：沿用精度聚合表 `real_data_tag_precision`（205 标签全量快照）。KPI、标签精度、FP 数为静态聚合值。
2. **窗口覆盖数据全量区间**：视为「全部时间」，仍走精度聚合表，避免「205 ↔ 88 子集」跳变。
3. **窗口为全量范围内的子集**：进入「明细实时聚合」——从 `real_data_samples` 按 `arrive_time` 实时重算：
   - 标签精度 = `(总样本 − FP) / 总样本 × 100`
   - `FP = SUM(is_fp)`
   - 整体样本数 / FP 数 / 查准率随之联动变化
4. **空 `arrive_time` 放行**：`sampleTimeWhere()` 对 `arrive_time IS NULL/''` 的样本不剔除，避免误杀真实 FP。

> 改造注意：任何「精度/样本数/FP 数」口径变更都必须同步判断 `useSampleAggregation()` 两条分支（聚合表 vs 样本明细表），否则会出现前后不一致。

## 数据口径（查准率定义）

查准率 = `TP / (TP + FP) × 100%`，等价于 `(总样本 − FP) / 总样本 × 100%`。
精度聚合表 `real_data_tag_precision` 自带 `tp`/`fp`/`fp_conf`/`tn`/`fn`/`precision_val`，优先级：
`SUM(tp)/NULLIF(SUM(tp)+SUM(fp),0)` → `SUM(precision_val*total)/SUM(total)` → `(SUM(total)-SUM(fp))/SUM(total)` → 0。

## 媒体预览三层兜底（全模块复用）

公共层 `src/utils/mediaPreview.js` 统一处理，所有素材图片/视频均复用：
1. **主路径**：`previewSrc()` 直连 CDN（含 `dis_t` 续期 + http→https 升级）。
2. **二级兜底**：直连失败 → `proxyUrl()` 走后端 `/api/media-proxy`（服务端腾讯内网续期 `dis_t` 代拉）。
3. **最终逃生**：代理失败 → 显示「↗ 原素材」新标签（`openOriginal()`）。
微信视频等必须签名 CDN 直连即失败，跳过代理直接走终路径。
