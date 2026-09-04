// 建表 DDL —— SQLite 兼容版（从 MySQL 迁移）
// 转换规则：
//   INT AUTO_INCREMENT PRIMARY KEY → INTEGER PRIMARY KEY AUTOINCREMENT
//   BIGINT AUTO_INCREMENT PRIMARY KEY → INTEGER PRIMARY KEY AUTOINCREMENT
//   VARCHAR(N) → TEXT
//   MEDIUMTEXT / LONGTEXT → TEXT
//   TINYINT(1) → INTEGER
//   DECIMAL(M,N) → REAL
//   DATETIME → TEXT
//   DATE → TEXT
//   JSON → TEXT
//   ENUM(...) → TEXT
//   ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 → 去除
//   COLLATE=... → 去除
//   COMMENT '...' → 去除
//   ON UPDATE CURRENT_TIMESTAMP → 去除（应用层处理）
//   前缀索引 (767) → 普通索引
//   UNIQUE KEY name (cols) → CREATE UNIQUE INDEX 单独语句

export const SCHEMA = [
  // 用户表
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eng TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    team TEXT NOT NULL DEFAULT '',
    roles TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    knot_token TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,

  // 权限申请/审批
  `CREATE TABLE IF NOT EXISTS permission_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eng TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    team TEXT NOT NULL DEFAULT '',
    apply_roles TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    operator TEXT NOT NULL DEFAULT '',
    operated_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,

  // 工单
  `CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    tag TEXT NOT NULL DEFAULT '',
    tag_id INTEGER NOT NULL DEFAULT 0,
    element_type TEXT NOT NULL DEFAULT '',
    first_level_industry_name TEXT NOT NULL DEFAULT '',
    second_level_industry_name TEXT NOT NULL DEFAULT '',
    urgency INTEGER NOT NULL DEFAULT 2,
    status TEXT NOT NULL DEFAULT 'submitted',
    submitter TEXT NOT NULL DEFAULT '',
    handler TEXT NOT NULL DEFAULT '',
    sample_count INTEGER NOT NULL DEFAULT 0,
    descr TEXT,
    conclusion TEXT,
    conclusion_images TEXT,
    handle_reason TEXT NOT NULL DEFAULT '',
    need_tag INTEGER NOT NULL DEFAULT 0,
    is_qualified INTEGER NULL,
    handle_remark TEXT,
    category TEXT NOT NULL DEFAULT '',
    category_note TEXT NOT NULL DEFAULT '',
    result_type TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    samples_data TEXT,
    notify_users TEXT NOT NULL DEFAULT '',
    dc_id TEXT NOT NULL DEFAULT '',
    ops_advertiser_name TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT '',
    cc_users TEXT NOT NULL DEFAULT '',
    parent_ticket_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,

  // 工单草稿
  `CREATE TABLE IF NOT EXISTS ticket_drafts (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL DEFAULT '',
    payload TEXT,
    step INTEGER NOT NULL DEFAULT 1,
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ticket_drafts_owner ON ticket_drafts(owner)`,

  // 工单时间线
  `CREATE TABLE IF NOT EXISTS ticket_timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    action TEXT NOT NULL,
    op TEXT NOT NULL DEFAULT '',
    t TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ticket_timeline_ticket ON ticket_timeline(ticket_id)`,

  // 结论沉淀
  `CREATE TABLE IF NOT EXISTS sediments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    result_type TEXT NOT NULL DEFAULT 'real_fp',
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT '',
    industry_l1 TEXT NOT NULL DEFAULT '',
    industry_l2 TEXT NOT NULL DEFAULT '',
    submitter TEXT NOT NULL DEFAULT '',
    handler TEXT NOT NULL DEFAULT '',
    adopted_at TEXT NULL,
    samples INTEGER NOT NULL DEFAULT 0,
    descr TEXT,
    feature TEXT,
    conclusion TEXT,
    fp_reason TEXT,
    related_materials TEXT,
    handle_info TEXT NOT NULL DEFAULT '',
    dc_id TEXT NOT NULL DEFAULT '',
    ops_advertiser_name TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT '',
    cc_users TEXT NOT NULL DEFAULT '',
    parent_ticket_id TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sediments_ticket ON sediments(ticket_id)`,

  // 结论更新记录
  `CREATE TABLE IF NOT EXISTS sediment_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sediment_id INTEGER NOT NULL,
    by_user TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sediment_updates_sed ON sediment_updates(sediment_id)`,

  // 意见反馈
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL DEFAULT '',
    eng TEXT NOT NULL DEFAULT '',
    team TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT '',
    content TEXT,
    shots INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    reply TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,

  // 审计日志
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    t TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,

  // 数据元信息
  `CREATE TABLE IF NOT EXISTS data_meta (
    "key" TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_by TEXT NOT NULL DEFAULT ''
  )`,

  // 正式数据：标签级聚合
  `CREATE TABLE IF NOT EXISTS real_data_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL DEFAULT 0,
    fp INTEGER NOT NULL DEFAULT 0,
    precision_val REAL NOT NULL DEFAULT 0,
    rank_no INTEGER NOT NULL DEFAULT 0,
    remark TEXT NOT NULL DEFAULT '',
    fp_reason TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_real_data_tags_tag ON real_data_tags(tag_id)`,

  // 正式数据：样本级明细
  `CREATE TABLE IF NOT EXISTS real_data_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    sample_id TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    dc_id TEXT NOT NULL DEFAULT '',
    element_type TEXT NOT NULL DEFAULT '',
    is_video INTEGER NOT NULL DEFAULT 0,
    policy_ids TEXT NOT NULL DEFAULT '',
    ai_evaluate_policy_ids TEXT NOT NULL DEFAULT '',
    first_level_industry_name TEXT NOT NULL DEFAULT '',
    second_level_industry_name TEXT NOT NULL DEFAULT '',
    media_url TEXT,
    ocr_content TEXT,
    asr_content TEXT,
    class_num INTEGER NOT NULL DEFAULT 0,
    class_id TEXT NOT NULL DEFAULT '',
    uid TEXT NOT NULL DEFAULT '',
    ops_advertiser_name TEXT NOT NULL DEFAULT '',
    ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT '',
    arrive_time TEXT NOT NULL DEFAULT '',
    ds TEXT NOT NULL DEFAULT '',
    is_fp INTEGER NOT NULL DEFAULT 0,
    -- 经人工复核「确认」为误杀的数量标记（fp_confirmed ⊆ is_fp）
    -- 用于绝对精度口径：绝对精度 = (total - fp_confirmed) / total
    fp_confirmed INTEGER NOT NULL DEFAULT 0,
    fp_reason TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_real_data_samples_tag ON real_data_samples(tag_id)`,
  `CREATE INDEX IF NOT EXISTS idx_real_data_samples_fp ON real_data_samples(element_fingerprint)`,

  // 数据导入历史记录
  `CREATE TABLE IF NOT EXISTS data_import_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL DEFAULT '',
    dataset_name TEXT NOT NULL DEFAULT 'AI评测明细数据',
    sample_count INTEGER NOT NULL DEFAULT 0,
    tag_count INTEGER NOT NULL DEFAULT 0,
    precision_val REAL NOT NULL DEFAULT 0,
    fp_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'success',
    error_message TEXT,
    imported_by TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_data_import_history_time ON data_import_history(imported_at)`,

  // AI评测明细表
  `CREATE TABLE IF NOT EXISTS ai_evaluate_detail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_target_type INTEGER NOT NULL DEFAULT 0,
    evaluation_target_type_name TEXT NOT NULL DEFAULT '',
    first_level_industry_name TEXT NOT NULL DEFAULT '',
    second_level_industry_name TEXT NOT NULL DEFAULT '',
    element_type TEXT NOT NULL DEFAULT '',
    element_type_name TEXT NOT NULL DEFAULT '',
    policy_ids TEXT NOT NULL DEFAULT '',
    ai_evaluate_policy_ids TEXT NOT NULL DEFAULT '',
    element_value TEXT,
    ocr_content TEXT,
    asr_content TEXT,
    class_num INTEGER NOT NULL DEFAULT 0,
    class_id TEXT NOT NULL DEFAULT '',
    dc_id TEXT NOT NULL DEFAULT '',
    uid TEXT NOT NULL DEFAULT '',
    uid_name TEXT NOT NULL DEFAULT '',
    ops_advertiser_name TEXT NOT NULL DEFAULT '',
    model_version TEXT NOT NULL DEFAULT '',
    ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    arrive_time TEXT NULL,
    ds TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluate_detail_policy ON ai_evaluate_detail(policy_ids)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluate_detail_etype ON ai_evaluate_detail(element_type)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluate_detail_ds ON ai_evaluate_detail(ds)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluate_detail_arrive ON ai_evaluate_detail(arrive_time)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_evaluate_detail_element_value ON ai_evaluate_detail(element_value)`,

  // 预聚合索引表
  `CREATE TABLE IF NOT EXISTS ai_evaluate_detail_url_idx (
    element_value_norm TEXT NOT NULL,
    element_value TEXT,
    element_fingerprint TEXT,
    policy_ids TEXT,
    ai_evaluate_policy_ids TEXT,
    dc_id TEXT,
    class_id TEXT,
    ops_advertiser_name TEXT,
    ai_evaluate_reviewer_name TEXT,
    uid TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uk_ai_eval_url_idx_norm ON ai_evaluate_detail_url_idx(element_value_norm)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_eval_url_idx_norm ON ai_evaluate_detail_url_idx(element_value_norm)`,

  // AI评测分析表（策略_标签）
  `CREATE TABLE IF NOT EXISTS real_data_tag_precision (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL DEFAULT 0,
    fp INTEGER NOT NULL DEFAULT 0,
    precision_val REAL NOT NULL DEFAULT 0,
    tp INTEGER NOT NULL DEFAULT 0,
    fp_conf INTEGER NOT NULL DEFAULT 0,
    tn INTEGER NOT NULL DEFAULT 0,
    fn INTEGER NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    first_level_industry_name TEXT NOT NULL DEFAULT '',
    second_level_industry_name TEXT NOT NULL DEFAULT '',
    element_type TEXT NOT NULL DEFAULT '',
    element_type_name TEXT NOT NULL DEFAULT '',
    arrive_time TEXT DEFAULT NULL,
    ds TEXT NOT NULL DEFAULT '',
    model_version TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT '',
    fp_reason TEXT NOT NULL DEFAULT '',
    review_model_precision_prime REAL NULL DEFAULT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_real_data_tag_precision_tag ON real_data_tag_precision(tag_id)`,

  // AI评测分析表样本
  `CREATE TABLE IF NOT EXISTS real_data_tag_precision_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    sample_id TEXT NOT NULL DEFAULT '',
    element_type TEXT NOT NULL DEFAULT '',
    is_video INTEGER NOT NULL DEFAULT 0,
    policy_ids TEXT NOT NULL DEFAULT '',
    ai_evaluate_policy_ids TEXT NOT NULL DEFAULT '',
    first_level_industry_name TEXT NOT NULL DEFAULT '',
    second_level_industry_name TEXT NOT NULL DEFAULT '',
    media_url TEXT,
    ocr_content TEXT,
    asr_content TEXT,
    uid TEXT NOT NULL DEFAULT '',
    arrive_time TEXT NOT NULL DEFAULT '',
    ds TEXT NOT NULL DEFAULT '',
    is_fp INTEGER NOT NULL DEFAULT 0,
    fp_reason TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT '',
    class_num INTEGER NOT NULL DEFAULT 0,
    class_id TEXT NOT NULL DEFAULT '',
    dc_id TEXT NOT NULL DEFAULT '',
    ops_advertiser_name TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_real_data_tag_precision_samples_tag ON real_data_tag_precision_samples(tag_id)`,

  // 素材预分类：归因分类
  `CREATE TABLE IF NOT EXISTS material_category (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    feature TEXT NOT NULL DEFAULT '',
    feature_brief TEXT,
    feature_detail TEXT,
    sample_snapshot TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    owner TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_material_category_tag ON material_category(tag_id)`,

  // 素材预分类：素材↔分类归属
  `CREATE TABLE IF NOT EXISTS material_category_relation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    sample_id TEXT NOT NULL DEFAULT '',
    media_url TEXT,
    category_id INTEGER NOT NULL DEFAULT 0,
    feature_desc TEXT,
    supplement TEXT,
    owner TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uk_mcr_tag_sample ON material_category_relation(tag_id, sample_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mcr_cat ON material_category_relation(category_id)`,

  // 素材预分类：分类结论
  `CREATE TABLE IF NOT EXISTS material_conclusion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    content TEXT,
    summary TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_material_conclusion_tag ON material_conclusion(tag_id)`,

  // 素材标注历史
  `CREATE TABLE IF NOT EXISTS material_annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    sample_id TEXT NOT NULL DEFAULT '',
    media_url TEXT,
    content TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_material_annotations_tag_sample ON material_annotations(tag_id, sample_id)`,

  // 素材特征分类：上传数据存储
  `CREATE TABLE IF NOT EXISTS uploaded_classify_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    sample_id TEXT NOT NULL DEFAULT '',
    element_type TEXT NOT NULL DEFAULT '',
    element_type_name TEXT NOT NULL DEFAULT '',
    is_video INTEGER NOT NULL DEFAULT 0,
    policy_ids TEXT NOT NULL DEFAULT '',
    ai_evaluate_policy_ids TEXT NOT NULL DEFAULT '',
    first_level_industry_name TEXT NOT NULL DEFAULT '',
    second_level_industry_name TEXT NOT NULL DEFAULT '',
    media_url TEXT,
    ocr_content TEXT,
    asr_content TEXT,
    class_num INTEGER NOT NULL DEFAULT 0,
    class_id TEXT NOT NULL DEFAULT '',
    uid TEXT NOT NULL DEFAULT '',
    arrive_time TEXT NOT NULL DEFAULT '',
    ds TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    dc_id TEXT NOT NULL DEFAULT '',
    ops_advertiser_name TEXT NOT NULL DEFAULT '',
    ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT '',
    is_fp INTEGER NOT NULL DEFAULT 1,
    batch_id INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT NOT NULL DEFAULT '',
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_uploaded_classify_data_tag ON uploaded_classify_data(tag_id)`,
  `CREATE INDEX IF NOT EXISTS idx_uploaded_classify_data_batch ON uploaded_classify_data(batch_id)`,
  `CREATE INDEX IF NOT EXISTS idx_uploaded_classify_data_sample_id ON uploaded_classify_data(sample_id)`,

  // 素材特征分类：上传历史记录
  `CREATE TABLE IF NOT EXISTS uploaded_classify_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    sample_count INTEGER NOT NULL DEFAULT 0,
    class_count INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT NOT NULL DEFAULT '',
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_uploaded_classify_history_tag ON uploaded_classify_history(tag_id)`,
  `CREATE INDEX IF NOT EXISTS idx_uploaded_classify_history_time ON uploaded_classify_history(uploaded_at)`,

  // TRAG 检索缓存
  `CREATE TABLE IF NOT EXISTS trag_cache (
    cache_key TEXT PRIMARY KEY,
    task TEXT NOT NULL DEFAULT '',
    query_text TEXT,
    results TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,

  // 发布版本记录
  `CREATE TABLE IF NOT EXISTS publish_version (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    operator TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    source TEXT NOT NULL DEFAULT 'draft',
    note TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_publish_version_version ON publish_version(version)`,
  `CREATE INDEX IF NOT EXISTS idx_publish_version_time ON publish_version(published_at)`,

  // 发布前备份表：real_data_tags
  `CREATE TABLE IF NOT EXISTS publish_backup_real_data_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publish_version_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL DEFAULT 0,
    fp INTEGER NOT NULL DEFAULT 0,
    precision_val REAL NOT NULL DEFAULT 0,
    rank_no INTEGER NOT NULL DEFAULT 0,
    remark TEXT NOT NULL DEFAULT '',
    fp_reason TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pb_rdt_version ON publish_backup_real_data_tags(publish_version_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pb_rdt_tag ON publish_backup_real_data_tags(tag_id)`,

  // 发布前备份表：real_data_samples
  `CREATE TABLE IF NOT EXISTS publish_backup_real_data_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publish_version_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    sample_id TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    dc_id TEXT NOT NULL DEFAULT '',
    element_type TEXT NOT NULL DEFAULT '',
    is_video INTEGER NOT NULL DEFAULT 0,
    policy_ids TEXT NOT NULL DEFAULT '',
    ai_evaluate_policy_ids TEXT NOT NULL DEFAULT '',
    first_level_industry_name TEXT NOT NULL DEFAULT '',
    second_level_industry_name TEXT NOT NULL DEFAULT '',
    media_url TEXT,
    ocr_content TEXT,
    asr_content TEXT,
    class_num INTEGER NOT NULL DEFAULT 0,
    class_id TEXT NOT NULL DEFAULT '',
    uid TEXT NOT NULL DEFAULT '',
    ops_advertiser_name TEXT NOT NULL DEFAULT '',
    ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT '',
    arrive_time TEXT NOT NULL DEFAULT '',
    ds TEXT NOT NULL DEFAULT '',
    is_fp INTEGER NOT NULL DEFAULT 0,
    fp_reason TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pb_rds_version ON publish_backup_real_data_samples(publish_version_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pb_rds_tag ON publish_backup_real_data_samples(tag_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pb_rds_fp ON publish_backup_real_data_samples(element_fingerprint)`,

  // 发布前备份表：real_data_tag_precision
  `CREATE TABLE IF NOT EXISTS publish_backup_real_data_tag_precision (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publish_version_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL DEFAULT 0,
    fp INTEGER NOT NULL DEFAULT 0,
    precision_val REAL NOT NULL DEFAULT 0,
    tp INTEGER NOT NULL DEFAULT 0,
    fp_conf INTEGER NOT NULL DEFAULT 0,
    tn INTEGER NOT NULL DEFAULT 0,
    fn INTEGER NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    first_level_industry_name TEXT NOT NULL DEFAULT '',
    second_level_industry_name TEXT NOT NULL DEFAULT '',
    element_type TEXT NOT NULL DEFAULT '',
    element_type_name TEXT NOT NULL DEFAULT '',
    arrive_time TEXT DEFAULT NULL,
    ds TEXT NOT NULL DEFAULT '',
    model_version TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT '',
    fp_reason TEXT NOT NULL DEFAULT '',
    review_model_precision_prime REAL NULL DEFAULT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pb_rdtp_version ON publish_backup_real_data_tag_precision(publish_version_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pb_rdtp_tag ON publish_backup_real_data_tag_precision(tag_id)`,

  // 发布前备份表：real_data_tag_precision_samples
  `CREATE TABLE IF NOT EXISTS publish_backup_real_data_tag_precision_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publish_version_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL DEFAULT 0,
    tag_name TEXT NOT NULL DEFAULT '',
    sample_id TEXT NOT NULL DEFAULT '',
    element_type TEXT NOT NULL DEFAULT '',
    is_video INTEGER NOT NULL DEFAULT 0,
    policy_ids TEXT NOT NULL DEFAULT '',
    ai_evaluate_policy_ids TEXT NOT NULL DEFAULT '',
    first_level_industry_name TEXT NOT NULL DEFAULT '',
    second_level_industry_name TEXT NOT NULL DEFAULT '',
    media_url TEXT,
    ocr_content TEXT,
    asr_content TEXT,
    uid TEXT NOT NULL DEFAULT '',
    arrive_time TEXT NOT NULL DEFAULT '',
    ds TEXT NOT NULL DEFAULT '',
    is_fp INTEGER NOT NULL DEFAULT 0,
    fp_reason TEXT NOT NULL DEFAULT '',
    remark TEXT NOT NULL DEFAULT '',
    class_num INTEGER NOT NULL DEFAULT 0,
    class_id TEXT NOT NULL DEFAULT '',
    reviewer_name TEXT NOT NULL DEFAULT '',
    dc_id TEXT NOT NULL DEFAULT '',
    ops_advertiser_name TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pb_rdtps_version ON publish_backup_real_data_tag_precision_samples(publish_version_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pb_rdtps_tag ON publish_backup_real_data_tag_precision_samples(tag_id)`,

  // 聚类数据
  `CREATE TABLE IF NOT EXISTS cluster_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    arrive_time TEXT NOT NULL DEFAULT '',
    element_type TEXT NOT NULL DEFAULT '',
    policy_ids TEXT NOT NULL DEFAULT '',
    ai_evaluate_policy_ids TEXT NOT NULL DEFAULT '',
    element_value TEXT,
    element_fingerprint TEXT NOT NULL DEFAULT '',
    class_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_data_fp ON cluster_data(element_fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_cluster_data_ev ON cluster_data(element_value)`,

  // 聚类数据发布备份表
  `CREATE TABLE IF NOT EXISTS publish_backup_cluster_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publish_version_id INTEGER NOT NULL,
    arrive_time TEXT NOT NULL DEFAULT '',
    element_type TEXT NOT NULL DEFAULT '',
    policy_ids TEXT NOT NULL DEFAULT '',
    ai_evaluate_policy_ids TEXT NOT NULL DEFAULT '',
    element_value TEXT,
    element_fingerprint TEXT NOT NULL DEFAULT '',
    class_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pb_cd_version ON publish_backup_cluster_data(publish_version_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pb_cd_fp ON publish_backup_cluster_data(element_fingerprint)`,

  // 用户 UI 状态
  `CREATE TABLE IF NOT EXISTS ui_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    eng TEXT NOT NULL,
    "key" TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uk_ui_state_user_key ON ui_state(eng, "key")`,
  `CREATE INDEX IF NOT EXISTS idx_ui_state_eng ON ui_state(eng)`,

  // 素材特征分类「分享快照」
  `CREATE TABLE IF NOT EXISTS classify_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL DEFAULT '',
    tag_id TEXT NULL,
    tag_name TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    expire_days INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_classify_shares_share_id ON classify_shares(share_id)`,
  `CREATE INDEX IF NOT EXISTS idx_classify_shares_owner ON classify_shares(owner)`,
  `CREATE INDEX IF NOT EXISTS idx_classify_shares_created ON classify_shares(created_at)`,

  // 样本库精标数据
  `CREATE TABLE IF NOT EXISTS sample_library_fine_label (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cluster_id TEXT NOT NULL,
    element_value TEXT NOT NULL,
    element_fingerprint TEXT,
    element_type TEXT,
    fine_labels TEXT NOT NULL,
    first_level_industry_name TEXT,
    second_level_industry_name TEXT,
    uploader_id TEXT,
    uploaded_at TEXT DEFAULT (datetime('now','localtime')),
    ds TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_slfl_cluster ON sample_library_fine_label(cluster_id)`,
  `CREATE INDEX IF NOT EXISTS idx_slfl_ds ON sample_library_fine_label(ds)`,
  `CREATE INDEX IF NOT EXISTS idx_slfl_fp ON sample_library_fine_label(element_fingerprint)`,

  // 工单相似样本库
  `CREATE TABLE IF NOT EXISTS ticket_similar_library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    seed_fingerprint TEXT NOT NULL DEFAULT '',
    seed_media_url TEXT,
    task_type TEXT NOT NULL DEFAULT '',
    element_fingerprint TEXT NOT NULL DEFAULT '',
    element_value TEXT,
    element_type TEXT NOT NULL DEFAULT '',
    score REAL NOT NULL DEFAULT 0,
    ocr_content TEXT,
    asr_content TEXT,
    dc_id TEXT NOT NULL DEFAULT '',
    ops_advertiser_name TEXT NOT NULL DEFAULT '',
    policy_ids TEXT,
    ai_evaluate_policy_ids TEXT,
    selected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tsl_ticket ON ticket_similar_library(ticket_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tsl_fp ON ticket_similar_library(element_fingerprint)`,

  // 聚类簇特征总结
  `CREATE TABLE IF NOT EXISTS cluster_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL DEFAULT 0,
    class_id TEXT NOT NULL,
    feature_summary TEXT,
    owner TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uk_cf_tag_class ON cluster_features(tag_id, class_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cf_tag ON cluster_features(tag_id)`,

  // 上传去重归档指纹表
  `CREATE TABLE IF NOT EXISTS uploaded_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset TEXT NOT NULL,
    sample_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uk_ua_dataset_key ON uploaded_archive(dataset, sample_key)`,
  `CREATE INDEX IF NOT EXISTS idx_ua_dataset ON uploaded_archive(dataset)`,
]
