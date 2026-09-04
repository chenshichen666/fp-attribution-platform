# AI 评测数据表字段说明

> 格式对齐「数据管理 · 字段说明」面板：每个字段含 **字段名称 / 中文名 / 类型 / 必填 / 关联状态 / 说明**。
>
> - 中文名、类型、必填：`ai_evaluate_detail` 与 `real_data_tag_precision` 取自前端 `fieldDefs` / `precisionFieldDefs` 元数据；`cluster_data`、`sediments` 取自后端真实建表语句 `server/src/db/schema.js`。
> - **关联状态**：以「数据管理」面板字段说明截图（AI评测明细）+ 字段说明界面实际检测规则为准。「已关联」= 上传/入库数据该列存在有效值；「未关联」= 该列全空或未提供。Cluster、Sediment 两表的关联状态为运行时按数据动态检测，下表按列语义与默认值标注通用预期，实际以当前库内数据为准。

---

## 一、AI评测明细数据 `ai_evaluate_detail`

| 字段名称 | 中文名 | 类型 | 必填 | 关联状态 | 说明 |
|----------|--------|------|------|----------|------|
| `first_level_industry_name` | AMS一级开户行业ID(短id) | VARCHAR | 是 | 已关联 | AMS一级开户行业ID |
| `second_level_industry_name` | AMS二级开户行业ID(长id) | VARCHAR | 是 | 已关联 | AMS二级开户行业ID |
| `element_type` | 审核元素类型 | VARCHAR | 是 | 已关联 | 物料元素类型代码（image/video/text等） |
| `element_type_name` | 审核元素类型/审核元素类型(翻译后) | VARCHAR | 是 | 已关联 | 元素类型中文名（图片/视频/文本/音频等） |
| `class_num` | 聚类类型 | INT | 否 | 未关联 | 聚类类型编号（数值） |
| `class_id` | 聚类ID | VARCHAR | 否 | 未关联 | 聚类簇ID（如c1表示聚类簇1，noise表示噪点） |
| `policy_ids` | 审核标签ID | VARCHAR | 是 | 已关联 | 机审命中策略标签ID列表，JSON数组格式如 [1001,1002] |
| `ai_evaluate_policy_ids` | AI评测人审标签 | VARCHAR | 是 | 已关联 | 人审评测策略标签ID列表，JSON数组格式如 [1001] |
| `element_value` | 审核元素值 | TEXT | 是 | 已关联 | 审核物料元素值（图片URL/视频URL/文本内容） |
| `ocr_text` | OCR内容 | TEXT | 否 | 已关联 | 图片/视频OCR文字识别内容（别名 ocr_test） |
| `asr_text` | ASR内容 | TEXT | 否 | 已关联 | 视频/音频语音识别内容（别名 asr_test） |
| `dc_id` | 创意ID(DCID) | VARCHAR | 否 | 已关联 | 创意ID(DCID) |
| `uid` | 广告主ID | VARCHAR | 否 | 已关联 | 广告主ID |
| `ops_advertiser_name` | 客户主体名称(OPS) | VARCHAR | 否 | 已关联 | 客户主体名称(OPS) |
| `agency_uid` | 代理商ID | VARCHAR | 否 | 未关联 | 代理商ID |
| `agency_name` | 代理商名称 | VARCHAR | 否 | 未关联 | 代理商名称 |
| `model_version` | 模型版本 | VARCHAR | 否 | 未关联 | 机审模型版本号 |
| `ai_evaluate_reviewer_name` | 审核人 | VARCHAR | 否 | 未关联 | 人审审核人员姓名 |
| `element_fingerprint` | 审核物理指纹（md5） | VARCHAR | 否 | 已关联 | 审核物理指纹（md5） |
| `arrive_time` | 到达时间 | DATE | 是 | 已关联 | 物料到达时间（YYYY-MM-DD） |
| `ds` | 日期分区 | VARCHAR | 是 | 已关联 | 数据日期分区（YYYY-MM-DD） |

> 备注：建表语句中该表另有 `id`（自增主键）、`evaluation_target_type` / `evaluation_target_type_name`（评测目标类型及名称）、`ocr_content` / `asr_content`（OCR/ASR 长文本，与别名 `ocr_text`/`asr_text` 对应）、`uid_name` 等列；字段说明面板按导入模板字段展示，故以 `fieldDefs` 为准。关联状态依据「数据管理」字段说明界面实际检测结果（截图）修正：`ocr_text`、`asr_text`、`dc_id`、`uid`、`ops_advertiser_name` 均为已关联，`agency_uid`、`agency_name` 为未关联。

---

## 二、AI分析表（策略_标签）

> 由 `real_data_tag_precision`（标签级）+ `real_data_tag_precision_samples`（样本级）组成，下面是标签级精度的字段说明。

| 字段名称 | 中文名 | 类型 | 必填 | 关联状态 | 说明 |
|----------|--------|------|------|----------|------|
| `tag_id` | 标签ID | INT | 是 | 已关联 | 策略标签ID |
| `policy_name` | 审核标签名/审核标签ID(翻译后) | VARCHAR | 否 | 已关联 | 策略标签名称（图表中标签ID括号内/下方显示的名称，别名 tag_name） |
| `total` | 样本总数 | INT | 是 | 已关联 | 该标签下的总样本数 |
| `fp` | 误杀数 | INT | 是 | 已关联 | 该标签下的误杀样本数 |
| `precision` | 精度(%) | DECIMAL | 否 | 未关联 | 精度值（百分比，如95.0表示95%），不填则从 total/fp 自动计算 |
| `review_model_precision_prime` | 绝对精度 | DECIMAL | 否 | 未关联 | 绝对模型精确度（绝对精度）：与模型精度并列的独立字段，部分数据集单独提供，表示不依赖相对口径的绝对精度值 |
| `tp` | TP | INT | 否 | 未关联 | 真阳性（True Positive）：预测为正且实际为正的数量 |
| `fp_conf` | FP | INT | 否 | 未关联 | 假阳性（False Positive）：预测为正但实际为负的数量 |
| `tn` | TN | INT | 否 | 未关联 | 真阴性（True Negative）：预测为负且实际为负的数量 |
| `fn` | FN | INT | 否 | 未关联 | 假阴性（False Negative）：预测为负但实际为正的数量 |
| `sample_count` | 明细样本数 | INT | 否 | 未关联 | 有明细数据的样本数量（可选） |
| `industry_l1` | AMS一级行业 | VARCHAR | 否 | 未关联 | AMS一级行业名称（开户行业） |
| `industry_l2` | AMS二级行业 | VARCHAR | 否 | 未关联 | AMS二级行业名称（开户行业） |
| `element_type` | 审核元素类型 | VARCHAR | 否 | 未关联 | 物料元素类型代码（image/video/text/audio等） |
| `element_type_name` | 元素类型名称 | VARCHAR | 是 | 已关联 | 物料元素类型中文名（图片/视频/文本/音频等） |
| `arrive_time` | 到达时间 | DATE | 否 | 未关联 | 物料到达时间（YYYY-MM-DD） |
| `ds` | 日期分区 | VARCHAR | 否 | 未关联 | 数据日期分区（YYYY-MM-DD） |
| `model_version` | 模型版本 | VARCHAR | 否 | 未关联 | 机审模型版本号 |
| `element_fingerprint` | 审核物理指纹（md5） | VARCHAR | 否 | 未关联 | 审核物理指纹（md5），用于物料去重 |
| `fp_reason` | 误杀原因 | VARCHAR | 否 | 未关联 | 误杀原因说明 |
| `remark` | 备注 | VARCHAR | 否 | 未关联 | 备注说明 |

---

## 三、聚类数据 `cluster_data`

> 取自 `server/src/db/schema.js` 真实建表语句。关联状态为运行时按数据动态检测，下表按列语义标注通用预期。

| 字段名称 | 中文名 | 类型 | 必填 | 关联状态 | 说明 |
|----------|--------|------|------|----------|------|
| `id` | 主键ID | INT | 是 | 已关联 | 自增主键 |
| `arrive_time` | 到达时间 | VARCHAR(32) | 是 | 已关联 | 物料到达时间（字符串日期） |
| `element_type` | 审核元素类型 | VARCHAR(32) | 是 | 已关联 | 物料元素类型代码（image/video/text等） |
| `policy_ids` | 审核标签ID | VARCHAR(255) | 是 | 未关联 | 机审命中策略标签ID列表 |
| `ai_evaluate_policy_ids` | AI评测人审标签 | VARCHAR(255) | 是 | 未关联 | 人审评测策略标签ID列表 |
| `element_value` | 审核元素值 | TEXT | 否 | 已关联 | 审核物料元素值（图片URL/视频URL/文本内容） |
| `element_fingerprint` | 审核物理指纹（md5） | VARCHAR(128) | 是 | 已关联 | 元素物理指纹（md5），用于物料去重与关联 |
| `class_id` | 聚类ID | VARCHAR(64) | 是 | 已关联 | 聚类簇ID（如c1表示聚类簇1，noise表示噪点） |
| `created_at` | 创建时间 | DATETIME | 是 | 已关联 | 记录创建时间（默认 CURRENT_TIMESTAMP） |

> 发布备份表 `publish_backup_cluster_data` 结构同上，额外含 `publish_version_id`（发布版本ID，INT，必填）。

---

## 四、结论沉淀库 `sediments`

> 取自 `server/src/db/schema.js` 真实建表语句。关联状态为运行时按数据动态检测，下表按列语义标注通用预期。

| 字段名称 | 中文名 | 类型 | 必填 | 关联状态 | 说明 |
|----------|--------|------|------|----------|------|
| `id` | 主键ID | INT | 是 | 已关联 | 自增主键 |
| `ticket_id` | 关联工单ID | VARCHAR(32) | 是 | 未关联 | 来源工单ID（非工单沉淀时为空） |
| `title` | 标题 | VARCHAR(255) | 是 | 已关联 | 沉淀结论标题 |
| `type` | 类型 | VARCHAR(64) | 是 | 未关联 | 沉淀类型 |
| `category` | 归因类别 | VARCHAR(32) | 是 | 未关联 | 归因问题分类 |
| `result_type` | 结果类型 | VARCHAR(16) | 是 | 已关联 | 结果类型（如 real_fp 真实误杀、machine_right 机器正确） |
| `tag_id` | 标签ID | INT | 是 | 未关联 | 关联策略标签ID |
| `tag_name` | 标签名称 | VARCHAR(128) | 是 | 未关联 | 关联策略标签名称 |
| `tags` | 标签 | VARCHAR(255) | 是 | 未关联 | 多标签（逗号分隔） |
| `industry` | 行业 | VARCHAR(64) | 是 | 未关联 | 行业名称 |
| `industry_l1` | 一级行业 | VARCHAR(64) | 是 | 未关联 | AMS一级行业名称 |
| `industry_l2` | 二级行业 | VARCHAR(64) | 是 | 未关联 | AMS二级行业名称 |
| `submitter` | 提交人 | VARCHAR(64) | 是 | 未关联 | 提交人 |
| `handler` | 处理人 | VARCHAR(64) | 是 | 未关联 | 处理人 |
| `adopted_at` | 采纳时间 | DATETIME | 否 | 未关联 | 结论采纳时间 |
| `samples` | 样本量 | INT | 是 | 未关联 | 关联样本数量 |
| `descr` | 描述 | TEXT | 否 | 未关联 | 沉淀描述 |
| `feature` | 特征 | TEXT | 否 | 未关联 | 素材特征说明 |
| `conclusion` | 结论 | TEXT | 否 | 已关联 | 归因结论正文 |
| `fp_reason` | 误杀原因 | TEXT | 否 | 未关联 | 误杀原因说明 |
| `related_materials` | 关联素材 | TEXT | 否 | 未关联 | 关联素材信息 |
| `handle_info` | 处理信息 | VARCHAR(512) | 是 | 未关联 | 处理建议/信息 |
| `dc_id` | 创意ID(DCID) | VARCHAR(64) | 是 | 未关联 | 创意ID |
| `ops_advertiser_name` | 客户主体名称(OPS) | VARCHAR(255) | 是 | 未关联 | 客户主体名称(OPS) |
| `element_fingerprint` | 审核物理指纹（md5） | VARCHAR(128) | 是 | 未关联 | 元素物理指纹（md5） |
| `ai_evaluate_reviewer_name` | 审核人 | VARCHAR(128) | 是 | 未关联 | 人审审核人员姓名 |
| `created_at` | 创建时间 | DATETIME | 是 | 已关联 | 记录创建时间（默认 CURRENT_TIMESTAMP） |

> 配套表 `sediment_updates`（结论更新记录）：`id`（INT，主键）、`sediment_id`（INT，关联沉淀ID）、`by_user`（VARCHAR(64)，操作人）、`reason`（VARCHAR(512)，修改原因）、`at`（DATETIME，操作时间）。
